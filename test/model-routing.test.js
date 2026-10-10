import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_ONLY_WORKER_MODELS,
  DEFAULT_WORKER_ROUTES,
  WORKER_MODELS,
  assertWorkerModel,
  createPlan,
  createWorkerModelResolver,
  dispatchTask,
  normalizeWorkerRoutes,
  plugin,
  getOrchestration,
  registerOrchestration,
  validateTask,
} from "../src/index.js";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));

const ASTRA = "openai/gpt-6-astra";
const REJECTED = [
  "deepseek/deepseek-v4-flash",
  "openrouter/z-ai/glm-5.3-flash",
  "openrouter/xiaomi/mimo-v2.5-pro",
  "openrouter/perplexity/sonar-pro",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "ollama/qwen-coder",
  "openai/gpt-4o-mini-transcribe",
  "gpt-6-luna",
  "",
  undefined,
  42,
];

function task(over = {}) {
  return {
    contractVersion: 1,
    id: "t1",
    goal: "do it",
    successCriteria: ["done"],
    allowedTools: ["read"],
    prohibitedActions: [],
    routeTier: "standard",
    budget: { maxCalls: 2, timeoutMs: 1000, maxRetries: 0 },
    scope: { tenantId: "a", channel: "c", conversationId: "d" },
    outputSchema: { type: "object" },
    ...over,
  };
}

function fakeApi(pluginConfig) {
  const hooks = [];
  const calls = [];
  const subagent = {
    async complete(a) {
      calls.push(["complete", a]);
      return { text: "ok" };
    },
    async run(a) {
      calls.push(["run", a]);
      return { runId: "run-1", sessionKey: a.sessionKey };
    },
    async waitForRun() {
      return { status: "ok" };
    },
    async getSessionMessages() {
      return { messages: [{ role: "assistant", content: "done" }] };
    },
    async deleteSession() {},
  };
  return {
    api: { on: (...a) => hooks.push(a), runtime: { subagent }, pluginConfig },
    hooks,
    calls,
  };
}

test("allow-list is exactly the five subscription worker models; Astra is approval-only", () => {
  assert.deepEqual([...WORKER_MODELS].sort(), [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-opus-5-5",
    "anthropic/claude-sonnet-5-5",
    "openai/gpt-6-luna",
    "openai/gpt-6-sol",
  ]);
  assert.deepEqual([...APPROVAL_ONLY_WORKER_MODELS], [ASTRA]);
  for (const list of Object.values(DEFAULT_WORKER_ROUTES)) {
    assert.ok(!list.includes(ASTRA));
    for (const model of list) assert.ok(WORKER_MODELS.includes(model));
  }
});

test("each tier resolves to its documented primary model", async () => {
  const resolve = createWorkerModelResolver();
  assert.equal(await resolve("cheap", task()), "anthropic/claude-haiku-4-5");
  assert.equal(await resolve("standard", task()), "openai/gpt-6-luna");
  assert.equal(await resolve("strong", task()), "openai/gpt-6-sol");
});

test("each tier falls back only within its own allow-listed candidates", async () => {
  const down = new Set(["anthropic/claude-haiku-4-5", "openai/gpt-6-luna", "openai/gpt-6-sol"]);
  const seen = [];
  const resolve = createWorkerModelResolver({
    isAvailable: async (model, ctx) => {
      seen.push([model, ctx.tier, ctx.taskId]);
      return !down.has(model);
    },
  });
  assert.equal(await resolve("standard", task()), "anthropic/claude-sonnet-5-5");
  assert.equal(await resolve("strong", task()), "anthropic/claude-opus-5-5");
  await assert.rejects(resolve("cheap", task()), { name: "WorkerRouteError", code: "unavailable" });
  assert.deepEqual(seen[0], ["openai/gpt-6-luna", "standard", "t1"]);
  // Only true counts as available; truthy non-boolean values fail closed.
  const truthy = createWorkerModelResolver({ isAvailable: () => "yes" });
  await assert.rejects(truthy("standard", task()), /no allowed worker model/);
});

