import test from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { reduceLedger } from "../src/task-ledger.js";
import path from "node:path";
import {
  assessAcceptance,
  assessContinuationCapability,
  createTaskLedger,
  deriveStatusView,
  renderStatusMarkdown,
} from "../src/index.js";

const TOOLS = ["sessions_spawn", "sessions_yield", "subagents", "dashboard"];
const MODEL = "anthropic/claude-sonnet-5-5";
const task = (id, extra = {}) => ({
  id,
  goal: `goal ${id}`,
  successCriteria: [`criterion ${id}`],
  requestedModel: MODEL,
  timeoutMs: 600_000,
  ...extra,
});
const receipt = (n, extra = {}) => ({
  evidenceSource: "standard-spawn",
  runId: `run-${n}`,
  childSessionKey: `agent:main:subagent:${n}`,
  resolvedModel: "claude-sonnet-5-5",
  resolvedProvider: "anthropic",
  ...extra,
});

function fresh(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "oa2-ledger-"));
  const file = path.join(dir, "ledger.jsonl");
  const ledger = createTaskLedger({ file, owners: ["sebastian"], ...options });
  ledger.declarePlan({
    planId: "p1",
    tasks: [
      task("T1", { role: "implement" }),
      task("T2", { role: "verify", dependencies: ["T1"] }),
      task("T3", { role: "review", dependencies: ["T2"] }),
      task("G1", { kind: "gate", requestedModel: undefined, dependencies: ["T3"] }),
    ],
  });
  ledger.recordCapability({ tools: TOOLS, publisherTool: "dashboard" });
  return { dir, file, ledger };
}

function throwsCode(fn, code) {
  assert.throws(fn, (e) => e.name === "LedgerError" && e.code === code, `expected ${code}`);
}

function runToDone(ledger, id, n, prev) {
  ledger.reserveDispatch(
    id,
    prev
      ? { trigger: { type: "completion", childSessionKey: `agent:main:subagent:${prev}` } }
      : undefined,
  );
  ledger.recordReceipt(id, receipt(n));
  ledger.recordCompletion({ childSessionKey: `agent:main:subagent:${n}`, outcome: "ok" });
  ledger.recordVerification(id, {
    verifier: "verifier-1",
    verdict: "pass",
    evidenceRefs: [`ev-${id}`],
  });
  ledger.recordDashboardSync(id, `dash-${id}`);
}

test("plan validation rejects cycles, unknown dependencies and unobservable tasks", () => {
  const ledger = createTaskLedger({
    file: path.join(mkdtempSync(path.join(tmpdir(), "oa2-")), "l.jsonl"),
  });
  throwsCode(
    () =>
      ledger.declarePlan({
        planId: "x",
        tasks: [task("A", { dependencies: ["B"] }), task("B", { dependencies: ["A"] })],
      }),
    "invalid-plan",
  );
  throwsCode(
    () => ledger.declarePlan({ planId: "x", tasks: [task("A", { dependencies: ["Z"] })] }),
    "invalid-plan",
  );
  throwsCode(
    () => ledger.declarePlan({ planId: "x", tasks: [{ ...task("A"), successCriteria: [] }] }),
    "invalid-plan",
  );
  throwsCode(
    () => ledger.declarePlan({ planId: "x", tasks: [{ ...task("A"), timeoutMs: undefined }] }),
    "invalid-plan",
  );
  throwsCode(
    () => ledger.declarePlan({ planId: "x", tasks: [{ ...task("A"), requestedModel: undefined }] }),
    "invalid-plan",
  );
  throwsCode(
    () => ledger.declarePlan({ planId: "x", tasks: [task("A"), task("A")] }),
    "invalid-plan",
  );
  throwsCode(
    () => ledger.declarePlan({ planId: "x", tasks: [task("A", { dependencies: ["A"] })] }),
    "invalid-plan",
  );
});

test("dependency DAG is visible: waiting, ready, gated and blocked-upstream", () => {
  const { ledger } = fresh();
  let view = ledger.view();
  const by = (id) => view.tasks.find((t) => t.id === id);
  assert.equal(by("T1").status, "ready");
  assert.equal(by("T2").status, "waiting");
  assert.deepEqual(by("T2").waitingOn, ["T1"]);
  assert.deepEqual(view.edges, [
    ["T1", "T2"],
    ["T2", "T3"],
    ["T3", "G1"],
  ]);
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({
    childSessionKey: "agent:main:subagent:1",
    outcome: "error",
    reason: "boom",
  });
  view = ledger.view();
  assert.equal(by("T1").status, "blocked");
  assert.equal(by("T2").status, "blocked-upstream");
  assert.match(by("T2").nextAction, /resolve blocker on T1/);
  assert.match(renderStatusMarkdown(view), /\| T2 \| blocked-upstream \| T1 \| - \|/);
});

test("dependent dispatch is refused until dependencies are done, not merely completed", () => {
  const { ledger } = fresh();
  throwsCode(() => ledger.reserveDispatch("T2"), "dependency-unmet");
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  throwsCode(() => ledger.reserveDispatch("T2"), "dependency-unmet");
  ledger.recordVerification("T1", { verifier: "verifier-1", verdict: "pass", evidenceRefs: ["e"] });
  throwsCode(() => ledger.reserveDispatch("T2"), "dependency-unmet");
  ledger.recordDashboardSync("T1", "dash");
  assert.equal(ledger.reserveDispatch("T2"), 1);
});

test("dispatch needs evidenced spawn capability and never infers it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oa2-"));
  const ledger = createTaskLedger({ file: path.join(dir, "l.jsonl") });
  ledger.declarePlan({ planId: "p", tasks: [task("A")] });
  throwsCode(() => ledger.reserveDispatch("A"), "capability-missing");
  ledger.recordCapability({ tools: ["sessions_spawn"], publisherTool: "dashboard" });
  throwsCode(() => ledger.reserveDispatch("A"), "capability-missing");
  assert.deepEqual(
    assessContinuationCapability({ tools: ["sessions_spawn", "sessions_yield", "subagents"] }),
    {
      canDispatch: true,
      canPublish: false,
      publisherTool: null,
      missing: ["publisher"],
    },
  );
  assert.equal(assessContinuationCapability().canDispatch, false);
});

test("a missing publisher blocks completion and dependents without bypass", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oa2-"));
  const ledger = createTaskLedger({ file: path.join(dir, "l.jsonl") });
  ledger.declarePlan({ planId: "p", tasks: [task("A"), task("B", { dependencies: ["A"] })] });
  ledger.recordCapability({ tools: ["sessions_spawn", "sessions_yield", "subagents"] });
  ledger.reserveDispatch("A");
  ledger.recordReceipt("A", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  ledger.recordVerification("A", { verifier: "verifier-1", verdict: "pass", evidenceRefs: ["e"] });
  throwsCode(() => ledger.recordDashboardSync("A", "claimed"), "publisher-unavailable");
  assert.equal(ledger.state().tasks.get("A").status, "verified");
  throwsCode(() => ledger.reserveDispatch("B"), "dependency-unmet");
  ledger.recordPublisherFailure("A", "no dashboard tool");
  assert.equal(ledger.state().tasks.get("A").blocker.code, "publisher-unavailable");
  throwsCode(
    () =>
      ledger.resolveBlocker("A", {
        reason: "x",
        authorizedBy: "coordinator",
        sideEffectsChecked: true,
      }),
    "invalid-resolution",
  );
});

