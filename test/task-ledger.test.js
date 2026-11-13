import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  runId: `run-${n}`,
  childSessionKey: `agent:main:subagent:${n}`,
  resolvedModel: "claude-sonnet-5-5",
  resolvedProvider: "anthropic",
  ...extra,
});

function fresh(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "oa2-ledger-"));
  const file = path.join(dir, "ledger.jsonl");
  const ledger = createTaskLedger({ file, ...options });
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

function runToDone(ledger, id, n) {
  ledger.reserveDispatch(id);
  ledger.recordReceipt(id, receipt(n));
  ledger.recordCompletion({ childSessionKey: `agent:main:subagent:${n}`, outcome: "ok" });
  ledger.recordVerification(id, { verdict: "pass", evidenceRefs: [`ev-${id}`] });
  ledger.recordDashboardSync(id, `dash-${id}`);
}

test("plan validation rejects cycles, unknown dependencies and unobservable tasks", () => {
  const ledger = createTaskLedger({ file: path.join(mkdtempSync(path.join(tmpdir(), "oa2-")), "l.jsonl") });
  throwsCode(() => ledger.declarePlan({ planId: "x", tasks: [task("A", { dependencies: ["B"] }), task("B", { dependencies: ["A"] })] }), "invalid-plan");
  throwsCode(() => ledger.declarePlan({ planId: "x", tasks: [task("A", { dependencies: ["Z"] })] }), "invalid-plan");
  throwsCode(() => ledger.declarePlan({ planId: "x", tasks: [{ ...task("A"), successCriteria: [] }] }), "invalid-plan");
  throwsCode(() => ledger.declarePlan({ planId: "x", tasks: [{ ...task("A"), timeoutMs: undefined }] }), "invalid-plan");
  throwsCode(() => ledger.declarePlan({ planId: "x", tasks: [{ ...task("A"), requestedModel: undefined }] }), "invalid-plan");
  throwsCode(() => ledger.declarePlan({ planId: "x", tasks: [task("A"), task("A")] }), "invalid-plan");
  throwsCode(() => ledger.declarePlan({ planId: "x", tasks: [task("A", { dependencies: ["A"] })] }), "invalid-plan");
});

test("dependency DAG is visible: waiting, ready, gated and blocked-upstream", () => {
  const { ledger } = fresh();
  let view = ledger.view();
  const by = (id) => view.tasks.find((t) => t.id === id);
  assert.equal(by("T1").status, "ready");
  assert.equal(by("T2").status, "waiting");
  assert.deepEqual(by("T2").waitingOn, ["T1"]);
  assert.deepEqual(view.edges, [["T1", "T2"], ["T2", "T3"], ["T3", "G1"]]);
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "error", reason: "boom" });
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
  ledger.recordVerification("T1", { verdict: "pass", evidenceRefs: ["e"] });
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
  assert.deepEqual(assessContinuationCapability({ tools: ["sessions_spawn", "sessions_yield", "subagents"] }), {
    canDispatch: true,
    canPublish: false,
    publisherTool: null,
    missing: ["publisher"],
  });
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
  ledger.recordVerification("A", { verdict: "pass", evidenceRefs: ["e"] });
  throwsCode(() => ledger.recordDashboardSync("A", "claimed"), "publisher-unavailable");
  assert.equal(ledger.state().tasks.get("A").status, "verified");
  throwsCode(() => ledger.reserveDispatch("B"), "dependency-unmet");
  ledger.recordPublisherFailure("A", "no dashboard tool");
  assert.equal(ledger.state().tasks.get("A").blocker.code, "publisher-unavailable");
  throwsCode(() => ledger.resolveBlocker("A", { reason: "x", authorizedBy: "coordinator", sideEffectsChecked: true }), "invalid-resolution");
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
  throwsCode(() => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:forged", outcome: "ok" }), "unmatched-completion");
  assert.equal(ledger.state().tasks.get("T1").status, "running");
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "ok" });
  throwsCode(() => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "error" }), "duplicate-completion");
  assert.equal(ledger.state().tasks.get("T1").status, "review-ready");
  assert.deepEqual(ledger.state().notes.map((n) => n.type), ["completion_unmatched", "completion_duplicate"]);
  throwsCode(() => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "weird" }), "duplicate-completion");
});

