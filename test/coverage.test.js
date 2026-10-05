import test from "node:test";
import assert from "node:assert/strict";
import {
  assertValidTask,
  cancelPlan,
  createPlan,
  createMemoryEvidenceBrief,
  createWorkerBrief,
  dispatchReadyBatch,
  dispatchTask,
  isTaskState,
  normalizeMemoryReceipt,
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

function receipt(overrides = {}) {
  return {
    schemaVersion: 2,
    turnId: "turn-1",
    status: "found",
    resultCount: 1,
    includedCount: 1,
    sources: {
      searched: ["main"],
      absent: [],
      unavailable: [],
      notSearched: ["archive", "documents"],
      unknownCoverage: [],
    },
    warnings: [],
    conflicts: [],
    truncated: false,
    partialCoverage: false,
    noContentIncluded: false,
    ...overrides,
  };
}

test("validateTask reports every contract violation and isTaskState guards states", () => {
  assert.deepEqual(validateTask(null), ["task must be an object"]);
  assert.deepEqual(validateTask([]), ["task must be an object"]);
  assert.equal(isTaskState("running"), true);
  assert.equal(isTaskState("unknown"), false);

  const mutations = [
    [(t) => (t.contractVersion = 2), /contractVersion must be 1/],
    [(t) => (t.id = "   "), /id must be a non-empty string/],
    [(t) => (t.id = 7), /id must be a non-empty string/],
    [(t) => (t.goal = ""), /goal must be a non-empty string/],
    [(t) => (t.successCriteria = []), /successCriteria/],
    [(t) => (t.successCriteria = "goal"), /successCriteria/],
    [(t) => (t.successCriteria = [1]), /successCriteria/],
    [(t) => (t.allowedTools = "read"), /allowedTools/],
    [(t) => (t.allowedTools = [""]), /allowedTools/],
    [(t) => (t.prohibitedActions = null), /prohibitedActions/],
    [(t) => (t.prohibitedActions = [3]), /prohibitedActions/],
    [(t) => (t.routeTier = "turbo"), /routeTier/],
    [(t) => (t.budget = null), /budget must be an object/],
    [(t) => (t.budget.maxCalls = 2.5), /budget\.maxCalls/],
    [(t) => (t.budget.maxTokens = 0), /budget\.maxTokens/],
    [(t) => (t.budget.timeoutMs = -1), /budget\.timeoutMs/],
    [(t) => (t.budget.maxRetries = 2), /budget\.maxRetries/],
    [(t) => (t.scope = "opaque"), /scope/],
    [(t) => delete t.scope.channel, /scope/],
    [(t) => delete t.scope.conversationId, /scope/],
    [(t) => (t.outputSchema = []), /outputSchema/],
    [(t) => (t.dependencies = "first"), /dependencies/],
    [(t) => (t.dependencies = [1]), /dependencies/],
  ];

  for (const [mutate, pattern] of mutations) {
    const candidate = task("mutation");
    mutate(candidate);
    const errors = validateTask(candidate);
    assert.ok(errors.length > 0);
    assert.match(errors.join(" "), pattern);
    assert.throws(() => assertValidTask(candidate), /Invalid task contract/);
  }
});

test("createPlan rejects non-arrays, empty plans, and self-dependencies", () => {
  assert.throws(() => createPlan(undefined), /at least one task/);
  assert.throws(() => createPlan([]), /at least one task/);
  assert.throws(() => createPlan([task("solo", ["solo"])]), /cannot depend on itself/);
});

test("createPlan handles diamond dependencies and transition guards", () => {
  const plan = createPlan([
    task("root"),
    task("left", ["root"]),
    task("right", ["root"]),
    task("join", ["left", "right"]),
  ]);
  assert.deepEqual(readyTaskIds(plan), ["root"]);
  assert.throws(() => transitionTask(plan, "missing", "ready"), /Unknown task ID/);
  assert.throws(() => transitionTask(plan, "root", "flying"), /Unknown task state/);
  assert.throws(() => transitionTask(plan, "root", "succeeded"), /Invalid task transition/);

  transitionTask(plan, "root", "ready");
  transitionTask(plan, "root", "running");
  transitionTask(plan, "root", "verifying");
  const entry = transitionTask(plan, "root", "succeeded");
  assert.equal(entry.state, "succeeded");
  assert.deepEqual(readyTaskIds(plan).sort(), ["left", "right"]);
});

test("failed and blocked tasks follow the declared transition limits", () => {
  const failedPlan = createPlan([task("fail")]);
  transitionTask(failedPlan, "fail", "ready");
  transitionTask(failedPlan, "fail", "running");
  transitionTask(failedPlan, "fail", "failed");
  // `failed -> ready` is declared but guarded by dependency readiness, which
  // only considers `pending` tasks, so it is rejected in practice.
  assert.throws(() => transitionTask(failedPlan, "fail", "ready"), /not ready/);
  assert.throws(() => transitionTask(failedPlan, "fail", "cancelled"), /Invalid task transition/);

  const blockedPlan = createPlan([task("block")]);
  transitionTask(blockedPlan, "block", "blocked");
  transitionTask(blockedPlan, "block", "cancelled");
  assert.equal(blockedPlan.tasks.get("block").state, "cancelled");
});

test("readyTaskIds tolerates references to unknown dependencies", () => {
  const plan = {
    tasks: new Map([
      ["orphan", { contract: { dependencies: ["ghost"] }, state: "pending" }],
      ["done", { contract: { dependencies: [] }, state: "succeeded" }],
    ]),
  };
  assert.deepEqual(readyTaskIds(plan), []);
});

test("dispatchTask validates adapters and resolveModel output", async () => {
  const valid = task("adapter");
  await assert.rejects(
    () => dispatchTask(valid, { resolveModel: async () => "model" }),
    /worker must be a function/,
  );
  await assert.rejects(
    () => dispatchTask(valid, { worker: async () => ({}) }),
    /resolveModel must be a function/,
  );
  await assert.rejects(
    () => dispatchTask(valid, { worker: async () => ({}), resolveModel: async () => 42 }),
    /non-empty model identifier/,
  );
  await assert.rejects(
    () => dispatchTask(valid, { worker: async () => ({}), resolveModel: async () => "   " }),
    /non-empty model identifier/,
  );
});

test("dispatchTask propagates cancellation from the caller signal", async () => {
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const pending = dispatchTask(task("abort-me"), {
    worker: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          {
            once: true,
          },
        );
      }),
    resolveModel: async () => {
      markStarted();
      return "model";
    },
    signal: controller.signal,
  });
  await started;
  controller.abort("stop now");
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("dispatchTask surfaces worker failures", async () => {
  await assert.rejects(
    () =>
      dispatchTask(task("boom"), {
        worker: async () => {
          throw new Error("worker exploded");
        },
        resolveModel: async () => "model",
      }),
    /worker exploded/,
  );
});

