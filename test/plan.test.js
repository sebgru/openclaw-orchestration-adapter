import test from "node:test";
import assert from "node:assert/strict";
import {
  assertValidTask,
  cancelPlan,
  createPlan,
  createMemoryEvidenceBrief,
  dispatchReadyBatch,
  readyTaskIds,
  transitionTask,
  validateTask,
} from "../src/index.js";

function task(id, dependencies = []) {
  return {
    contractVersion: 1,
    id,
    goal: `Complete ${id}`,
    successCriteria: [`${id} result is verified`],
    allowedTools: ["read"],
    prohibitedActions: ["write", "external-send"],
    routeTier: "standard",
    budget: { maxCalls: 4, maxTokens: 8000, timeoutMs: 30000, maxRetries: 1 },
    scope: { tenantId: "opaque-tenant", channel: "webchat", conversationId: "opaque-chat" },
    outputSchema: { type: "object" },
    dependencies,
  };
}

test("accepts a valid v1 task and rejects missing safety bounds", () => {
  const valid = task("one");
  assert.deepEqual(validateTask(valid), []);
  assert.equal(assertValidTask(valid), valid);

  const invalid = task("bad");
  delete invalid.scope.tenantId;
  delete invalid.budget.maxCalls;
  assert.match(validateTask(invalid).join(" "), /budget\.maxCalls/);
  assert.match(validateTask(invalid).join(" "), /opaque tenantId/);
  assert.throws(() => assertValidTask(invalid), /Invalid task contract/);
});

test("rejects duplicate IDs, unknown dependencies, and dependency cycles", () => {
  assert.throws(() => createPlan([task("x"), task("x")]), /Duplicate task ID/);
  assert.throws(() => createPlan([task("x", ["missing"])]), /unknown dependency/);
  assert.throws(() => createPlan([task("x", ["y"]), task("y", ["x"])]), /dependency cycle/);
});

test("readiness and transitions enforce dependency completion", () => {
  const plan = createPlan([task("first"), task("second", ["first"])]);
  assert.deepEqual(readyTaskIds(plan), ["first"]);
  assert.throws(() => transitionTask(plan, "second", "ready"), /not ready/);

  transitionTask(plan, "first", "ready");
  transitionTask(plan, "first", "running");
  transitionTask(plan, "first", "verifying");
  transitionTask(plan, "first", "succeeded");
  assert.deepEqual(readyTaskIds(plan), ["second"]);
  transitionTask(plan, "second", "ready");
  assert.throws(() => transitionTask(plan, "second", "succeeded"), /Invalid task transition/);
});

test("plan snapshots input and cancellation preserves completed tasks", () => {
  const source = task("first");
  const plan = createPlan([source, task("second", ["first"])]);
  source.successCriteria[0] = "changed after planning";
  assert.equal(plan.tasks.get("first").contract.successCriteria[0], "first result is verified");

  transitionTask(plan, "first", "ready");
  transitionTask(plan, "first", "running");
  transitionTask(plan, "first", "verifying");
  transitionTask(plan, "first", "succeeded");
  cancelPlan(plan);
  assert.equal(plan.tasks.get("first").state, "succeeded");
  assert.equal(plan.tasks.get("second").state, "cancelled");
});

test("dispatch is concurrency-capped, grant-scoped, and requires independent verification", async () => {
  const plan = createPlan([task("one"), task("two"), task("three")]);
  const calls = [];
  const result = await dispatchReadyBatch(plan, {
    maxParallel: 2,
    resolveModel: async (tier) => `configured:${tier}`,
    worker: async ({ task: dispatchedTask, grant, model }) => {
      calls.push({ id: dispatchedTask.id, grant, model });
      return { result: dispatchedTask.id };
    },
    verify: async (_task, output) => ({ ok: Boolean(output.result), evidence: "checked" }),
  });

  assert.equal(result.dispatched.length, 2);
  assert.deepEqual(calls.map((call) => call.id), ["one", "two"]);
  assert.deepEqual(calls[0].grant.allowedTools, ["read"]);
  assert.equal(calls[0].grant.mayDelegate, false);
  assert.equal(calls[0].model, "configured:standard");
  assert.deepEqual(readyTaskIds(plan), ["three"]);
  assert.equal(plan.tasks.get("one").state, "succeeded");
});

test("failed verification never marks a task successful", async () => {
  const plan = createPlan([task("one")]);
  const result = await dispatchReadyBatch(plan, {
    resolveModel: () => "configured:model",
    worker: async () => ({ unverified: true }),
    verify: async () => ({ ok: false, evidence: "criterion not met" }),
  });
  assert.equal(result.dispatched[0].state, "failed");
  assert.equal(plan.tasks.get("one").state, "failed");
});