test("worker error, timeout and interruption block the task and never advance dependents", () => {
  for (const [outcome, code] of [["error", "worker-error"], ["timeout", "timeout"], ["aborted", "interrupted"]]) {
    const { ledger } = fresh();
    ledger.reserveDispatch("T1");
    ledger.recordReceipt("T1", receipt(1));
    ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome, reason: outcome });
    assert.equal(ledger.state().tasks.get("T1").blocker.code, code);
    assert.equal(ledger.state().tasks.get("T1").verified, false);
    throwsCode(() => ledger.reserveDispatch("T2"), "dependency-unmet");
    throwsCode(() => ledger.recordVerification("T1", { verdict: "pass", evidenceRefs: ["e"] }), "invalid-transition");
  }
});

test("unknown completion outcome is rejected without state change", () => {
  const { ledger } = fresh();
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", receipt(1));
  throwsCode(() => ledger.recordCompletion({ childSessionKey: "agent:main:subagent:1", outcome: "weird" }), "invalid-completion");
  assert.equal(ledger.state().tasks.get("T1").status, "running");
});

test("rejected review blocks with findings; a pass needs evidence refs", () => {
  const { ledger } = fresh();
  runToDone(ledger, "T1", 1);
  ledger.reserveDispatch("T2");
  ledger.recordReceipt("T2", receipt(2));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:2", outcome: "ok" });
  throwsCode(() => ledger.recordVerification("T2", { verdict: "pass", evidenceRefs: [] }), "invalid-verification");
  throwsCode(() => ledger.recordVerification("T2", { verdict: "reject" }), "invalid-verification");
  throwsCode(() => ledger.recordVerification("T2", { verdict: "maybe" }), "invalid-verification");
  ledger.recordVerification("T2", { verdict: "reject", findings: "criterion 2 not met" });
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
  ledger.recordVerification("T1", { verdict: "pass", evidenceRefs: ["e"] });
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
  throwsCode(() => ledger.resolveBlocker("T1", { reason: "r", authorizedBy: "coordinator" }), "invalid-resolution");
  throwsCode(() => ledger.resolveBlocker("T1", { reason: "", authorizedBy: "coordinator", sideEffectsChecked: true }), "invalid-resolution");
  throwsCode(() => ledger.resolveBlocker("T2", { reason: "r", authorizedBy: "c", sideEffectsChecked: true }), "invalid-transition");
  ledger.resolveBlocker("T1", { reason: "worktree inspected, no partial writes", authorizedBy: "coordinator", sideEffectsChecked: true });
  assert.equal(ledger.view().tasks[0].status, "ready");
  assert.equal(ledger.reserveDispatch("T1"), 2);
  ledger.recordReceipt("T1", receipt(2));
  ledger.recordCompletion({ childSessionKey: "agent:main:subagent:2", outcome: "error" });
  ledger.resolveBlocker("T1", { reason: "again", authorizedBy: "coordinator", sideEffectsChecked: true });
  throwsCode(() => ledger.reserveDispatch("T1"), "attempts-exhausted");
});

test("owner gate stops at human review; approval is scoped to that gate and not dispatchable", () => {
  const { ledger } = fresh();
  throwsCode(() => ledger.reserveDispatch("G1"), "not-dispatchable");
  throwsCode(() => ledger.approveGate("G1", { approvedBy: "sebastian", ref: "pr#1" }), "dependency-unmet");
  runToDone(ledger, "T1", 1);
  runToDone(ledger, "T2", 2);
  runToDone(ledger, "T3", 3);
  assert.equal(ledger.view().tasks.find((t) => t.id === "G1").status, "gated");
  throwsCode(() => ledger.approveGate("G1", { approvedBy: "", ref: "x" }), "invalid-gate");
  ledger.approveGate("G1", { approvedBy: "sebastian", ref: "pr#1" });
  throwsCode(() => ledger.approveGate("G1", { approvedBy: "sebastian", ref: "pr#1" }), "invalid-transition");
  assert.equal(ledger.state().tasks.get("G1").approvedBy, "sebastian");
});

