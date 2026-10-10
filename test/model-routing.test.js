import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WORKER_ROUTES,
  ROUTE_TIERS,
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
const POOL = Object.freeze({
  priority: ["example/priority"],
  cheap: ["example/cheap"],
  standard: ["example/preferred-standard", "example/alternate-standard"],
  strong: ["example/preferred-strong", "example/alternate-strong"],
});
const UNKNOWN_MODEL = "example/not-configured";

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

test("package defines route tiers but no provider/model defaults", () => {
  assert.deepEqual(ROUTE_TIERS, ["priority", "cheap", "standard", "strong"]);
  assert.deepEqual(DEFAULT_WORKER_ROUTES, {});
  assert.deepEqual(normalizeWorkerRoutes(), {});
});

test("configured route arrays are ordered candidate pools and become the allow-list", async () => {
  const resolve = createWorkerModelResolver({ routes: POOL });
  assert.equal(await resolve("priority", task({ routeTier: "priority" })), "example/priority");
  assert.equal(await resolve("cheap", task({ routeTier: "cheap" })), "example/cheap");
  assert.equal(await resolve("standard", task()), "example/preferred-standard");
  assert.equal(await resolve("strong", task({ routeTier: "strong" })), "example/preferred-strong");
  assert.equal(
    assertWorkerModel("example/alternate-standard", { routes: POOL }),
    "example/alternate-standard",
  );
  assert.throws(() => assertWorkerModel(UNKNOWN_MODEL, { routes: POOL }), {
    code: "model-not-allowed",
  });
  assert.throws(
    () => assertWorkerModel("example/preferred-strong", { routes: POOL, tier: "standard" }),
    { code: "model-not-allowed" },
  );
});

test("availability selection picks the highest-ranked available candidate once", async () => {
  const seen = [];
  const resolve = createWorkerModelResolver({
    routes: POOL,
    isAvailable: async (model, ctx) => {
      seen.push([model, ctx.tier, ctx.taskId]);
      return model === "example/alternate-standard";
    },
  });
  assert.equal(await resolve("standard", task()), "example/alternate-standard");
  assert.deepEqual(seen, [
    ["example/preferred-standard", "standard", "t1"],
    ["example/alternate-standard", "standard", "t1"],
  ]);
  const offline = createWorkerModelResolver({ routes: POOL, isAvailable: () => false });
  await assert.rejects(offline("standard", task()), { code: "unavailable" });
});

test("resolver does not select an unconfigured pool, model, or tier", async () => {
  const resolve = createWorkerModelResolver({ routes: POOL });
  await assert.rejects(resolve("unknown", task()), { code: "unknown-tier" });
  await assert.rejects(createWorkerModelResolver()("priority", task({ routeTier: "priority" })), {
    code: "unavailable",
  });
  await assert.rejects(resolve("standard", task({ model: UNKNOWN_MODEL })), {
    code: "model-not-allowed",
  });
  await assert.rejects(
    resolve("cheap", task({ routeTier: "cheap", model: "example/preferred-standard" })),
    { code: "model-not-allowed" },
  );
  assert.throws(
    () => createWorkerModelResolver({ routes: POOL, isAvailable: true }),
    /isAvailable/,
  );
});

test("resolver honors an explicit in-pool task model and its availability", async () => {
  const resolve = createWorkerModelResolver({ routes: POOL });
  assert.equal(
    await resolve("standard", task({ model: "example/alternate-standard" })),
    "example/alternate-standard",
  );
  const offline = createWorkerModelResolver({
    routes: POOL,
    isAvailable: async (model) => model !== "example/alternate-standard",
  });
  await assert.rejects(offline("standard", task({ model: "example/alternate-standard" })), {
    code: "unavailable",
  });
});

test("route configuration validates tier names, lists, entries, and duplicates", () => {
  for (const routes of [
    null,
    [],
    { expert: ["example/model"] },
    { cheap: [] },
    { cheap: "example/model" },
    { cheap: ["example/model", "example/model"] },
    { cheap: [""] },
  ])
    assert.throws(() => normalizeWorkerRoutes(routes), TypeError);
  assert.deepEqual(normalizeWorkerRoutes({ strong: ["example/a"] }).strong, ["example/a"]);
});

test("task contract accepts the priority tier and an optional model reference", () => {
  assert.deepEqual(validateTask(task({ routeTier: "priority", model: "example/model" })), []);
  assert.match(validateTask(task({ model: " " })).join(), /model must be/);
});

test("library dispatch uses its explicitly supplied resolver", async () => {
  let ran = false;
  const worker = async () => {
    ran = true;
    return {};
  };
  const out = await dispatchTask(task({ routeTier: "strong" }), {
    worker,
    resolveModel: createWorkerModelResolver({ routes: POOL }),
  });
  assert.equal(out.model, "example/preferred-strong");
  assert.equal(ran, true);
});

test("plugin applies deployment routes and invokes one selected model", async () => {
  const { api, hooks, calls } = fakeApi({ enabled: true, agentId: "main", workerRoutes: POOL });
  plugin.register(api);
  assert.deepEqual(
    hooks.map((h) => h[0]),
    ["before_tool_call"],
  );
  const out = await getOrchestration(api).dispatchTask(task());
  assert.equal(out.model, "example/preferred-standard");
  assert.equal(calls.filter((c) => c[0] === "run").length, 1);
});

test("plugin validates route config before registering hooks", () => {
  const bad = fakeApi({ enabled: true, workerRoutes: { standard: [] } });
  assert.throws(() => plugin.register(bad.api), /non-empty array/);
  assert.equal(bad.hooks.length, 0);
});

test("handle rejects caller-resolved models outside configured pools before runtime calls", async () => {
  const { api, calls } = fakeApi({ enabled: true, agentId: "main", workerRoutes: POOL });
  const handle = registerOrchestration(api, { agentId: "main", workerRoutes: POOL });
  await assert.rejects(handle.dispatchTask(task(), { resolveModel: () => UNKNOWN_MODEL }), {
    name: "WorkerRouteError",
  });
  await assert.rejects(
    handle.dispatchTask(task(), { resolveModel: () => "example/preferred-strong" }),
    {
      name: "WorkerRouteError",
    },
  );
  assert.equal(calls.length, 0);
  assert.equal(handle.guard.size, 0);
});

test("dispatchReadyBatch uses the configured worker pool", async () => {
  const { api } = fakeApi({ enabled: true, agentId: "main", workerRoutes: POOL });
  const handle = registerOrchestration(api, { agentId: "main", workerRoutes: POOL });
  const plan = createPlan([task({ routeTier: "strong" })]);
  const result = await handle.dispatchReadyBatch(plan, { verify: async () => ({ ok: true }) });
  assert.equal(result.dispatched[0].model, "example/preferred-strong");
  assert.equal(result.dispatched[0].state, "succeeded");
});

test("manifest exposes all route tiers as configurable model-reference pools", () => {
  const schema = manifest.configSchema.properties.workerRoutes;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...ROUTE_TIERS].sort());
  for (const tier of Object.values(schema.properties)) {
    assert.equal(tier.items.type, "string");
    assert.equal(tier.items.minLength, 1);
  }
});