test("unknown tiers are rejected", async () => {
  const resolve = createWorkerModelResolver();
  for (const tier of ["expert", "", undefined, "astra"]) {
    await assert.rejects(resolve(tier, task()), { code: "unknown-tier" });
  }
});

test("explicit task.model is honored only for allow-listed models", async () => {
  const resolve = createWorkerModelResolver();
  for (const model of WORKER_MODELS) {
    assert.equal(await resolve("cheap", task({ model })), model);
  }
  for (const model of REJECTED.filter((m) => typeof m === "string" && m)) {
    await assert.rejects(resolve("standard", task({ model })), { code: "model-not-allowed" });
  }
  const offline = createWorkerModelResolver({ isAvailable: () => false });
  await assert.rejects(offline("strong", task({ model: "openai/gpt-6-sol" })), {
    code: "unavailable",
  });
});

test("Astra is never auto-selected and needs a matching per-task approval", async () => {
  const plain = createWorkerModelResolver();
  for (const tier of ["cheap", "standard", "strong"]) {
    assert.notEqual(await plain(tier, task()), ASTRA);
  }
  await assert.rejects(plain("strong", task({ model: ASTRA })), { code: "approval-required" });

  const approvedOther = createWorkerModelResolver({
    modelApprovals: [{ taskId: "other", model: ASTRA }],
  });
  await assert.rejects(approvedOther("strong", task({ model: ASTRA })), {
    code: "approval-required",
  });
  // An approval does not make Astra a tier candidate.
  assert.equal(await approvedOther("strong", task({ id: "other" })), "openai/gpt-6-sol");

  const approved = createWorkerModelResolver({ modelApprovals: [{ taskId: "t1", model: ASTRA }] });
  assert.equal(await approved("strong", task({ model: ASTRA })), ASTRA);
});

test("approvals only cover approval-only models and must be well-formed", () => {
  for (const modelApprovals of [
    "t1",
    [null],
    [{ taskId: "", model: ASTRA }],
    [{ taskId: "t1", model: "deepseek/deepseek-v4-flash" }],
    [{ taskId: "t1", model: "openai/gpt-6-sol" }],
  ]) {
    assert.throws(() => createWorkerModelResolver({ modelApprovals }), TypeError);
  }
  assert.throws(() => createWorkerModelResolver({ isAvailable: true }), /isAvailable/);
});

test("assertWorkerModel guards any model, including caller-resolved ones", () => {
  for (const model of WORKER_MODELS) assert.equal(assertWorkerModel(model, {}), model);
  for (const model of REJECTED) {
    assert.throws(() => assertWorkerModel(model, { task: task() }), { code: "model-not-allowed" });
  }
  assert.throws(() => assertWorkerModel(ASTRA), /\(unknown\)/);
  assert.equal(
    assertWorkerModel(ASTRA, { task: task(), modelApprovals: [{ taskId: "t1", model: ASTRA }] }),
    ASTRA,
  );
});

test("route overrides may narrow or reorder the allow-list but never extend it", () => {
  assert.equal(normalizeWorkerRoutes(), DEFAULT_WORKER_ROUTES);
  const narrowed = normalizeWorkerRoutes({ strong: ["openai/gpt-6-sol"] });
  assert.deepEqual(narrowed.strong, ["openai/gpt-6-sol"]);
  assert.deepEqual(narrowed.cheap, DEFAULT_WORKER_ROUTES.cheap);
  for (const routes of [
    null,
    [],
    { expert: ["openai/gpt-6-sol"] },
    { cheap: [] },
    { cheap: "anthropic/claude-haiku-4-5" },
    { cheap: ["openai/gpt-6-luna", "openai/gpt-6-luna"] },
    { strong: [ASTRA] },
    { cheap: ["deepseek/deepseek-v4-flash"] },
    { standard: ["anthropic/claude-sonnet-5"] },
  ]) {
    assert.throws(() => normalizeWorkerRoutes(routes), TypeError);
  }
});