test("duplicate dispatch is refused for reserved, running and review-ready attempts", () => {
  const { ledger } = fresh();
  assert.equal(ledger.reserveDispatch("T1"), 1);
  throwsCode(() => ledger.reserveDispatch("T1"), "duplicate-dispatch");
  ledger.recordReceipt("T1", receipt(1));
  throwsCode(() => ledger.reserveDispatch("T1"), "duplicate-dispatch");
  throwsCode(() => ledger.recordReceipt("T1", receipt(9)), "duplicate-receipt");
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  throwsCode(() => ledger.reserveDispatch("T1"), "duplicate-dispatch");
});

test("receipt gate: incomplete, mismatched and unavailable-exact-model attempts block with evidence", () => {
  for (const [input, code] of [
    [receipt(1, { runId: undefined }), "receipt-incomplete"],
    [receipt(1, { resolvedModel: "claude-opus-5-5" }), "model-mismatch"],
    [{ ...receipt(1), unavailable: "exact route not callable" }, "model-unavailable"],
  ]) {
    const { ledger } = fresh();
    ledger.reserveDispatch("T1");
    ledger.recordReceipt("T1", input);
    const t = ledger.state().tasks.get("T1");
    assert.equal(t.blocker.code, code);
    assert.equal(t.blocker.evidenceSource, "standard-spawn");
    assert.equal(ledger.view().tasks[0].status, "blocked");
    throwsCode(() => ledger.reserveDispatch("T1"), "duplicate-dispatch");
  }
});

test("receipt records requested vs actual model and keeps unconfirmed applied timeout", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  const r = ledger.state().tasks.get("T1").attempts[0].receipt;
  assert.equal(r.requestedModel, MODEL);
  assert.equal(r.resolvedModel, "claude-sonnet-5-5");
  assert.equal(r.appliedTimeout, "unconfirmed");
  assert.equal(r.requestedTimeoutMs, 600_000);
  assert.equal(ledger.view().tasks[0].actualModel, "claude-sonnet-5-5");
});

test("queued delivery is visible but does not prove completion", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordQueued("T1");
  assert.equal(ledger.state().tasks.get("T1").status, "running");
  assert.equal(ledger.state().tasks.get("T1").attempts[0].queued, true);
  assert.match(ledger.view().tasks[0].nextAction, /queued delivery as completion/);
});

test("completion identity comes from the trusted session key: unmatched and duplicate are recorded, not applied", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  throwsCode(
    () => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:forged", outcome: "ok" }),
    "unmatched-completion",
  );
  assert.equal(ledger.state().tasks.get("T1").status, "running");
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  throwsCode(
    () => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "error" }),
    "duplicate-completion",
  );
  assert.equal(ledger.state().tasks.get("T1").status, "review-ready");
  assert.deepEqual(
    ledger.state().notes.map((n) => n.type),
    ["completion_unmatched", "completion_duplicate"],
  );
  throwsCode(
    () => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "weird" }),
    "duplicate-completion",
  );
});

test("worker error, timeout and interruption block the task and never advance dependents", () => {
  for (const [outcome, code] of [
    ["error", "worker-error"],
    ["timeout", "timeout"],
    ["aborted", "interrupted"],
  ]) {
    const { ledger } = fresh();
    ledger.reserveDispatch("T1");
    ledger.recordReceipt("T1", receipt(1));
    ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome, reason: outcome });
    assert.equal(ledger.state().tasks.get("T1").blocker.code, code);
    assert.equal(ledger.state().tasks.get("T1").verified, false);
    throwsCode(() => ledger.reserveDispatch("T2"), "dependency-unmet");
    throwsCode(
      () =>
        ledger.recordVerification("T1", {
          verifier: "verifier-1",
          verdict: "pass",
          evidenceRefs: ["e"],
        }),
      "invalid-transition",
    );
  }
});

test("unknown completion outcome is rejected without state change", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  throwsCode(
    () => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "weird" }),
    "invalid-completion",
  );
  assert.equal(ledger.state().tasks.get("T1").status, "running");
});

test("rejected review blocks with findings; a pass needs evidence refs", () => {
  const { ledger } = fresh();
  runToDone(ledger, "T1", 1);
  ledger.reserveDispatch("T2");
  ledger.recordReceipt("T2", receipt(2));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:2", outcome: "ok" });
  throwsCode(
    () =>
      ledger.recordVerification("T2", {
        verifier: "verifier-1",
        verdict: "pass",
        evidenceRefs: [],
      }),
    "invalid-verification",
  );
  throwsCode(
    () => ledger.recordVerification("T2", { verifier: "verifier-1", verdict: "reject" }),
    "invalid-verification",
  );
  throwsCode(
    () => ledger.recordVerification("T2", { verifier: "verifier-1", verdict: "maybe" }),
    "invalid-verification",
  );
  ledger.recordVerification("T2", {
    verifier: "verifier-1",
    verdict: "reject",
    findings: "criterion 2 not met",
  });
  const t = ledger.state().tasks.get("T2");
  assert.equal(t.blocker.code, "review-rejected");
  assert.equal(t.blocker.reason, "criterion 2 not met");
  throwsCode(() => ledger.recordDashboardSync("T2", "x"), "invalid-transition");
  throwsCode(() => ledger.reserveDispatch("T3"), "dependency-unmet");
});

test("dashboard checkpoint cannot be skipped: done only via verified plus confirmed sync", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  throwsCode(() => ledger.recordDashboardSync("T1", "x"), "invalid-transition");
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  throwsCode(() => ledger.recordDashboardSync("T1", "x"), "invalid-transition");
  ledger.recordVerification("T1", { verifier: "verifier-1", verdict: "pass", evidenceRefs: ["e"] });
  assert.equal(ledger.state().tasks.get("T1").status, "verified");
  throwsCode(() => ledger.recordDashboardSync("T1", " "), "invalid-checkpoint");
  ledger.recordDashboardSync("T1", "dash-1");
  assert.equal(ledger.state().tasks.get("T1").status, "done");
  assert.equal(ledger.view().tasks[0].dashboardRef, "dash-1");
});

test("retry needs an explicit resolved blocker, side-effect check, and is bounded", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "timeout" });
  throwsCode(() => ledger.reserveDispatch("T1"), "duplicate-dispatch");
  throwsCode(
    () => ledger.resolveBlocker("T1", { reason: "r", authorizedBy: "coordinator" }),
    "invalid-resolution",
  );
  throwsCode(
    () =>
      ledger.resolveBlocker("T1", {
        reason: "",
        authorizedBy: "coordinator",
        sideEffectsChecked: true,
      }),
    "invalid-resolution",
  );
  throwsCode(
    () => ledger.resolveBlocker("T2", { reason: "r", authorizedBy: "c", sideEffectsChecked: true }),
    "invalid-transition",
  );
  ledger.resolveBlocker("T1", {
    reason: "worktree inspected, no partial writes",
    authorizedBy: "coordinator",
    sideEffectsChecked: true,
  });
  assert.equal(ledger.view().tasks[0].status, "ready");
  assert.equal(ledger.reserveDispatch("T1"), 2);
  ledger.recordReceipt("T1", receipt(2));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:2", outcome: "error" });
  ledger.resolveBlocker("T1", {
    reason: "again",
    authorizedBy: "coordinator",
    sideEffectsChecked: true,
  });
  throwsCode(() => ledger.reserveDispatch("T1"), "attempts-exhausted");
});

