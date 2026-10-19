import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANARY_RESULT, CANARY_TOOL_NAME, buildDispatchTask, plugin } from "../src/index.js";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));

const owner = {
  senderIsOwner: true,
  requesterSenderId: "user-1",
  agentId: "main",
  sessionKey: "agent:main:main",
  deliveryContext: { channel: "webchat" },
};

function setup(overrides = {}) {
  const hooks = [];
  const tools = [];
  const runs = [];
  const hookResults = [];
  const subagent = {
    async run(a) {
      runs.push(a);
      return { runId: "r1", sessionKey: a.sessionKey };
    },
    async waitForRun() {
      const ctx = { sessionKey: runs.at(-1).sessionKey };
      const call = (toolName, toolCallId) =>
        hooks[0]({ toolName, toolCallId, runId: "r1", params: {} }, ctx);
      hookResults.push(await call(CANARY_TOOL_NAME, "c1"));
      hookResults.push(await call("exec", "c2"));
      return { status: "ok" };
    },
    async getSessionMessages() {
      return { messages: [{ role: "assistant", content: "done" }] };
    },
    async deleteSession() {},
  };
  const pluginConfig = {
    enabled: true,
    agentId: "main",
    workerRoutes: { cheap: ["example/m2"] },
    dispatch: { allowedTools: [CANARY_TOOL_NAME, "read"], maxCalls: 3 },
    ...overrides,
  };
  const api = {
    on: (_name, handler) => hooks.push(handler),
    registerTool: (...a) => tools.push(a),
    runtime: { subagent },
    pluginConfig,
  };
  return { api, hooks, tools, runs, hookResults };
}

const toolTask = (allowedTools) =>
  buildDispatchTask(
    { goal: "g", successCriteria: ["ok"], routeTier: "cheap", mode: "tools", allowedTools },
    { allowedTools: [CANARY_TOOL_NAME, "read"], maxCalls: 3, timeoutMs: 1000, maxTokens: 100 },
    owner,
  );

test("canary tool is off by default and registered only on opt-in", () => {
  const off = setup();
  plugin.register(off.api);
  assert.deepEqual(
    off.tools.map((t) => t[1].name),
    ["orchestration_dispatch"],
  );
  const on = setup({ canary: true });
  plugin.register(on.api);
  assert.deepEqual(
    on.tools.map((t) => t[1].name),
    ["orchestration_dispatch", CANARY_TOOL_NAME],
  );
  assert.deepEqual(on.tools[1][1], { name: CANARY_TOOL_NAME, optional: true });
  assert.ok(manifest.contracts.tools.includes(CANARY_TOOL_NAME));
  assert.equal(manifest.toolMetadata[CANARY_TOOL_NAME].sideEffecting, false);
  assert.equal(manifest.configSchema.properties.canary.default, false);
});

test("canary tool is deterministic and takes no arguments", async () => {
  const { api, tools } = setup({ canary: true });
  plugin.register(api);
  const tool = tools[1][0]({});
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties, {});
  const a = await tool.execute("id", {});
  const b = await tool.execute("id2", { ignored: 1 });
  assert.deepEqual(a.details, CANARY_RESULT);
  assert.deepEqual(a, b);
});

test("worker grant passes only owned tools via toolsAlsoAllow; guard allows grant and denies others", async () => {
  const { api, runs, hookResults } = setup({ canary: true });
  plugin.register(api);
  const { getOrchestration } = await import("../src/plugin.js");
  await getOrchestration(api).dispatchTask(toolTask([CANARY_TOOL_NAME, "read"]));
  assert.deepEqual(runs[0].toolsAlsoAllow, [CANARY_TOOL_NAME]);
  assert.deepEqual(hookResults[0], {});
  assert.equal(hookResults[1].block, true);
});

test("no toolsAlsoAllow without opt-in or without a canary grant", async () => {
  const { getOrchestration } = await import("../src/plugin.js");
  const off = setup();
  plugin.register(off.api);
  await getOrchestration(off.api).dispatchTask(toolTask([CANARY_TOOL_NAME]));
  assert.equal("toolsAlsoAllow" in off.runs[0], false);

  const on = setup({ canary: true });
  plugin.register(on.api);
  await getOrchestration(on.api).dispatchTask(toolTask(["read"]));
  assert.equal("toolsAlsoAllow" in on.runs[0], false);
  assert.equal(on.hookResults[0].block, true);
});