test("rejected gate blocks and defer needs an owner decision reference", () => {
  const { ledger } = fresh();
  throwsCode(() => ledger.deferTask("T1", ""), "invalid-deferral");
  ledger.deferTask("T1", "owner decision 2026-11-13");
  assert.equal(ledger.state().tasks.get("T1").status, "deferred");
  throwsCode(() => ledger.reserveDispatch("T1"), "duplicate-dispatch");
  const g = fresh();
  runToDone(g.ledger, "T1", 1);
  runToDone(g.ledger, "T2", 2);
  runToDone(g.ledger, "T3", 3);
  g.ledger.rejectGate("G1", "changes requested");
  assert.equal(g.ledger.state().tasks.get("G1").blocker.code, "gate-rejected");
  throwsCode(() => g.ledger.rejectGate("T1", "x"), "invalid-transition");
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
  assert.deepEqual(flagged, [{ taskId: "T2", action: "await-completion", childSessionKey: "agent:main:subagent:2" }]);
  assert.equal(state.tasks.get("T1").status, "done");
  throwsCode(() => resumed.reserveDispatch("T1"), "duplicate-dispatch");
  throwsCode(() => resumed.reserveDispatch("T2"), "duplicate-dispatch");
  resumed.recordCompletion({ childSessionKey: "agent:main:subagent:2", outcome: "ok" });
  assert.equal(resumed.recover().flagged[0].action, "verify");
  resumed.recordVerification("T2", { verdict: "pass", evidenceRefs: ["e"] });
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
  resumed.resolveBlocker("T1", { reason: "subagents list shows no run for T1", authorizedBy: "coordinator", sideEffectsChecked: true });
  assert.equal(resumed.reserveDispatch("T1"), 2);
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
  for (const [id, n] of [["T1", 1], ["T2", 2]]) {
    ledger.reserveDispatch(id);
    ledger.recordReceipt(id, receipt(n, { evidenceSource: "adapter-fake-host" }));
    ledger.recordCompletion({ childSessionKey: `agent:main:subagent:${n}`, outcome: "ok" });
    ledger.recordVerification(id, { verdict: "pass", evidenceRefs: ["e"] });
    ledger.recordDashboardSync(id, "d");
  }
  const result = assessAcceptance(ledger.state(), { gateTaskId: "G1" });
  assert.equal(result.accept01.met, false);
  assert.deepEqual(result.accept01.standardDoneTasks, []);
  assert.deepEqual(result.fakeHostTaskIds, ["T1", "T2"]);
  assert.equal(result.accept01.reason, "adapter-fake-host evidence present; excluded");
  throwsCode(() => ledger.recordReceipt("T3", receipt(3, { evidenceSource: "bogus" })), "invalid-transition");
  ledger.reserveDispatch("T3");
  throwsCode(() => ledger.recordReceipt("T3", receipt(3, { evidenceSource: "bogus" })), "invalid-receipt");
});

test("ORCH-ACCEPT-01: three dependent standard-spawn tasks with review halt at the owner gate", () => {
  const { ledger } = fresh();
  assert.equal(assessAcceptance(ledger.state(), { gateTaskId: "G1" }).accept01.met, false);
  runToDone(ledger, "T1", 1);
  runToDone(ledger, "T2", 2);
  runToDone(ledger, "T3", 3);
  const a = assessAcceptance(ledger.state(), { gateTaskId: "G1" });
  assert.equal(a.accept01.met, true);
  assert.equal(a.accept01.haltedAtGate, true);
  assert.deepEqual(a.accept01.standardDoneTasks, ["T1", "T2", "T3"]);
  assert.equal(assessAcceptance(ledger.state()).accept01.met, false);
  ledger.approveGate("G1", { approvedBy: "sebastian", ref: "pr#1" });
  assert.equal(assessAcceptance(ledger.state(), { gateTaskId: "G1" }).accept01.met, false);
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
  ledger.recordVerification("U", { verdict: "reject", findings: "nope" });
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
  fake.ledger.recordReceipt("T1", receipt(1, { evidenceSource: "adapter-fake-host", resolvedModel: "x" }));
  assert.equal(assessAcceptance(fake.ledger.state()).accept02["model-unavailable"], "uncovered");
  assert.equal(deriveStatusView(fake.ledger.state()).tasks[0].evidenceSource, "adapter-fake-host");
});