test("owner gate stops at human review; approval is scoped to that gate and not dispatchable", () => {
  const { ledger } = fresh();
  throwsCode(() => ledger.reserveDispatch("G1"), "not-dispatchable");
  throwsCode(
    () => ledger.approveGate("G1", { approvedBy: "sebastian", ref: "pr#1" }),
    "dependency-unmet",
  );
  runToDone(ledger, "T1", 1);
  runToDone(ledger, "T2", 2);
  runToDone(ledger, "T3", 3);
  assert.equal(ledger.view().tasks.find((t) => t.id === "G1").status, "gated");
  throwsCode(() => ledger.approveGate("G1", { approvedBy: "", ref: "x" }), "not-owner");
  ledger.approveGate("G1", { approvedBy: "sebastian", ref: "pr#1" });
  throwsCode(
    () => ledger.approveGate("G1", { approvedBy: "sebastian", ref: "pr#1" }),
    "invalid-transition",
  );
  assert.equal(ledger.state().tasks.get("G1").approvedBy, "sebastian");
});

test("rejected gate blocks and defer needs an owner decision reference", () => {
  const { ledger } = fresh();
  throwsCode(
    () => ledger.deferTask("T1", { approvedBy: "sebastian", ownerDecision: "" }),
    "invalid-deferral",
  );
  ledger.deferTask("T1", { approvedBy: "sebastian", ownerDecision: "owner decision 2026-11-13" });
  assert.equal(ledger.state().tasks.get("T1").status, "deferred");
  throwsCode(() => ledger.reserveDispatch("T1"), "duplicate-dispatch");
  const g = fresh();
  runToDone(g.ledger, "T1", 1);
  runToDone(g.ledger, "T2", 2);
  runToDone(g.ledger, "T3", 3);
  g.ledger.rejectGate("G1", "changes requested", { rejectedBy: "sebastian" });
  assert.equal(g.ledger.state().tasks.get("G1").blocker.code, "gate-rejected");
  throwsCode(
    () => g.ledger.rejectGate("T1", "x", { rejectedBy: "sebastian" }),
    "invalid-transition",
  );
});

test("addTask extends the DAG with a fix task and re-review, still rejecting cycles", () => {
  const { ledger } = fresh();
  ledger.addTask(task("T3fix", { dependencies: ["T2"] }));
  ledger.addTask(task("T3b", { role: "review", dependencies: ["T3fix"] }));
  throwsCode(() => ledger.addTask(task("T3b")), "invalid-plan");
  throwsCode(() => ledger.addTask(task("bad", { dependencies: ["nope"] })), "invalid-plan");
  throwsCode(() => ledger.declarePlan({ planId: "p2", tasks: [task("X")] }), "plan-exists");
  assert.equal(ledger.view().tasks.length, 6);
});

test("durable recovery: a new ledger instance resumes verified work and in-flight tasks", () => {
  const { file, ledger } = fresh();
  runToDone(ledger, "T1", 1);
  ledger.reserveDispatch("T2");
  ledger.recordReceipt("T2", receipt(2));
  const resumed = createTaskLedger({ file });
  const { flagged, state } = resumed.recover();
  assert.deepEqual(flagged, [
    { taskId: "T2", action: "await-completion", childSessionKey: "agent:main:subagent:2" },
  ]);
  assert.equal(state.tasks.get("T1").status, "done");
  throwsCode(() => resumed.reserveDispatch("T1"), "duplicate-dispatch");
  throwsCode(() => resumed.reserveDispatch("T2"), "duplicate-dispatch");
  resumed.recordCompletion({ childSessionKey: "agent:main:subagent:2", outcome: "ok" });
  assert.equal(resumed.recover().flagged[0].action, "verify");
  resumed.recordVerification("T2", {
    verifier: "verifier-1",
    verdict: "pass",
    evidenceRefs: ["e"],
  });
  assert.equal(resumed.recover().flagged[0].action, "publish-checkpoint");
});

test("recovery never auto-redispatches a reservation without a receipt", () => {
  const { file, ledger } = fresh();
  ledger.reserveDispatch("T1");
  const resumed = createTaskLedger({ file });
  const { flagged } = resumed.recover();
  assert.deepEqual(flagged, [{ taskId: "T1", action: "inspect-admission" }]);
  const t = resumed.state().tasks.get("T1");
  assert.equal(t.blocker.code, "admission-unknown");
  throwsCode(() => resumed.reserveDispatch("T1"), "duplicate-dispatch");
  throwsCode(
    () =>
      resumed.resolveBlocker("T1", {
        reason: "checked",
        authorizedBy: "coordinator",
        sideEffectsChecked: true,
      }),
    "admission-unknown",
  );
  throwsCode(
    () => resumed.recordReceipt("T1", receipt(1, { childSessionKey: null })),
    "invalid-receipt",
  );
  resumed.recordReceipt("T1", receipt(1));
  assert.equal(resumed.state().tasks.get("T1").status, "running");
  throwsCode(() => resumed.reserveDispatch("T1"), "duplicate-dispatch");
});

test("a torn trailing write is not durable and is repaired on the next append", () => {
  const { file, ledger } = fresh();
  appendFileSync(file, '{"seq":99,"ts":"x","type":"dispatch_res');
  assert.equal(ledger.integrity().tornTail, true);
  assert.equal(ledger.state().tasks.get("T1").status, "pending");
  assert.equal(ledger.reserveDispatch("T1"), 1);
  assert.equal(ledger.integrity().tornTail, false);
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 3);
});

test("tampering or mid-file corruption fails closed", () => {
  const { file, ledger } = fresh();
  ledger.reserveDispatch("T1");
  const lines = readFileSync(file, "utf8").split("\n");
  const edited = JSON.parse(lines[1]);
  edited.data.capability.canPublish = false;
  lines[1] = JSON.stringify(edited);
  writeFileSync(file, lines.join("\n"));
  throwsCode(() => ledger.state(), "ledger-corrupt");
  lines[1] = "{not json";
  writeFileSync(file, lines.join("\n"));
  throwsCode(() => ledger.state(), "ledger-corrupt");
});

test("a concurrent writer is refused instead of double-reserving", () => {
  const { file, ledger } = fresh();
  writeFileSync(`${file}.lock`, "");
  throwsCode(() => ledger.reserveDispatch("T1"), "ledger-busy");
});

test("ledger path must be absolute", () => {
  assert.throws(() => createTaskLedger({ file: "relative.jsonl" }), TypeError);
});

test("acceptance excludes adapter fake-host evidence from standard-spawn claims", () => {
  const { ledger } = fresh();
  for (const [id, n] of [
    ["T1", 1],
    ["T2", 2],
  ]) {
    ledger.reserveDispatch(id);
    ledger.recordReceipt(id, receipt(n, { evidenceSource: "adapter-fake-host" }));
    ledger.recordCompletion({ childSessionKey: `agent:main:subagent:${n}`, outcome: "ok" });
    ledger.recordVerification(id, { verifier: "verifier-1", verdict: "pass", evidenceRefs: ["e"] });
    ledger.recordDashboardSync(id, "d");
  }
  const result = assessAcceptance(ledger.state(), { gateTaskId: "G1" });
  assert.equal(result.accept01.ledgerCriteriaMet, false);
  assert.deepEqual(result.accept01.standardDoneTasks, []);
  assert.deepEqual(result.fakeHostTaskIds, ["T1", "T2"]);
  assert.equal(result.accept01.reason, "adapter-fake-host evidence present; excluded");
  throwsCode(
    () => ledger.recordReceipt("T3", receipt(3, { evidenceSource: "bogus" })),
    "invalid-transition",
  );
  ledger.reserveDispatch("T3");
  throwsCode(
    () => ledger.recordReceipt("T3", receipt(3, { evidenceSource: "bogus" })),
    "invalid-receipt",
  );
});

