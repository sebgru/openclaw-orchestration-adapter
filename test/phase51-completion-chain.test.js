import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskLedger } from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/phase51-completion-chain.json", import.meta.url), "utf8"),
);

test("tasks are ordered T1 implement, T2 verify-test, T3 independent-review", () => {
  assert.deepEqual(
    fixture.tasks.map((t) => t.id),
    ["T1", "T2", "T3"],
  );
  assert.deepEqual(
    fixture.tasks.map((t) => t.role),
    ["implement", "verify-test", "independent-review"],
  );
});

test("dependencies form a linear chain", () => {
  const [t1, t2, t3] = fixture.tasks;
  assert.deepEqual(t1.dependsOn, []);
  assert.deepEqual(t2.dependsOn, ["T1"]);
  assert.deepEqual(t3.dependsOn, ["T2"]);
});

test("spawn uses standard sessions_spawn with completionTarget parent", () => {
  assert.equal(fixture.spawn.tool, "sessions_spawn");
  assert.equal(fixture.spawn.kind, "standard");
  assert.equal(fixture.spawn.completionTarget, "parent");
});

test("parent yields and sends zero owner nudges", () => {
  assert.equal(fixture.parent.yieldAfterSpawn, true);
  assert.equal(fixture.parent.yieldTool, "sessions_yield");
  assert.equal(fixture.parent.ownerNudges, 0);
});

test("advancement requires done except for an exact bound review; failure blocks", () => {
  assert.equal(fixture.parent.advanceAfterDoneExceptBoundReview, true);
  assert.match(fixture.advance.requiredState, /done.*bound review.*review-ready/);
  assert.equal(fixture.failure.status, "blocked");
});

test("chain stops at human PR review", () => {
  assert.equal(fixture.final.stopAt, "human-pr-review");
  assert.equal(fixture.final.autoMerge, false);
});

// Synthetic identities exercise ledger transitions; they do not prove a real independent review.
test("T3 binds to the exact T2 attempt and artifact in the synthetic ledger", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "oa2-chain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = createTaskLedger({ file: path.join(dir, "ledger.jsonl") });
  ledger.declarePlan({ planId: "chain", tasks: fixture.tasks.map((t) => ({
    id: t.id, role: t.ledgerRole ?? (t.id === "T2" ? "verify" : t.role),
    dependencies: t.dependsOn, goal: t.id, successCriteria: ["verified"],
    requestedModel: "anthropic/claude-sonnet-5-5", timeoutMs: 600000,
  })) });
  ledger.recordCapability({ tools: ["sessions_spawn", "sessions_yield", "subagents", "dashboard"], publisherTool: "dashboard" });
  const receipt = (n) => ({ evidenceSource: "standard-spawn", runId: `run-${n}`, childSessionKey: `child-${n}`, resolvedModel: "claude-sonnet-5-5", resolvedProvider: "anthropic" });
  ledger.reserveDispatch("T1"); ledger.recordReceipt("T1", receipt(1));
  ledger.recordCompletion({ childSessionKey: "child-1", outcome: "ok", digest: "artifact-1" });
  ledger.recordVerification("T1", { verifier: "coordinator", verdict: "pass", evidenceRefs: ["e1"] });
  ledger.recordDashboardSync("T1", "d1");
  ledger.reserveDispatch("T2", { trigger: { type: "completion", childSessionKey: "child-1" } });
  ledger.recordReceipt("T2", receipt(2));
  ledger.recordCompletion({ childSessionKey: "child-2", outcome: "ok", digest: "artifact-2" });
  const row = ledger.view().tasks.find((t) => t.id === "T3");
  assert.equal(row.status, "ready");
  assert.deepEqual(row.reviewBinding, { taskId: fixture.tasks[2].reviewTarget, attempt: 1, digest: "artifact-2" });
  assert.throws(() => ledger.reserveDispatch("T3"), /waits on/);
  ledger.reserveDispatch("T3", { trigger: { type: "completion", childSessionKey: "child-2" }, reviewBinding: row.reviewBinding });
  ledger.recordReceipt("T3", receipt(3));
  ledger.recordCompletion({ childSessionKey: "child-3", outcome: "ok", digest: "review" });
  ledger.recordVerification("T2", { verifier: "child-3", reviewerKind: "agent", verdict: "pass", evidenceRefs: ["review"] });
  const attempt = ledger.state().tasks.get("T2").attempts[0];
  assert.equal(attempt.verification.reviewProvenance, "independent-agent");
  assert.deepEqual(attempt.verification.reviewBinding, row.reviewBinding);
  ledger.recordDashboardSync("T2", "d2");
  ledger.recordVerification("T3", { verifier: "coordinator", verdict: "pass", evidenceRefs: ["review"] });
  ledger.recordDashboardSync("T3", "d3");
  assert.deepEqual(fixture.tasks.map(({id}) => ledger.state().tasks.get(id).status), ["done", "done", "done"]);
});
