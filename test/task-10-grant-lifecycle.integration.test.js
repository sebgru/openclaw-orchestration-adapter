// LOCAL FAKE-HOST EVIDENCE ONLY (tracker Tasks 10.4 and 10.6). This drives the
// real plugin.register(), the registered before_tool_call hook, ToolGuard, the
// guard-bound worker and dispatchTask/dispatchReadyBatch over a fake
// `api.runtime.subagent`. Tool calls are injected through the captured hook while
// the fake run is "in flight". It is NOT live Gateway acceptance, does not use
// host core tools, does not prove host-side run cancellation, and says nothing
// about Gateway restart behavior. All names and values are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { DENIAL_REASONS, createPlan, plugin, getOrchestration } from "../src/index.js";

const TOOL = "fixture_plugin_tool";
const GRANTED_PARAMS = { action: "read", target: "synthetic-doc" };
const SCOPE = { tenantId: "t", channel: "c", conversationId: "d" };

function task(over = {}) {
  return {
    contractVersion: 1,
    id: "grant-task",
    goal: "synthetic goal",
    successCriteria: ["done"],
    allowedTools: [TOOL],
    allowedCalls: [{ toolName: TOOL, params: GRANTED_PARAMS }],
    prohibitedActions: [],
    routeTier: "standard",
    budget: { maxCalls: 5, maxTokens: 100, timeoutMs: 2000, maxRetries: 0 },
    scope: SCOPE,
    outputSchema: { type: "object" },
    ...over,
  };
}

/**
 * Fake host. `during(ctx)` runs between admission and waitForRun completion, with
 * a `call()` helper that sends an event through the registered hook exactly as
 * the host would. `waitStatus` is the terminal status waitForRun reports.
 */
function fakeHost({ during, waitStatus = "ok" } = {}) {
  const hooks = [];
  const state = { sessionKey: null, runId: "run-fixture-1", deleted: [] };
  const api = {
    on: (name, handler, opts) => hooks.push({ name, handler, opts }),
    pluginConfig: {
      enabled: true,
      agentId: "main",
      workerRoutes: { standard: ["example/fake-standard"] },
    },
    runtime: {
      subagent: {
        async run(args) {
          state.sessionKey = args.sessionKey;
          return { runId: state.runId, sessionKey: args.sessionKey };
        },
        async waitForRun() {
          await during?.(ctx);
          return { status: waitStatus };
        },
        async getSessionMessages() {
          return { messages: [{ role: "assistant", content: "worker done" }] };
        },
        async deleteSession(args) {
          state.deleted.push(args.sessionKey);
        },
      },
    },
  };
  const ctx = {
    state,
    async call(event, { sessionKey = state.sessionKey, runId = state.runId } = {}) {
      const hook = hooks.find((h) => h.name === "before_tool_call").handler;
      return hook({ toolName: TOOL, runId, ...event }, { sessionKey });
    },
  };
  plugin.register(api);
  const handle = getOrchestration(api);
  // The default guard is process-shared across registrations, so scope denial
  // history to this host instance.
  const baseline = handle.guard.denials.length;
  ctx.denied = () => handle.guard.denials.slice(baseline).map((d) => d.reason);
  return { api, hooks, ctx, handle };
}

const run = (handle, t = task()) =>
  handle.dispatchTask(t, { resolveModel: () => "example/fake-standard" });

test("10.4 registers a before_tool_call hook on the plugin's public path", () => {
  const { hooks, handle } = fakeHost();
  assert.deepEqual(
    hooks.map((h) => h.name),
    ["before_tool_call"],
  );
  assert.ok(handle.guard);
});

test("10.4 allowed call with exact granted params passes", async () => {
  const results = [];
  const host = fakeHost({
    during: async (c) => {
      results.push(await c.call({ toolCallId: "c1", params: { ...GRANTED_PARAMS } }));
    },
  });
  const out = await run(host.handle);
  assert.deepEqual(results, [{}]);
  assert.equal(out.output.text, "worker done");
  assert.deepEqual(host.ctx.denied(), []);
});

test("10.4 missing, altered, extra, and out-of-grant calls are blocked with distinct reasons", async () => {
  const results = {};
  const host = fakeHost({
    during: async (c) => {
      results.missing = await c.call({ toolCallId: "m", params: { action: "read" } });
      results.altered = await c.call({
        toolCallId: "a",
        params: { action: "read", target: "other-doc" },
      });
      results.extra = await c.call({
        toolCallId: "e",
        params: { ...GRANTED_PARAMS, extra: true },
      });
      results.noParams = await c.call({ toolCallId: "n" });
      results.otherTool = await c.call({
        toolName: "fixture_other_tool",
        toolCallId: "o",
        params: { ...GRANTED_PARAMS },
      });
      results.delegation = await c.call({
        toolName: "sessions_spawn",
        toolCallId: "d",
        params: {},
      });
      // A valid call after the denials still works and the denials were not charged.
      results.valid = await c.call({ toolCallId: "v", params: { ...GRANTED_PARAMS } });
    },
  });
  await run(host.handle);
  for (const key of ["missing", "altered", "extra", "noParams", "otherTool", "delegation"]) {
    assert.equal(results[key].block, true, key);
    assert.match(results[key].blockReason, /^orchestration-adapter: /, key);
  }
  assert.deepEqual(results.valid, {});
  assert.deepEqual(host.ctx.denied(), [
    DENIAL_REASONS.ARGUMENTS_NOT_ALLOWLISTED,
    DENIAL_REASONS.ARGUMENTS_NOT_ALLOWLISTED,
    DENIAL_REASONS.ARGUMENTS_NOT_ALLOWLISTED,
    DENIAL_REASONS.ARGUMENTS_NOT_ALLOWLISTED,
    DENIAL_REASONS.NOT_GRANTED,
    DENIAL_REASONS.DELEGATION,
  ]);
});