test("ORCH-ACCEPT-01: three dependent standard-spawn tasks with review halt at the owner gate", () => {
  const { ledger } = fresh();
  assert.equal(
    assessAcceptance(ledger.state(), { gateTaskId: "G1" }).accept01.ledgerCriteriaMet,
    false,
  );
  runToDone(ledger, "T1", 1);
  runToDone(ledger, "T2", 2, 1);
  runToDone(ledger, "T3", 3, 2);
  const a = assessAcceptance(ledger.state(), { gateTaskId: "G1" });
  assert.equal(a.accept01.ledgerCriteriaMet, true);
  assert.equal(a.accept01.haltedAtGate, true);
  assert.deepEqual(a.accept01.standardDoneTasks, ["T1", "T2", "T3"]);
  assert.equal(assessAcceptance(ledger.state()).accept01.ledgerCriteriaMet, false);
  ledger.approveGate("G1", { approvedBy: "sebastian", ref: "pr#1" });
  assert.equal(
    assessAcceptance(ledger.state(), { gateTaskId: "G1" }).accept01.ledgerCriteriaMet,
    false,
  );
});

test("ORCH-ACCEPT-02: each failure scenario is reported covered only by standard-spawn evidence", () => {
  const { ledger } = fresh();
  ledger.addTask(task("E", {}));
  ledger.addTask(task("M", {}));
  ledger.addTask(task("U", {}));
  const empty = assessAcceptance(ledger.state()).accept02;
  assert.ok(Object.values(empty).every((v) => v === "uncovered"));

  const fail = (id, n, outcome) => {
    ledger.reserveDispatch(id);
    ledger.recordReceipt(id, receipt(n));
    ledger.recordCompletion({ childSessionKey: `agent:main:subagent:${n}`, outcome });
  };
  fail("T1", 1, "error");
  ledger.resolveBlocker("T1", { reason: "inspected", authorizedBy: "c", sideEffectsChecked: true });
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(11));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:11", outcome: "timeout" });
  fail("E", 2, "aborted");
  ledger.reserveDispatch("M");
  ledger.recordReceipt("M", { ...receipt(3), unavailable: "route missing" });
  ledger.reserveDispatch("U");
  ledger.recordReceipt("U", receipt(4));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:4", outcome: "ok" });
  ledger.recordVerification("U", { verifier: "verifier-1", verdict: "reject", findings: "nope" });
  const covered = assessAcceptance(ledger.state()).accept02;
  assert.deepEqual(covered, {
    "worker-error": "covered-by-standard-spawn",
    timeout: "covered-by-standard-spawn",
    "model-unavailable": "covered-by-standard-spawn",
    "review-rejected": "covered-by-standard-spawn",
    interrupted: "covered-by-standard-spawn",
  });
});

test("admission-unknown counts as interruption only with standard-spawn evidence; fake host never does", () => {
  const { file, ledger } = fresh();
  ledger.reserveDispatch("T1");
  const resumed = createTaskLedger({ file });
  resumed.recover();
  assert.equal(assessAcceptance(resumed.state()).accept02.interrupted, "uncovered");
  const fake = fresh();
  fake.ledger.reserveDispatch("T1");
  fake.ledger.recordReceipt(
    "T1",
    receipt(1, { evidenceSource: "adapter-fake-host", resolvedModel: "x" }),
  );
  assert.equal(assessAcceptance(fake.ledger.state()).accept02["model-unavailable"], "uncovered");
  assert.equal(deriveStatusView(fake.ledger.state()).tasks[0].evidenceSource, "adapter-fake-host");
});

test("a publisher failure is recoverable: the verified task retries publishing without re-running the worker", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  ledger.recordVerification("T1", { verifier: "v", verdict: "pass", evidenceRefs: ["e"] });
  ledger.recordPublisherFailure("T1", "dashboard 503");
  assert.equal(ledger.state().tasks.get("T1").status, "blocked");
  ledger.recordPublisherFailure("T1", "still 503");
  throwsCode(() => ledger.reserveDispatch("T1"), "duplicate-dispatch");
  ledger.recordDashboardSync("T1", "dash-1");
  const t = ledger.state().tasks.get("T1");
  assert.equal(t.status, "done");
  assert.equal(t.blocker.resolved, true);
  assert.equal(t.attempts.length, 1);
});

test("receipt evidenceSource must be explicit", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  const { evidenceSource, ...rest } = receipt(1);
  assert.equal(evidenceSource, "standard-spawn");
  throwsCode(() => ledger.recordReceipt("T1", rest), "invalid-receipt");
});

test("a blocked attempt with a live child accepts its completion and refuses unsafe retry", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1, { resolvedModel: "other-model" }));
  assert.equal(ledger.state().tasks.get("T1").blocker.code, "model-mismatch");
  throwsCode(
    () => ledger.resolveBlocker("T1", { reason: "r", authorizedBy: "c", sideEffectsChecked: true }),
    "live-child",
  );
  throwsCode(
    () =>
      ledger.resolveBlocker("T1", {
        reason: "r",
        authorizedBy: "c",
        sideEffectsChecked: true,
        childStatus: "terminal",
      }),
    "live-child",
  );
  throwsCode(
    () => ledger.deferTask("T1", { approvedBy: "sebastian", ownerDecision: "d" }),
    "live-child",
  );
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  const t = ledger.state().tasks.get("T1");
  assert.equal(t.status, "blocked");
  assert.equal(t.attempts[0].completion.outcome, "ok");
  ledger.resolveBlocker("T1", { reason: "r", authorizedBy: "c", sideEffectsChecked: true });
  assert.equal(ledger.reserveDispatch("T1"), 2);
});

test("a live blocked child can be abandoned only with terminal evidence; its late completion is ignored", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1, { resolvedModel: "other-model" }));
  ledger.resolveBlocker("T1", {
    reason: "wrong model",
    authorizedBy: "c",
    sideEffectsChecked: true,
    childStatus: "cancelled",
    childEvidence: "subagents list: run-1 cancelled",
  });
  assert.equal(ledger.reserveDispatch("T1"), 2);
  throwsCode(
    () => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" }),
    "unmatched-completion",
  );
  assert.equal(ledger.state().tasks.get("T1").status, "running");
});

test("deferral is owner-only and limited to pending or blocked tasks", () => {
  const { ledger } = fresh();
  throwsCode(
    () => ledger.deferTask("T1", { approvedBy: "worker", ownerDecision: "d" }),
    "not-owner",
  );
  runToDone(ledger, "T1", 1);
  throwsCode(
    () => ledger.deferTask("T1", { approvedBy: "sebastian", ownerDecision: "d" }),
    "invalid-transition",
  );
  ledger.reserveDispatch("T2", {
    trigger: { type: "completion", childSessionKey: "agent:main:subagent:1" },
  });
  throwsCode(
    () => ledger.deferTask("T2", { approvedBy: "sebastian", ownerDecision: "d" }),
    "invalid-transition",
  );
  const bare = createTaskLedger({ file: fresh().file });
  throwsCode(() => bare.approveGate("G1", { approvedBy: "x", ref: "r" }), "owners-not-configured");
});

test("verification needs an identity distinct from the worker", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  throwsCode(
    () => ledger.recordVerification("T1", { verdict: "pass", evidenceRefs: ["e"] }),
    "invalid-verification",
  );
  throwsCode(
    () =>
      ledger.recordVerification("T1", {
        verifier: "agent:main:subagent:1",
        verdict: "pass",
        evidenceRefs: ["e"],
      }),
    "invalid-verification",
  );
});

