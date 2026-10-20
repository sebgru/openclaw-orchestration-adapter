import test from "node:test";
import assert from "node:assert/strict";
import { DENIAL_REASONS, getOrchestration, plugin } from "../src/index.js";

const TOOL = "unified_memory_search";

function task(over = {}) {
  return {
    contractVersion: 1,
    id: "t",
    goal: "search memory in a chain",
    successCriteria: ["done"],
    allowedTools: [TOOL],
    prohibitedActions: [],
    routeTier: "standard",
    budget: { maxCalls: 3, maxTokens: 100, timeoutMs: 1000, maxRetries: 0 },
    scope: { tenantId: "a", channel: "c", conversationId: "d" },
    outputSchema: { type: "object" },
    ...over,
  };
}

// The real plugin.register() + handle.dispatchTask() + createBoundWorker path
// runs unchanged. Only the host boundary is simulated: while the worker run is
// "in flight" (inside waitForRun) the fake host fires the plugin's registered
// before_tool_call hook for every agent-level tool call, and only an unblocked
// call reaches a simulated host-side service-request counter. This relies on
// the host contract that one tool invocation causes one service request; it does
// NOT exercise the host's real hook runner or the production HTTP call.
function harness(toolCalls) {
  const hooks = [];
  const serviceRequests = [];
  const verdicts = [];
  let run;
  const subagent = {
    async complete() {
      return { text: "ok" };
    },
    async run(args) {
      run = args;
      return { runId: "run-1", sessionKey: args.sessionKey };
    },
    async waitForRun() {
      const hook = hooks.find(([name]) => name === "before_tool_call")[1];
      for (const { toolCallId, query, deliveries = 1 } of toolCalls) {
        const event = { toolName: TOOL, runId: "run-1", toolCallId, params: { query } };
        const ctx = { sessionKey: run.sessionKey };
        const out = [];
        // Several hook deliveries may observe one logical call.
        for (let i = 0; i < deliveries; i += 1) out.push(await hook(event, ctx));
        verdicts.push(out);
        if (!out.some((v) => v?.block)) serviceRequests.push(query);
      }
      return { status: "ok" };
    },
    async getSessionMessages() {
      return { messages: [{ role: "assistant", content: "done" }] };
    },
    async deleteSession() {},
  };
  const api = {
    on: (...a) => hooks.push(a),
    runtime: { subagent },
    pluginConfig: {
      enabled: true,
      agentId: "main",
      workerRoutes: { standard: ["example/model-fast"] },
    },
  };
  plugin.register(api);
  return { handle: getOrchestration(api), serviceRequests, verdicts };
}

test("dispatchTask worker: chained logical calls are admitted once under repeated hook delivery", async () => {
  const calls = ["alpha", "beta", "gamma"].map((query, i) => ({
    toolCallId: `call-${i}`,
    query,
    deliveries: 2,
  }));
  const { handle, serviceRequests, verdicts } = harness(calls);
  const out = await handle.dispatchTask(task(), { resolveModel: () => "example/model-fast" });
  assert.equal(out.output.text, "done");
  assert.deepEqual(serviceRequests, ["alpha", "beta", "gamma"]);
  assert.ok(verdicts.flat().every((v) => !v?.block));
  assert.equal(handle.guard.size, 0, "binding released after dispatch");
});

test("dispatchTask worker: over-budget call is blocked before the simulated host request", async () => {
  const calls = ["a", "b", "c"].map((query, i) => ({ toolCallId: `c${i}`, query, deliveries: 2 }));
  const { handle, serviceRequests } = harness(calls);
  await handle.dispatchTask(task({ budget: { ...task().budget, maxCalls: 2 } }), {
    resolveModel: () => "example/model-fast",
  });
  assert.deepEqual(serviceRequests, ["a", "b"]);
  assert.equal(handle.guard.denials.at(-1).reason, DENIAL_REASONS.CALL_BUDGET);
});