test("dispatchReadyBatch validates the verifier and batch bounds", async () => {
  const plan = createPlan([task("one")]);
  await assert.rejects(
    () => dispatchReadyBatch(plan, { resolveModel: async () => "model", worker: async () => ({}) }),
    /independent verifier/,
  );
  for (const maxParallel of [0, 33, 1.5]) {
    await assert.rejects(
      () =>
        dispatchReadyBatch(plan, {
          resolveModel: async () => "model",
          worker: async () => ({}),
          verify: async () => ({ ok: true }),
          maxParallel,
        }),
      /maxParallel/,
    );
  }
});

test("dispatchReadyBatch short-circuits when already cancelled", async () => {
  const plan = createPlan([task("one")]);
  const result = await dispatchReadyBatch(plan, {
    verify: async () => ({ ok: true }),
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(result, { dispatched: [], cancelled: true });
});

test("dispatchReadyBatch rejects malformed verifier results", async () => {
  for (const verification of [null, { ok: "yes" }]) {
    const plan = createPlan([task("one")]);
    const result = await dispatchReadyBatch(plan, {
      resolveModel: async () => "model",
      worker: async () => ({ result: "ok" }),
      verify: async () => verification,
    });
    assert.equal(result.dispatched[0].state, "failed");
    assert.match(result.dispatched[0].error.message, /boolean ok/);
  }
});

test("dispatchReadyBatch records verifier exceptions and non-Error rejections", async () => {
  const thrower = createPlan([task("throws")]);
  const thrown = await dispatchReadyBatch(thrower, {
    resolveModel: async () => "model",
    worker: async () => ({ result: "ok" }),
    verify: async () => {
      throw new Error("verifier exploded");
    },
  });
  assert.equal(thrown.dispatched[0].state, "failed");
  assert.equal(thrown.dispatched[0].error.name, "Error");
  assert.equal(thrown.dispatched[0].error.message, "verifier exploded");

  const plain = createPlan([task("plain")]);
  const rejected = await dispatchReadyBatch(plain, {
    resolveModel: async () => "model",
    worker: async () => ({ result: "ok" }),
    verify: async () => Promise.reject("plain failure"),
  });
  assert.equal(rejected.dispatched[0].state, "failed");
  assert.equal(rejected.dispatched[0].error.name, "Error");
  assert.equal(rejected.dispatched[0].error.message, "plain failure");
});

test("independent verification is bounded by the task timeout", async () => {
  const bounded = task("verify-timeout");
  bounded.budget.timeoutMs = 20;
  const plan = createPlan([bounded]);
  const result = await dispatchReadyBatch(plan, {
    resolveModel: async () => "model",
    worker: async () => ({ result: "ok" }),
    verify: () => new Promise(() => {}),
  });
  assert.equal(result.dispatched[0].state, "failed");
  assert.equal(result.dispatched[0].error.name, "TimeoutError");
});

test("cancellation during verification cancels the task", async () => {
  const plan = createPlan([task("cancel-verify")]);
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const pending = dispatchReadyBatch(plan, {
    resolveModel: async () => "model",
    worker: async () => ({ result: "ok" }),
    verify: () => {
      markStarted();
      return new Promise(() => {});
    },
    signal: controller.signal,
  });
  await started;
  controller.abort("owner stopped");
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(plan.tasks.get("cancel-verify").state, "cancelled");
});

test("normalizeMemoryReceipt is strict about shape and identity", () => {
  assert.ok(normalizeMemoryReceipt(receipt()));
  assert.ok(normalizeMemoryReceipt(receipt({ includedCount: undefined })));

  const rejected = [
    null,
    [],
    {},
    { ...receipt(), schemaVersion: 3 },
    { ...receipt(), turnId: 5 },
    { ...receipt(), turnId: "" },
    { ...receipt(), turnId: "x".repeat(129) },
    { ...receipt(), status: "maybe" },
    { ...receipt(), resultCount: 1.5 },
    { ...receipt(), resultCount: -1 },
    { ...receipt(), includedCount: 1.5 },
    { ...receipt(), includedCount: -1 },
    { ...receipt(), sources: null },
    { ...receipt(), sources: { ...receipt().sources, searched: "main" } },
    { ...receipt(), sources: { ...receipt().sources, searched: ["unknown-source"] } },
    { ...receipt(), sources: { ...receipt().sources, searched: ["main", "main"] } },
    { ...receipt(), warnings: "nope" },
    { ...receipt(), warnings: Array.from({ length: 6 }, () => "w") },
    { ...receipt(), warnings: [1] },
    { ...receipt(), warnings: ["x".repeat(257)] },
    { ...receipt(), conflicts: "nope" },
    { ...receipt(), truncated: "no" },
    { ...receipt(), partialCoverage: "no" },
    { ...receipt(), noContentIncluded: "no" },
  ];
  for (const candidate of rejected) {
    assert.equal(normalizeMemoryReceipt(candidate), null);
  }
});

test("normalizeMemoryReceipt enforces source coverage and status consistency", () => {
  const sparse = receipt();
  sparse.sources = {
    searched: ["main"],
    absent: [],
    unavailable: [],
    notSearched: [],
    unknownCoverage: [],
  };

  const rejected = [
    sparse,
    receipt({ status: "found", resultCount: 0, includedCount: 0 }),
    receipt({ status: "absent", resultCount: 1 }),
    receipt({ status: "conflicting", conflicts: [] }),
    receipt({ status: "found", conflicts: ["conflict"] }),
    receipt({ status: "unavailable", resultCount: 1 }),
    receipt({ partialCoverage: true, sources: { ...receipt().sources, searched: [] } }),
  ];
  for (const candidate of rejected) {
    assert.equal(normalizeMemoryReceipt(candidate), null);
  }

  const conflicting = receipt({ status: "conflicting", conflicts: ["a", "b"] });
  assert.equal(normalizeMemoryReceipt(conflicting)?.status, "conflicting");

  const unknown = receipt({
    partialCoverage: true,
    sources: {
      searched: [],
      absent: [],
      unavailable: [],
      notSearched: [],
      unknownCoverage: ["main", "archive", "documents"],
    },
  });
  assert.equal(normalizeMemoryReceipt(unknown)?.partialCoverage, true);
});

test("createMemoryEvidenceBrief bounds its input and fails closed", () => {
  assert.throws(() => createMemoryEvidenceBrief(null, "text", { maxChars: 0 }), /maxChars/);
  assert.throws(() => createMemoryEvidenceBrief(null, "text", { maxChars: 20001 }), /maxChars/);
  assert.throws(() => createMemoryEvidenceBrief(null, "text", { maxChars: 1.5 }), /maxChars/);

  assert.equal(
    createMemoryEvidenceBrief(receipt({ noContentIncluded: true }), "text").evidence,
    null,
  );
  assert.equal(createMemoryEvidenceBrief(receipt(), 123).evidence, null);
  assert.equal(createMemoryEvidenceBrief(receipt(), "   ").evidence, null);

  const conflicting = createMemoryEvidenceBrief(
    receipt({ status: "conflicting", conflicts: ["a", "b"] }),
    "conflict text",
  );
  assert.equal(conflicting.status, "conflicting");
  assert.equal(conflicting.evidence.trust, "untrusted-evidence");

  const truncated = createMemoryEvidenceBrief(receipt({ truncated: true }), "short");
  assert.equal(truncated.evidence.truncated, true);
});

test("createWorkerBrief enforces structural limits and preserves dependencies", () => {
  assert.throws(() => createWorkerBrief(task("brief"), { maxChars: 0 }), /maxChars/);
  assert.throws(() => createWorkerBrief(task("brief"), { maxChars: 24001 }), /maxChars/);
  assert.throws(() => createWorkerBrief(task("brief"), { maxChars: 1.5 }), /maxChars/);

  const longGoal = task("long-goal");
  longGoal.goal = "g".repeat(4001);
  assert.throws(() => createWorkerBrief(longGoal), /structural limits/);

  const manyCriteria = task("many-criteria");
  manyCriteria.successCriteria = Array.from({ length: 21 }, (_, index) => `criterion-${index}`);
  assert.throws(() => createWorkerBrief(manyCriteria), /structural limits/);

  const manyTools = task("many-tools");
  manyTools.allowedTools = Array.from({ length: 33 }, (_, index) => `tool-${index}`);
  assert.throws(() => createWorkerBrief(manyTools), /structural limits/);

  const brief = createWorkerBrief(task("with-dep", ["dep"]));
  assert.deepEqual(brief.task.dependencies, ["dep"]);
});

test("cancelPlan leaves terminal tasks untouched", () => {
  const plan = createPlan([task("done"), task("waiting")]);
  transitionTask(plan, "done", "ready");
  transitionTask(plan, "done", "running");
  transitionTask(plan, "done", "verifying");
  transitionTask(plan, "done", "succeeded");
  cancelPlan(plan);
  assert.equal(plan.tasks.get("done").state, "succeeded");
  assert.equal(plan.tasks.get("waiting").state, "cancelled");
});