test("dispatch triggers: completion must reference a dependency; owner nudges defeat zero-nudge acceptance", () => {
  const { ledger } = fresh();
  runToDone(ledger, "T1", 1);
  throwsCode(
    () =>
      ledger.reserveDispatch("T2", { trigger: { type: "completion", childSessionKey: "nope" } }),
    "invalid-trigger",
  );
  throwsCode(() => ledger.reserveDispatch("T2", { trigger: { type: "bogus" } }), "invalid-trigger");
  ledger.reserveDispatch("T2", { trigger: { type: "owner-nudge", ref: "msg-continue" } });
  ledger.recordReceipt("T2", receipt(2));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:2", outcome: "ok" });
  ledger.recordVerification("T2", { verifier: "v", verdict: "pass", evidenceRefs: ["e"] });
  ledger.recordDashboardSync("T2", "d");
  runToDone(ledger, "T3", 3, 2);
  const a = assessAcceptance(ledger.state(), { gateTaskId: "G1" }).accept01;
  assert.equal(a.ownerNudges, 1);
  assert.equal(a.zeroNudge, false);
  assert.equal(a.ledgerCriteriaMet, false);
  ledger.recordOwnerNudge("msg-2");
  assert.equal(ledger.state().nudges.length, 2);
});

test("locks are never auto-removed; recovery requires externally quiesced writers", () => {
  const { file, ledger } = fresh();
  const dead = { pid: 2 ** 22 + 12345, host: hostname(), token: "tok-1" };
  writeFileSync(`${file}.lock`, JSON.stringify(dead));
  throwsCode(() => ledger.reserveDispatch("T1"), "ledger-busy");
  assert.equal(ledger.inspectLock().writerAlive, false);
  assert.equal(ledger.breakStaleLock, undefined);
  unlinkSync(`${file}.lock`);
  assert.equal(ledger.reserveDispatch("T1"), 1);
  writeFileSync(`${file}.lock`, JSON.stringify({ ...dead, pid: process.pid }));
  writeFileSync(`${file}.lock`, JSON.stringify({ ...dead, host: "elsewhere" }));
  assert.equal(ledger.inspectLock().writerAlive, "unknown");
  throwsCode(() => ledger.recordQueued("T1"), "ledger-busy");
  writeFileSync(`${file}.lock`, "garbage");
  assert.equal(ledger.inspectLock().writerAlive, "unknown");
});

test("a failed commit releases its own lock; a foreign lock is never removed", () => {
  const { file, ledger } = fresh();
  assert.throws(() => ledger.addTask({ ...task("X"), dependencies: ["missing"] }));
  assert.equal(ledger.inspectLock().locked, false);
  const foreign = JSON.stringify({ pid: 1, host: "elsewhere", token: "foreign" });
  writeFileSync(`${file}.lock`, foreign);
  throwsCode(() => ledger.recordQueued("T1"), "ledger-busy");
  assert.equal(readFileSync(`${file}.lock`, "utf8"), foreign);
});

test("concurrent writer processes never corrupt the chain or lose acknowledged events", () => {
  const { file, ledger } = fresh();
  const before = ledger.integrity().events;
  const script = `
    import { createTaskLedger } from ${JSON.stringify(new URL("../src/index.js", import.meta.url).href)};
    const l = createTaskLedger({ file: ${JSON.stringify(file)} });
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    let ok = 0;
    for (let i = 0; i < 15; i++) {
      for (let tries = 0; tries < 2000; tries++) {
        try { l.recordOwnerNudge("p" + process.pid + "-" + i); ok++; break; }
        catch (e) { if (e.code !== "ledger-busy") throw e; sleep(1); }
      }
    }
    process.stdout.write(String(ok));
  `;
  const procs = Array.from({ length: 6 }, () =>
    spawn(process.execPath, ["--input-type=module", "-e", script]),
  );
  return Promise.all(
    procs.map(
      (p) =>
        new Promise((resolve, reject) => {
          let out = "";
          let err = "";
          p.stdout.on("data", (d) => (out += d));
          p.stderr.on("data", (d) => (err += d));
          p.on("exit", (code) => (code === 0 ? resolve(Number(out)) : reject(new Error(err))));
        }),
    ),
  ).then((counts) => {
    assert.deepEqual(counts, [15, 15, 15, 15, 15, 15]);
    assert.equal(ledger.integrity().events, before + 90);
    assert.equal(ledger.state().nudges.length, 90);
    assert.equal(ledger.inspectLock().locked, false);
  });
});

test("model receipt matching is exact unless the caller configured a provider alias; never substituted", () => {
  const cases = [
    [{}, { resolvedProvider: "claude-cli" }, "model-mismatch"],
    [
      {},
      { resolvedModel: "anthropic/claude-sonnet-5-5", resolvedProvider: "claude-cli" },
      "model-mismatch",
    ],
    [{}, { resolvedModel: "claude-opus-5-5" }, "model-mismatch"],
    [{ providerAliases: { anthropic: ["claude-cli"] } }, { resolvedProvider: "claude-cli" }, null],
    [
      { providerAliases: { anthropic: ["claude-cli"] } },
      { resolvedProvider: "other" },
      "model-mismatch",
    ],
    [{}, {}, null],
  ];
  cases.forEach(([opts, extra, code], i) => {
    const { ledger } = fresh(opts);
    ledger.reserveDispatch("T1");
    ledger.recordReceipt("T1", receipt(i, extra));
    const t = ledger.state().tasks.get("T1");
    assert.equal(t.blocker?.code ?? null, code, JSON.stringify(extra));
    if (!code) assert.match(t.attempts.at(-1).receipt.modelMatch, /exact|provider-alias/);
  });
});

test("publisher-blocked tasks show a publish-retry next action and recovery flags them", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  ledger.recordVerification("T1", { verifier: "v", verdict: "pass", evidenceRefs: ["e"] });
  ledger.recordPublisherFailure("T1", "503");
  const row = ledger.view().tasks.find((r) => r.id === "T1");
  assert.equal(row.verified, true);
  assert.match(row.nextAction, /retry the dashboard checkpoint/);
  assert.deepEqual(
    ledger.recover().flagged.filter((f) => f.taskId === "T1"),
    [{ taskId: "T1", action: "publish-checkpoint" }],
  );
});

