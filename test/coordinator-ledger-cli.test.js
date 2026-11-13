import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskLedger } from "../src/task-ledger.js";

test("local coordinator bridge persists transitions, blocks unsafe receipt and owner operations", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "oa2-cli-")), "ledger.jsonl");
  function call(method, ...args) {
    const p = spawnSync(process.execPath, ["bin/coordinator-ledger.js"], {
      input: JSON.stringify({ file, method, args }),
      encoding: "utf8",
    });
    return { status: p.status, ...JSON.parse(p.stdout) };
  }
  assert.equal(
    call("declarePlan", {
      planId: "p",
      tasks: [
        { id: "T1", goal: "x", successCriteria: ["x"], requestedModel: "p/m", timeoutMs: 1000 },
      ],
    }).ok,
    true,
  );
  assert.equal(
    call("recordCapability", { tools: ["sessions_spawn", "sessions_yield", "subagents"] }).ok,
    true,
  );
  assert.equal(call("reserveDispatch", "T1").result, 1);
  const r = call("recordReceipt", "T1", {
    evidenceSource: "standard-spawn",
    runId: "r",
    childSessionKey: "c",
    resolvedProvider: "p",
    resolvedModel: "m",
    appliedTimeout: 999,
  });
  assert.equal(r.result.tasks[0].status, "blocked");
  assert.equal(call("reserveDispatch", "T1").status, 1);
  assert.equal(call("approveGate", "G", {}).status, 1);
  assert.equal(call("view").result.tasks[0].status, "blocked");
});

test("bridge rejects request-supplied aliases", () => {
  const p = spawnSync(process.execPath, ["bin/coordinator-ledger.js"], {
    input: JSON.stringify({
      file: "/tmp/unused-ledger",
      method: "view",
      args: [],
      providerAliases: { anthropic: ["openai"] },
    }),
    encoding: "utf8",
  });
  assert.equal(p.status, 1);
  assert.match(JSON.parse(p.stdout).error, /providerAliases/);
});

test("review rejection remains blocked through bridge until trusted owner resolution", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "oa2-cli-review-")), "ledger.jsonl");
  const ledger = createTaskLedger({ file });
  ledger.declarePlan({
    planId: "p",
    tasks: [
      { id: "T1", goal: "x", successCriteria: ["x"], requestedModel: "p/m", timeoutMs: 1000 },
    ],
  });
  ledger.recordCapability({ tools: ["sessions_spawn", "sessions_yield", "subagents"] });
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", {
    evidenceSource: "standard-spawn",
    runId: "r",
    childSessionKey: "c",
    resolvedProvider: "p",
    resolvedModel: "m",
  });
  ledger.recordCompletion({ childSessionKey: "c", outcome: "ok" });
  ledger.recordVerification("T1", { verifier: "reviewer", verdict: "reject", findings: "defect" });
  const resolution = { reason: "retry", authorizedBy: "owner", sideEffectsChecked: true };
  const p = spawnSync(process.execPath, ["bin/coordinator-ledger.js"], {
    input: JSON.stringify({
      file,
      method: "resolveBlocker",
      args: ["T1", resolution],
      owners: ["owner"],
    }),
    encoding: "utf8",
  });
  assert.equal(p.status, 1);
  assert.equal(JSON.parse(p.stdout).code, "owners-not-configured");
  assert.equal(ledger.state().tasks.get("T1").status, "blocked");
  // This models a trusted integration after authenticating the owner externally.
  createTaskLedger({ file, owners: ["owner"] }).resolveBlocker("T1", resolution);
  assert.equal(ledger.state().tasks.get("T1").blocker.resolved, true);
});

test("bridge defaults an omitted reviewer kind to owner-gated even with a review child", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "oa2-cli-kind-")), "ledger.jsonl");
  const ledger = createTaskLedger({ file });
  const def = (id, role) => ({ id, role, goal: "x", successCriteria: ["x"], requestedModel: "p/m", timeoutMs: 1000 });
  ledger.declarePlan({ planId: "p", tasks: [def("R", "review"), def("T", "implement")] });
  ledger.recordCapability({ tools: ["sessions_spawn", "sessions_yield", "subagents"] });
  for (const id of ["R", "T"]) {
    ledger.reserveDispatch(id);
    ledger.recordReceipt(id, { evidenceSource: "standard-spawn", runId: `run-${id}`, childSessionKey: `child-${id}`, resolvedProvider: "p", resolvedModel: "m" });
    ledger.recordCompletion({ childSessionKey: `child-${id}`, outcome: "ok" });
  }
  const call = (method, args) => spawnSync(process.execPath, ["bin/coordinator-ledger.js"], { input: JSON.stringify({ file, method, args }), encoding: "utf8" });
  assert.equal(call("recordVerification", ["T", { verifier: "child-R", verdict: "reject", findings: "x" }]).status, 0);
  assert.equal(ledger.state().tasks.get("T").blocker.ownerRequired, true);
  const result = call("resolveBlocker", ["T", { reason: "fix", authorizedBy: "owner", sideEffectsChecked: true, correctionScope: "x" }]);
  assert.equal(JSON.parse(result.stdout).code, "owners-not-configured");
});