test("task timeout aborts the worker and records failure", async () => {
  const bounded = task("slow");
  bounded.budget.timeoutMs = 10;
  const plan = createPlan([bounded]);
  const result = await dispatchReadyBatch(plan, {
    resolveModel: () => "configured:model",
    worker: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
    verify: async () => ({ ok: true }),
  });
  assert.equal(result.dispatched[0].state, "failed");
  assert.equal(result.dispatched[0].error.name, "TimeoutError");
});

test("plan cancellation propagates to workers", async () => {
  const plan = createPlan([task("cancel-me")]);
  const controller = new AbortController();
  const pending = dispatchReadyBatch(plan, {
    resolveModel: () => "configured:model",
    worker: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      controller.abort("owner cancelled");
    }),
    verify: async () => ({ ok: true }),
    signal: controller.signal,
  });
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(plan.tasks.get("cancel-me").state, "cancelled");
});

test("memory brief fails closed without a known versioned receipt", () => {
  const missing = createMemoryEvidenceBrief(null, "secret or unverified content");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.evidence, null);

  const future = createMemoryEvidenceBrief({ schemaVersion: 99 }, "unverified content");
  assert.equal(future.reason, "missing-or-invalid-receipt");
  assert.equal(future.evidence, null);
});

test("memory evidence is bounded and explicitly marked untrusted", () => {
  const receipt = {
    schemaVersion: 2,
    turnId: "turn-123",
    status: "found",
    resultCount: 2,
    includedCount: 2,
    sources: { searched: ["main"], absent: [], unavailable: [], notSearched: ["archive", "documents"], unknownCoverage: [] },
    warnings: [],
    conflicts: [],
    truncated: false,
    partialCoverage: false,
    noContentIncluded: false,
  };
  const brief = createMemoryEvidenceBrief(receipt, "A".repeat(25), { maxChars: 12 });
  assert.equal(brief.status, "found");
  assert.equal(brief.evidence.trust, "untrusted-evidence");
  assert.equal(brief.evidence.instructionsAllowed, false);
  assert.equal(brief.evidence.text.length, 12);
  assert.equal(brief.evidence.truncated, true);
});

test("absent and unavailable receipts never forward retrieval content", () => {
  const base = {
    schemaVersion: 2,
    turnId: "turn-123",
    resultCount: 0,
    includedCount: 0,
    sources: { searched: [], absent: ["main", "archive", "documents"], unavailable: [], notSearched: [], unknownCoverage: [] },
    warnings: [],
    conflicts: [],
    truncated: false,
    partialCoverage: false,
    noContentIncluded: false,
  };
  const absent = createMemoryEvidenceBrief({ ...base, status: "absent" }, "should be ignored");
  assert.equal(absent.status, "absent");
  assert.equal(absent.evidence, null);

  const unavailable = createMemoryEvidenceBrief({
    ...base,
    status: "unavailable",
    sources: { searched: [], absent: [], unavailable: ["main", "archive", "documents"], notSearched: [], unknownCoverage: [] },
  }, "should be ignored");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.evidence, null);
});

test("worker brief preserves task provenance and grants while failing closed on absent receipts", async () => {
  const { createWorkerBrief } = await import("../src/index.js");
  const source = task("brief");
  const brief = createWorkerBrief(source, {
    memoryReceipt: null,
    memoryContent: "must not cross the boundary",
  });
  assert.equal(brief.schemaVersion, 1);
  assert.equal(brief.task.id, "brief");
  assert.equal(brief.authority.mayDelegate, false);
  assert.deepEqual(brief.authority.allowedTools, ["read"]);
  assert.equal(brief.memory.status, "unavailable");
  assert.equal(brief.memory.evidence, null);
  assert.equal(brief.provenance.memoryReceiptSchemaVersion, null);
});

test("worker brief carries only bounded untrusted memory evidence with receipt provenance", async () => {
  const { createWorkerBrief } = await import("../src/index.js");
  const receipt = {
    schemaVersion: 2,
    turnId: "turn-from-owner",
    status: "found",
    resultCount: 1,
    includedCount: 1,
    sources: { searched: ["main"], absent: [], unavailable: [], notSearched: ["archive", "documents"], unknownCoverage: [] },
    warnings: [], conflicts: [], truncated: false, partialCoverage: false, noContentIncluded: false,
  };
  const brief = createWorkerBrief(task("brief"), { memoryReceipt: receipt, memoryContent: "source text", maxChars: 5 });
  assert.equal(brief.memory.evidence.text, "sourc");
  assert.equal(brief.memory.evidence.trust, "untrusted-evidence");
  assert.equal(brief.memory.evidence.instructionsAllowed, false);
  assert.equal(brief.provenance.memoryTurnId, "turn-from-owner");
  assert.deepEqual(brief.provenance.memorySources.searched, ["main"]);
});