test("acceptance reports ledger-only criteria and host corroboration separately", () => {
  const { ledger } = fresh();
  for (const [id, n, prev] of [
    ["T1", 1],
    ["T2", 2, 1],
    ["T3", 3, 2],
  ])
    runToDone(ledger, id, n, prev);
  const bare = assessAcceptance(ledger.state(), { gateTaskId: "G1" }).accept01;
  assert.equal(bare.ledgerCriteriaMet, true);
  assert.equal(bare.hostCorroborated, false);
  assert.match(bare.notice, /not proof of a live/);
  const obs = [1, 2, 3].flatMap((n) => [
    { kind: "spawned", runId: `run-${n}`, childSessionKey: `agent:main:subagent:${n}` },
    {
      kind: "ended",
      runId: `run-${n}`,
      outcome: "ok",
      childSessionKey: `agent:main:subagent:${n}`,
    },
  ]);
  const ok = assessAcceptance(ledger.state(), { gateTaskId: "G1", observations: obs }).accept01;
  assert.equal(ok.hostCorroborated, true);
  for (const end of [
    null,
    { outcome: "error", runId: "run-1" },
    { outcome: "ok", runId: "other" },
    { outcome: "ok" },
  ]) {
    const modified = obs.filter((o) => !(o.kind === "ended" && o.childSessionKey.endsWith(":1")));
    if (end) modified.push({ kind: "ended", childSessionKey: "agent:main:subagent:1", ...end });
    assert.deepEqual(
      assessAcceptance(ledger.state(), { observations: modified }).accept01.uncorroboratedTaskIds,
      ["T1"],
    );
  }
  for (const extra of [
    { kind: "ended", runId: "run-1", childSessionKey: "agent:main:subagent:1", outcome: "error" },
    { kind: "ended", runId: "run-1", childSessionKey: "agent:main:subagent:1", outcome: null },
  ]) {
    assert.deepEqual(
      assessAcceptance(ledger.state(), { observations: [...obs, extra] }).accept01
        .uncorroboratedTaskIds,
      ["T1"],
    );
  }
  assert.equal(
    assessAcceptance(ledger.state(), { observations: [...obs, { kind: "truncated" }] }).accept01
      .hostCorroborated,
    false,
  );
  const bad = assessAcceptance(ledger.state(), {
    gateTaskId: "G1",
    observations: obs.slice(2),
  }).accept01;
  assert.deepEqual(bad.uncorroboratedTaskIds, ["T1"]);
});

test("plugin registers a read-only owner-only ledger status tool only when configured", async () => {
  const { createLedgerToolFactory, normalizeLedgerConfig, LEDGER_TOOL_NAME } =
    await import("../src/ledger-tool.js");
  const plugin = (await import("../src/plugin.js")).default;
  assert.equal(normalizeLedgerConfig(undefined), undefined);
  assert.throws(() => normalizeLedgerConfig({ file: "rel" }), TypeError);
  assert.throws(() => normalizeLedgerConfig({ file: "/a", x: 1 }), TypeError);
  const reg = [];
  const api = (pluginConfig) => ({
    pluginConfig,
    logger: {},
    on() {},
    registerTool: (...a) => reg.push(a),
    runtime: { subagent: {} },
  });
  plugin.register(api({ enabled: true }));
  assert.equal(reg.length, 0);
  const { file, ledger } = fresh();
  plugin.register(api({ enabled: true, ledger: { file } }));
  assert.deepEqual(reg[0][1], { name: LEDGER_TOOL_NAME, optional: true });
  const factory = createLedgerToolFactory({ limits: { file } });
  assert.equal(factory({ senderIsOwner: false }), null);
  assert.equal(factory({ senderIsOwner: true, sandboxed: true }), null);
  const before = ledger.integrity().events;
  const tool = factory({ senderIsOwner: true });
  const out = await tool.execute("c1", { gateTaskId: "G1" });
  assert.equal(out.details.ok, true);
  assert.equal(out.details.view.tasks.length, 4);
  assert.equal(ledger.integrity().events, before);
  const bad = await createLedgerToolFactory({ limits: { file: `${file}.missing/x` } })({
    senderIsOwner: true,
  }).execute("c2", {});
  assert.equal(bad.details.view.planId, null);
});

test("applied timeout mismatch blocks, while absent or matching is accepted", () => {
  for (const [value, blocked] of [
    [undefined, false],
    [600_000, false],
    [42, true],
    ["600000", true],
  ]) {
    const { ledger } = fresh();
    ledger.reserveDispatch("T1");
    ledger.recordReceipt("T1", receipt(1, { appliedTimeout: value }));
    const task = ledger.state().tasks.get("T1");
    assert.equal(task.status, blocked ? "blocked" : "running");
    if (blocked) {
      assert.equal(task.blocker.code, "timeout-mismatch");
      ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
      assert.equal(ledger.state().tasks.get("T1").status, "blocked");
    }
  }
});

test("persisted alias policy cannot be widened on reopen", () => {
  const { file, ledger } = fresh();
  ledger.reserveDispatch("T1");
  const reopened = createTaskLedger({ file, providerAliases: { anthropic: ["openai"] } });
  reopened.recordReceipt("T1", receipt(1, { resolvedProvider: "openai" }));
  assert.equal(reopened.state().tasks.get("T1").blocker.code, "model-mismatch");
});

test("gate and review rejection resolution require a configured owner", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  ledger.recordVerification("T1", {
    verifier: "reviewer",
    verdict: "reject",
    evidenceRefs: ["x"],
    findings: "defect",
  });
  throwsCode(
    () =>
      ledger.resolveBlocker("T1", {
        reason: "retry",
        authorizedBy: "other",
        sideEffectsChecked: true,
      }),
    "not-owner",
  );
  ledger.resolveBlocker("T1", {
    reason: "retry",
    authorizedBy: "sebastian",
    sideEffectsChecked: true,
  });
});

test("complete final record without newline is retained and repaired", () => {
  const { file, ledger } = fresh();
  ledger.reserveDispatch("T1");
  const raw = readFileSync(file, "utf8");
  writeFileSync(file, raw.slice(0, -1));
  assert.equal(ledger.state().tasks.get("T1").status, "running");
  ledger.recordReceipt("T1", receipt(1));
  assert.equal(ledger.state().tasks.get("T1").attempts[0].receipt.runId, "run-1");
  assert.equal(ledger.integrity().tornTail, false);
});

test("duplicate child identity cannot be reused across attempts", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "error" });
  ledger.resolveBlocker("T1", {
    reason: "retry",
    authorizedBy: "coordinator",
    sideEffectsChecked: true,
  });
  ledger.reserveDispatch("T1");
  throwsCode(() => ledger.recordReceipt("T1", receipt(1)), "duplicate-child");
});

test("rejected gate cannot be reopened by non-owner", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oa2-gate-"));
  const ledger = createTaskLedger({ file: path.join(dir, "ledger"), owners: ["sebastian"] });
  ledger.declarePlan({ planId: "gate", tasks: [task("G", { kind: "gate" })] });
  ledger.rejectGate("G", "no", { rejectedBy: "sebastian" });
  throwsCode(
    () => ledger.resolveBlocker("G", { reason: "reopen", authorizedBy: "other" }),
    "not-owner",
  );
  ledger.resolveBlocker("G", { reason: "reopen", authorizedBy: "sebastian" });
});

function rejectedWith(ledger, verifier, extra = {}) {
  runToDone(ledger, "T1", 1);
  ledger.reserveDispatch("T2");
  ledger.recordReceipt("T2", receipt(2));
  ledger.recordCompletion({
    childSessionKey: "agent:main:subagent:2",
    outcome: "ok",
    digest: "artifact-2",
  });
  ledger.addTask(task("Reviewer", { role: "review" }));
  ledger.reserveDispatch("Reviewer", {
    reviewBinding: { taskId: "T2", attempt: 1, digest: "artifact-2" },
  });
  ledger.recordReceipt("Reviewer", receipt(9));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:9", outcome: "ok" });
  ledger.recordVerification("T2", { verifier, verdict: "reject", findings: "defect", ...extra });
}

test("independent agent review rejection permits scoped bounded correction without owner", () => {
  const { ledger } = fresh({ owners: [] });
  rejectedWith(ledger, "agent:main:subagent:9", { reviewerKind: "agent" });
  const t = ledger.state().tasks.get("T2");
  assert.equal(t.blocker.ownerRequired, false);
  throwsCode(
    () => ledger.resolveBlocker("T2", { reason: "r", authorizedBy: "c", sideEffectsChecked: true }),
    "invalid-resolution",
  );
  ledger.resolveBlocker("T2", {
    reason: "fix",
    authorizedBy: "coordinator",
    sideEffectsChecked: true,
    correctionScope: "address defect only",
  });
  assert.equal(ledger.state().tasks.get("T2").status, "pending");
  ledger.reserveDispatch("T2");
});

