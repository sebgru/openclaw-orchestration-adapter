import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskLedger } from "../src/index.js";

const TOOLS = ["sessions_spawn", "sessions_yield", "subagents", "dashboard"];
const MODEL = "anthropic/claude-sonnet-5-5";
const CHILD = "agent:main:subagent:1";

function reviewReadyLedger() {
  const dir = mkdtempSync(path.join(tmpdir(), "oa2-chain-t1-"));
  const ledger = createTaskLedger({ file: path.join(dir, "ledger.jsonl") });
  ledger.declarePlan({
    planId: "p1",
    tasks: [
      {
        id: "T1",
        goal: "goal T1",
        successCriteria: ["criterion T1"],
        requestedModel: MODEL,
        timeoutMs: 600_000,
      },
    ],
  });
  ledger.recordCapability({ tools: TOOLS, publisherTool: "dashboard" });
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", {
    evidenceSource: "standard-spawn",
    runId: "run-1",
    childSessionKey: CHILD,
    resolvedModel: "claude-sonnet-5-5",
    resolvedProvider: "anthropic",
  });
  ledger.recordCompletion({ childSessionKey: CHILD, outcome: "ok" });
  return ledger;
}

function throwsCode(fn, code) {
  assert.throws(fn, (e) => e.name === "LedgerError" && e.code === code, `expected ${code}`);
}

test("a recorded completion without verification can be neither verified nor done", () => {
  const ledger = reviewReadyLedger();
  const before = ledger.state().tasks.get("T1");
  assert.equal(before.status, "review-ready");
  assert.equal(before.verified, false);
  assert.equal(before.attempts.at(-1).verification, null);
  const eventCount = ledger.events().length;

  throwsCode(() => ledger.recordDashboardSync("T1", "dash-T1"), "invalid-transition");
  throwsCode(() => ledger.recordPublisherFailure("T1", "no publish"), "invalid-transition");

  const after = ledger.state().tasks.get("T1");
  assert.equal(after.verified, false);
  assert.equal(after.status, "review-ready");
  assert.notEqual(after.status, "verified");
  assert.notEqual(after.status, "done");
  assert.equal(after.dashboardRef, null);
  assert.equal(ledger.events().length, eventCount, "failed attempts must not append events");
});

test("positive control: an independent-identity pass with evidence verifies the task", () => {
  const ledger = reviewReadyLedger();

  throwsCode(
    () =>
      ledger.recordVerification("T1", { verifier: CHILD, verdict: "pass", evidenceRefs: ["ev-1"] }),
    "invalid-verification",
  );
  throwsCode(
    () =>
      ledger.recordVerification("T1", {
        verifier: "run-1",
        verdict: "pass",
        evidenceRefs: ["ev-1"],
      }),
    "invalid-verification",
  );
  throwsCode(
    () => ledger.recordVerification("T1", { verifier: "verifier-1", verdict: "pass" }),
    "invalid-verification",
  );
  assert.equal(ledger.state().tasks.get("T1").verified, false);

  ledger.recordVerification("T1", {
    verifier: "verifier-1",
    verdict: "pass",
    evidenceRefs: ["ev-1"],
  });

  const task = ledger.state().tasks.get("T1");
  assert.equal(task.verified, true);
  assert.equal(task.status, "verified");
  assert.equal(task.attempts.at(-1).verification.verdict, "pass");
  assert.deepEqual(task.attempts.at(-1).verification.evidenceRefs, ["ev-1"]);

  ledger.recordDashboardSync("T1", "dash-T1");
  assert.equal(ledger.state().tasks.get("T1").status, "done");
});