test("10.4 reusing a call id with different params is blocked and wrong run id is blocked", async () => {
  const results = {};
  const host = fakeHost({
    during: async (c) => {
      results.first = await c.call({ toolCallId: "same", params: { ...GRANTED_PARAMS } });
      results.reuse = await c.call({
        toolCallId: "same",
        params: { action: "read", target: "swapped" },
      });
      results.wrongRun = await c.call(
        { toolCallId: "w", params: { ...GRANTED_PARAMS } },
        { runId: "run-other" },
      );
    },
  });
  await run(host.handle);
  assert.deepEqual(results.first, {});
  assert.equal(results.reuse.block, true);
  assert.equal(results.wrongRun.block, true);
  assert.deepEqual(host.ctx.denied(), [DENIAL_REASONS.CALL_ID_REUSE, DENIAL_REASONS.RUN_MISMATCH]);
});

test("10.4 call budget is enforced for the grant", async () => {
  const results = [];
  const host = fakeHost({
    during: async (c) => {
      for (const id of ["b1", "b2", "b3"]) {
        results.push(await c.call({ toolCallId: id, params: { ...GRANTED_PARAMS } }));
      }
    },
  });
  await run(
    host.handle,
    task({ budget: { maxCalls: 2, maxTokens: 100, timeoutMs: 2000, maxRetries: 0 } }),
  );
  assert.deepEqual(results.slice(0, 2), [{}, {}]);
  assert.equal(results[2].block, true);
  assert.equal(host.ctx.denied().at(-1), DENIAL_REASONS.CALL_BUDGET);
});

test("10.4 delegation tools can never be granted, so no worker is started", async () => {
  const host = fakeHost();
  await assert.rejects(
    run(
      host.handle,
      task({
        allowedTools: ["sessions_spawn"],
        allowedCalls: [{ toolName: "sessions_spawn", params: {} }],
      }),
    ),
    /delegation tools cannot be granted/,
  );
  assert.equal(host.ctx.state.sessionKey, null);
  assert.equal(host.handle.guard.size, 0);
});

test("10.6 failed worker run releases authority, blocks later calls, and surfaces the terminal error", async () => {
  const during = {};
  const host = fakeHost({
    waitStatus: "error",
    during: async (c) => {
      during.live = await c.call({ toolCallId: "pre", params: { ...GRANTED_PARAMS } });
      during.sizeLive = host.handle.guard.size;
    },
  });
  await assert.rejects(run(host.handle), /worker run ended with status error/);
  assert.deepEqual(during.live, {});
  assert.equal(during.sizeLive, 1);
  assert.equal(host.handle.guard.size, 0);
  assert.deepEqual(host.ctx.state.deleted, [host.ctx.state.sessionKey]);

  // The still-"running" host session tries the exact granted call after failure.
  const late = await host.ctx.call({ toolCallId: "late", params: { ...GRANTED_PARAMS } });
  assert.equal(late.block, true);
  assert.equal(host.ctx.denied().at(-1), DENIAL_REASONS.WRONG_SESSION);
});

test("10.6 timeout/cancelled statuses and thrown run errors also release authority", async () => {
  for (const waitStatus of ["timeout", "cancelled"]) {
    const host = fakeHost({ waitStatus });
    await assert.rejects(run(host.handle), new RegExp(`status ${waitStatus}`));
    assert.equal(host.handle.guard.size, 0, waitStatus);
    const late = await host.ctx.call({ toolCallId: "x", params: { ...GRANTED_PARAMS } });
    assert.equal(late.block, true, waitStatus);
  }
  const host = fakeHost();
  host.api.runtime.subagent.run = async () => {
    throw new Error("admission failed");
  };
  await assert.rejects(run(host.handle), /admission failed/);
  assert.equal(host.handle.guard.size, 0);
});

test("10.6 failed run records a terminal failed state in the plan and does not leak authority", async () => {
  const lifecycle = [];
  const host = fakeHost({ waitStatus: "error" });
  host.handle.guard.setOnLifecycle((e) => lifecycle.push(e));
  const plan = createPlan([task()]);
  const result = await host.handle.dispatchReadyBatch(plan, {
    verify: async () => {
      throw new Error("verifier must not run for a failed worker");
    },
  });
  assert.equal(result.dispatched.length, 1);
  assert.equal(result.dispatched[0].state, "failed");
  assert.match(result.dispatched[0].error.message, /status error/);
  assert.equal(plan.tasks.get("grant-task").state, "failed");
  assert.equal(plan.tasks.get("grant-task").failureReason, "Error");
  assert.equal(host.handle.guard.size, 0);
  const released = lifecycle.find((e) => e.event === "binding_released");
  assert.equal(released.reason, "failed");
  assert.ok(lifecycle.some((e) => e.event === "worker_ended" && e.reason === "failed"));
  const late = await host.ctx.call({ toolCallId: "late", params: { ...GRANTED_PARAMS } });
  assert.equal(late.block, true);
});