test("unverified, human-claimed or owner reviewers keep rejection owner-gated", () => {
  for (const [verifier, extra] of [
    ["someone", {}],
    ["agent:main:subagent:9", {}],
    ["agent:main:subagent:9", { reviewerKind: "human" }],
    ["agent:main:subagent:1", { reviewerKind: "agent" }],
    ["sebastian", {}],
  ]) {
    const { ledger } = fresh();
    rejectedWith(ledger, verifier, extra);
    assert.equal(ledger.state().tasks.get("T2").blocker.ownerRequired, true);
    throwsCode(
      () =>
        ledger.resolveBlocker("T2", {
          reason: "r",
          authorizedBy: "c",
          sideEffectsChecked: true,
          correctionScope: "x",
        }),
      "not-owner",
    );
  }
  const { ledger } = fresh({ owners: [] });
  rejectedWith(ledger, "someone");
  throwsCode(
    () =>
      ledger.resolveBlocker("T2", {
        reason: "r",
        authorizedBy: "sebastian",
        sideEffectsChecked: true,
      }),
    "owners-not-configured",
  );
});

test("agent-review correction retries stay bounded by maxAttempts", () => {
  const { ledger } = fresh({ owners: [] });
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  ledger.recordVerification("T1", { verifier: "v", verdict: "pass", evidenceRefs: ["e"] });
  ledger.recordDashboardSync("T1", "d");
  ledger.addTask(task("R", { maxAttempts: 1 }));
  ledger.reserveDispatch("R");
  ledger.recordReceipt("R", receipt(5));
  ledger.recordCompletion({
    childSessionKey: "agent:main:subagent:5",
    outcome: "ok",
    digest: "artifact-r",
  });
  ledger.addTask(task("Reviewer", { role: "review" }));
  ledger.reserveDispatch("Reviewer", {
    reviewBinding: { taskId: "R", attempt: 1, digest: "artifact-r" },
  });
  ledger.recordReceipt("Reviewer", receipt(9));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:9", outcome: "ok" });
  ledger.recordVerification("R", {
    verifier: "agent:main:subagent:9",
    reviewerKind: "agent",
    verdict: "reject",
    findings: "bad",
  });
  ledger.resolveBlocker("R", {
    reason: "fix",
    authorizedBy: "c",
    sideEffectsChecked: true,
    correctionScope: "s",
  });
  throwsCode(() => ledger.reserveDispatch("R"), "attempts-exhausted");
});

test("reviewer ancestry and unsuccessful reviewer attempts are owner-gated", () => {
  for (const mode of ["ancestor", "error", "abandoned"]) {
    const { ledger } = fresh();
    ledger.addTask(task("Reviewer", { role: "review" }));
    ledger.reserveDispatch("Reviewer");
    ledger.recordReceipt(
      "Reviewer",
      receipt(9, mode === "abandoned" ? { resolvedModel: "wrong" } : {}),
    );
    if (mode === "abandoned") {
      ledger.resolveBlocker("Reviewer", {
        reason: "stop",
        authorizedBy: "c",
        sideEffectsChecked: true,
        childStatus: "cancelled",
        childEvidence: "subagents",
      });
      throwsCode(
        () => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:9", outcome: "ok" }),
        "unmatched-completion",
      );
    } else {
      ledger.recordCompletion({
        childSessionKey: "agent:main:subagent:9",
        outcome: mode === "error" ? "error" : "ok",
      });
      if (mode === "ancestor") {
        ledger.recordVerification("Reviewer", {
          verifier: "v",
          verdict: "pass",
          evidenceRefs: ["e"],
        });
        ledger.recordDashboardSync("Reviewer", "d");
      }
    }
    ledger.addTask(task("Target", { dependencies: mode === "ancestor" ? ["Reviewer"] : [] }));
    ledger.reserveDispatch("Target");
    ledger.recordReceipt("Target", receipt(10));
    ledger.recordCompletion({ childSessionKey: "agent:main:subagent:10", outcome: "ok" });
    throwsCode(
      () =>
        ledger.recordVerification("Target", {
          verifier: "agent:main:subagent:10",
          reviewerKind: "agent",
          verdict: "reject",
          findings: "x",
        }),
      "invalid-verification",
    );
    ledger.recordVerification("Target", {
      verifier: "agent:main:subagent:9",
      reviewerKind: "agent",
      verdict: "reject",
      findings: "x",
    });
    assert.equal(ledger.state().tasks.get("Target").blocker.ownerRequired, true, mode);
  }
});

test("legacy rejection replay without provenance requires an owner", () => {
  const events = [
    {
      type: "plan_declared",
      data: { planId: "p", tasks: [{ ...task("T"), kind: "worker", dependencies: [] }] },
    },
    { type: "dispatch_reserved", data: { taskId: "T", attempt: 1 } },
    {
      type: "verification_recorded",
      data: { taskId: "T", verdict: "reject", verifier: "v", findings: "x" },
    },
  ];
  const t = reduceLedger(events).tasks.get("T");
  assert.equal(t.attempts[0].verification.reviewProvenance, "unverified");
  assert.equal(t.blocker.ownerRequired, true);
});

test("correction cannot pass without a fresh review bound to the new attempt and artifact", () => {
  const { ledger } = fresh({ owners: [] });
  rejectedWith(ledger, "agent:main:subagent:9", { reviewerKind: "agent" });
  ledger.resolveBlocker("T2", {
    reason: "fix",
    authorizedBy: "c",
    sideEffectsChecked: true,
    correctionScope: "fix defect",
  });
  ledger.reserveDispatch("T2");
  ledger.recordReceipt("T2", receipt(20));
  ledger.recordCompletion({
    childSessionKey: "agent:main:subagent:20",
    outcome: "ok",
    digest: "artifact-new",
  });
  const pass = {
    verifier: "agent:main:subagent:9",
    reviewerKind: "agent",
    verdict: "pass",
    evidenceRefs: ["review"],
  };
  throwsCode(() => ledger.recordVerification("T2", pass), "rereview-required");
  ledger.addTask(task("Reviewer2", { role: "review" }));
  throwsCode(
    () =>
      ledger.reserveDispatch("Reviewer2", {
        reviewBinding: { taskId: "T2", attempt: 1, digest: "artifact-2" },
      }),
    "invalid-review-binding",
  );
  throwsCode(
    () =>
      ledger.reserveDispatch("Reviewer2", {
        reviewBinding: { taskId: "T2", attempt: 2, digest: "wrong" },
      }),
    "invalid-review-binding",
  );
  ledger.reserveDispatch("Reviewer2", {
    reviewBinding: { taskId: "T2", attempt: 2, digest: "artifact-new" },
  });
  ledger.recordReceipt("Reviewer2", receipt(21));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:21", outcome: "ok" });
  ledger.recordVerification("T2", { ...pass, verifier: "agent:main:subagent:21" });
  assert.equal(ledger.state().tasks.get("T2").status, "verified");
});