test("task contract accepts an optional non-empty model reference", () => {
  assert.deepEqual(validateTask(task({ model: "openai/gpt-6-sol" })), []);
  assert.match(validateTask(task({ model: " " })).join(), /model must be/);
});

test("library dispatchTask uses the resolver and rejects unapproved models before the worker runs", async () => {
  let ran = false;
  const worker = async () => {
    ran = true;
    return {};
  };
  const out = await dispatchTask(task({ routeTier: "strong" }), {
    worker,
    resolveModel: createWorkerModelResolver(),
  });
  assert.equal(out.model, "openai/gpt-6-sol");
  ran = false;
  await assert.rejects(
    dispatchTask(task({ model: ASTRA }), { worker, resolveModel: createWorkerModelResolver() }),
    { name: "WorkerRouteError" },
  );
  assert.equal(ran, false);
});

test("plugin registers no model-resolution hook and routes workers by tier by default", async () => {
  const { api, hooks, calls } = fakeApi({ enabled: true, agentId: "main" });
  plugin.register(api);
  assert.deepEqual(
    hooks.map((h) => h[0]),
    ["before_tool_call"],
  );
  const handle = getOrchestration(api);
  const out = await handle.dispatchTask(task({ routeTier: "cheap" }));
  assert.equal(out.model, "anthropic/claude-haiku-4-5");
  const run = calls.find((c) => c[0] === "run")[1];
  assert.equal(run.provider, "anthropic");
  assert.equal(run.model, "claude-haiku-4-5");
});

test("plugin config workerRoutes is validated at registration and applied", async () => {
  const { api } = fakeApi({
    enabled: true,
    agentId: "main",
    workerRoutes: { standard: ["anthropic/claude-sonnet-5-5"] },
  });
  plugin.register(api);
  const out = await getOrchestration(api).dispatchTask(task());
  assert.equal(out.model, "anthropic/claude-sonnet-5-5");

  const bad = fakeApi({ enabled: true, workerRoutes: { strong: [ASTRA] } });
  assert.throws(() => plugin.register(bad.api), /approval-only/);
  assert.equal(bad.hooks.length, 0);
});

test("handle rejects non-subscription models from a caller resolver before any runtime call", async () => {
  const { api, calls } = fakeApi({ enabled: true, agentId: "main" });
  const handle = registerOrchestration(api, { agentId: "main" });
  for (const model of ["deepseek/deepseek-v4-flash", "openrouter/z-ai/glm-5.3-flash", ASTRA]) {
    await assert.rejects(handle.dispatchTask(task(), { resolveModel: () => model }), {
      name: "WorkerRouteError",
    });
  }
  assert.equal(calls.length, 0);
  assert.equal(handle.guard.size, 0);

  const approvals = [{ taskId: "t1", model: ASTRA }];
  const out = await handle.dispatchTask(task({ model: ASTRA }), { modelApprovals: approvals });
  assert.equal(out.model, ASTRA);
});

test("dispatchReadyBatch through the handle uses the worker resolver", async () => {
  const { api } = fakeApi({ enabled: true, agentId: "main" });
  const handle = registerOrchestration(api, { agentId: "main" });
  const plan = createPlan([task({ routeTier: "strong" })]);
  const result = await handle.dispatchReadyBatch(plan, { verify: async () => ({ ok: true }) });
  assert.equal(result.dispatched[0].model, "openai/gpt-6-sol");
  assert.equal(result.dispatched[0].state, "succeeded");
});

test("manifest workerRoutes schema enumerates only auto-selectable models", () => {
  const schema = manifest.configSchema.properties.workerRoutes;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["cheap", "standard", "strong"]);
  for (const tier of Object.values(schema.properties)) {
    assert.deepEqual([...tier.items.enum].sort(), [...WORKER_MODELS].sort());
    assert.ok(!tier.items.enum.includes(ASTRA));
  }
});