test("blocked reviewer receipts cannot qualify even if their children later succeed", () => {
  for (const bad of [{ resolvedModel: "wrong" }, { resolvedProvider: "" }, { appliedTimeout: 1 }]) {
    const { ledger } = fresh();
    ledger.reserveDispatch("T1");
    ledger.recordReceipt("T1", receipt(1));
    ledger.recordCompletion({
      childSessionKey: "agent:main:subagent:1",
      outcome: "ok",
      digest: "artifact",
    });
    ledger.addTask(task("Reviewer", { role: "review" }));
    ledger.reserveDispatch("Reviewer", {
      reviewBinding: { taskId: "T1", attempt: 1, digest: "artifact" },
    });
    ledger.recordReceipt("Reviewer", receipt(9, bad));
    ledger.recordCompletion({ childSessionKey: "agent:main:subagent:9", outcome: "ok" });
    ledger.recordVerification("T1", {
      verifier: "agent:main:subagent:9",
      reviewerKind: "agent",
      verdict: "reject",
      findings: "defect",
    });
    assert.equal(ledger.state().tasks.get("T1").blocker.ownerRequired, true);
  }
});

test("a review bound to a different target cannot authorize agent correction", () => {
  const { ledger } = fresh();
  for (const [id, n] of [
    ["T1", 1],
    ["Other", 8],
  ]) {
    if (id === "Other") ledger.addTask(task(id));
    ledger.reserveDispatch(id);
    ledger.recordReceipt(id, receipt(n));
    ledger.recordCompletion({
      childSessionKey: `agent:main:subagent:${n}`,
      outcome: "ok",
      digest: "same-artifact",
    });
  }
  ledger.addTask(task("Reviewer", { role: "review" }));
  ledger.reserveDispatch("Reviewer", {
    reviewBinding: { taskId: "Other", attempt: 1, digest: "same-artifact" },
  });
  ledger.recordReceipt("Reviewer", receipt(9));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:9", outcome: "ok" });
  ledger.recordVerification("T1", {
    verifier: "agent:main:subagent:9",
    reviewerKind: "agent",
    verdict: "reject",
    findings: "defect",
  });
  assert.equal(ledger.state().tasks.get("T1").blocker.ownerRequired, true);
});

test("ambiguous verifier identity cannot authorize autonomous correction or corrected pass", () => {
  for (const collision of ["runId", "childSessionKey"]) {
    const { ledger } = fresh();
    ledger.reserveDispatch("T1");
    ledger.recordReceipt("T1", receipt(1));
    ledger.recordCompletion({
      childSessionKey: "agent:main:subagent:1",
      outcome: "ok",
      digest: "a",
    });
    ledger.addTask(task("Other"));
    ledger.reserveDispatch("Other");
    ledger.recordReceipt(
      "Other",
      receipt(8, collision === "runId" ? { runId: "shared" } : { childSessionKey: "shared" }),
    );
    ledger.recordCompletion({
      childSessionKey: collision === "runId" ? "agent:main:subagent:8" : "shared",
      outcome: "ok",
    });
    ledger.addTask(task("Reviewer", { role: "review" }));
    ledger.reserveDispatch("Reviewer", {
      reviewBinding: { taskId: "T1", attempt: 1, digest: "a" },
    });
    ledger.recordReceipt("Reviewer", receipt(9, { runId: "shared" }));
    ledger.recordCompletion({ childSessionKey: "agent:main:subagent:9", outcome: "ok" });
    ledger.recordVerification("T1", {
      verifier: "shared",
      reviewerKind: "agent",
      verdict: "reject",
      findings: "bad",
    });
    assert.equal(ledger.state().tasks.get("T1").blocker.ownerRequired, true, collision);
    throwsCode(
      () =>
        ledger.resolveBlocker("T1", {
          reason: "fix",
          authorizedBy: "coordinator",
          sideEffectsChecked: true,
          correctionScope: "fix",
        }),
      "not-owner",
    );
    ledger.resolveBlocker("T1", {
      reason: "fix",
      authorizedBy: "sebastian",
      sideEffectsChecked: true,
    });
    ledger.reserveDispatch("T1");
    ledger.recordReceipt("T1", receipt(10));
    ledger.recordCompletion({
      childSessionKey: "agent:main:subagent:10",
      outcome: "ok",
      digest: "b",
    });
    ledger.addTask(task("Reviewer2", { role: "review" }));
    ledger.reserveDispatch("Reviewer2", {
      reviewBinding: { taskId: "T1", attempt: 2, digest: "b" },
    });
    ledger.recordReceipt("Reviewer2", receipt(11, { runId: "shared" }));
    ledger.recordCompletion({ childSessionKey: "agent:main:subagent:11", outcome: "ok" });
    throwsCode(
      () =>
        ledger.recordVerification("T1", {
          verifier: "shared",
          reviewerKind: "agent",
          verdict: "pass",
          evidenceRefs: ["review"],
        }),
      "rereview-required",
    );
  }
});

test("bound dependent review dispatches at review-ready while other dependencies stay gated", () => {
  const { ledger } = fresh();
  ledger.addTask(task("Other"));
  ledger.addTask(task("ReviewDependent", { role: "review", dependencies: ["T1", "Other"] }));
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok", digest: "a" });
  const binding = { taskId: "T1", attempt: 1, digest: "a" };
  throwsCode(() => ledger.reserveDispatch("ReviewDependent"), "dependency-unmet");
  throwsCode(
    () =>
      ledger.reserveDispatch("ReviewDependent", { reviewBinding: { ...binding, digest: "wrong" } }),
    "invalid-review-binding",
  );
  throwsCode(
    () => ledger.reserveDispatch("ReviewDependent", { reviewBinding: binding }),
    "dependency-unmet",
  );
  throwsCode(() => ledger.reserveDispatch("T2"), "dependency-unmet");
  runToDone(ledger, "Other", 8);
  ledger.reserveDispatch("ReviewDependent", {
    reviewBinding: binding,
    trigger: { type: "completion", childSessionKey: "agent:main:subagent:1" },
  });
  ledger.recordReceipt("ReviewDependent", receipt(9));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:9", outcome: "ok" });
  ledger.recordVerification("T1", {
    verifier: "agent:main:subagent:9",
    reviewerKind: "agent",
    verdict: "reject",
    findings: "defect",
  });
  assert.equal(ledger.state().tasks.get("T1").blocker.ownerRequired, false);
  ledger.resolveBlocker("T1", {
    reason: "fix",
    authorizedBy: "coordinator",
    sideEffectsChecked: true,
    correctionScope: "fix",
  });
  ledger.reserveDispatch("T1", { trigger: { type: "retry" } });
  ledger.recordReceipt("T1", receipt(10));
  ledger.recordCompletion({
    childSessionKey: "agent:main:subagent:10",
    outcome: "ok",
    digest: "b",
  });
  throwsCode(
    () =>
      ledger.recordVerification("T1", {
        verifier: "agent:main:subagent:9",
        reviewerKind: "agent",
        verdict: "pass",
        evidenceRefs: ["old"],
      }),
    "rereview-required",
  );
  ledger.addTask(task("ReviewAgain", { role: "review", dependencies: ["T1"] }));
  ledger.reserveDispatch("ReviewAgain", {
    reviewBinding: { taskId: "T1", attempt: 2, digest: "b" },
  });
  ledger.recordReceipt("ReviewAgain", receipt(11));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:11", outcome: "ok" });
  ledger.recordVerification("T1", {
    verifier: "agent:main:subagent:11",
    reviewerKind: "agent",
    verdict: "pass",
    evidenceRefs: ["new"],
  });
  ledger.recordDashboardSync("T1", "dashboard");
  assert.equal(ledger.state().tasks.get("T1").status, "done");
});
