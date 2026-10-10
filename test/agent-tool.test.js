import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_TOOL_NAME,
  buildDispatchTask,
  normalizeDispatchConfig,
  plugin,
  registerOrchestration,
} from "../src/index.js";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));

function fakeApi(pluginConfig) {
  const tools = [];
  const runs = [];
  const subagent = {
    async complete(a) {
      runs.push(["complete", a]);
      return { text: "answer" };
    },
    async run(a) {
      runs.push(["run", a]);
      return { runId: "r1", sessionKey: a.sessionKey };
    },
    async waitForRun() {
      return { status: "ok" };
    },
    async getSessionMessages() {
      return { messages: [{ role: "assistant", content: "tool-done" }] };
    },
    async deleteSession() {},
  };
  return {
    api: {
      on() {},
      registerTool: (...a) => tools.push(a),
      runtime: { subagent },
      pluginConfig,
    },
    tools,
    runs,
  };
}

const config = {
  enabled: true,
  agentId: "main",
  workerRoutes: { standard: ["example/m1"], cheap: ["example/m2"] },
  dispatch: { allowedTools: ["read"], maxCalls: 5, maxTimeoutMs: 2000, maxTokens: 1000 },
};
const owner = {
  senderIsOwner: true,
  requesterSenderId: "user-1",
  agentId: "main",
  sessionKey: "agent:main:main",
  deliveryContext: { channel: "webchat" },
};
const valid = { goal: "g", successCriteria: ["ok"], routeTier: "cheap" };

test("tool is registered once as optional only when dispatch config exists", () => {
  const off = fakeApi({ ...config, dispatch: undefined });
  plugin.register(off.api);
  assert.equal(off.tools.length, 0);

  const on = fakeApi(config);
  plugin.register(on.api);
  assert.equal(on.tools.length, 1);
  assert.equal(typeof on.tools[0][0], "function");
  assert.deepEqual(on.tools[0][1], { name: DISPATCH_TOOL_NAME, optional: true });
  assert.deepEqual(manifest.contracts.tools, [DISPATCH_TOOL_NAME]);
  assert.equal(manifest.toolMetadata[DISPATCH_TOOL_NAME].optional, true);
});

test("factory hides the tool unless owner, unsandboxed", () => {
  const { api, tools } = fakeApi(config);
  plugin.register(api);
  const factory = tools[0][0];
  assert.equal(factory({ senderIsOwner: false }), null);
  assert.equal(factory({}), null);
  assert.equal(factory(null), null);
  assert.equal(factory([]), null);
  assert.equal(factory({ ...owner, sandboxed: true }), null);
  for (const key of ["requesterSenderId", "agentId", "sessionKey", "deliveryContext"]) {
    assert.equal(factory({ ...owner, [key]: undefined }), null, key);
  }
  assert.equal(factory({ ...owner, requesterSenderId: " " }), null);
  assert.equal(factory({ ...owner, deliveryContext: {} }), null);
  const tool = factory(owner);
  assert.equal(tool.name, DISPATCH_TOOL_NAME);
  assert.equal(tool.parameters.additionalProperties, false);
});

test("execute dispatches a completion task and flags output unverified", async () => {
  const { api, tools, runs } = fakeApi(config);
  plugin.register(api);
  const tool = tools[0][0](owner);
  const res = await tool.execute("call-1", valid);
  assert.equal(res.details.verified, false);
  assert.equal(res.details.model, "example/m2");
  assert.equal(res.details.output.text, "answer");
  assert.equal(runs[0][0], "complete");
  assert.equal(runs[0][1].model, "example/m2");
  assert.equal(res.content[0].type, "text");
});

test("tools mode runs under the guard with the granted tool list only", async () => {
  const { api, tools, runs } = fakeApi(config);
  plugin.register(api);
  const tool = tools[0][0](owner);
  const res = await tool.execute("c", {
    ...valid,
    routeTier: "standard",
    mode: "tools",
    allowedTools: ["read"],
  });
  assert.equal(res.details.output.text, "tool-done");
  assert.equal(runs[0][0], "run");
  assert.equal(runs[0][1].toolsAlsoAllow, undefined);
});

test("model-supplied grants beyond the operator ceiling are rejected before any run", async () => {
  const { api, tools, runs } = fakeApi(config);
  plugin.register(api);
  const tool = tools[0][0](owner);
  await assert.rejects(
    tool.execute("c", { ...valid, mode: "tools", allowedTools: ["exec"] }),
    /ceiling/,
  );
  await assert.rejects(
    tool.execute("c", { ...valid, mode: "tools", allowedTools: ["sessions_spawn"] }),
    /ceiling/,
  );
  await assert.rejects(tool.execute("c", { ...valid, budget: { timeoutMs: 9999 } }), /ceiling/);
  await assert.rejects(
    tool.execute("c", { ...valid, allowedTools: ["read"] }),
    /completion mode must not grant tools/,
  );
  assert.equal(runs.length, 0);
});

test("execute fails closed when context lacks trusted identity, before any run", async () => {
  const { api, tools, runs } = fakeApi(config);
  plugin.register(api);
  const ctx = { ...owner };
  const tool = tools[0][0](ctx);
  ctx.requesterSenderId = undefined;
  await assert.rejects(tool.execute("c", valid), /trusted requester/);
  assert.equal(runs.length, 0);
});

test("route pools still gate the model: unconfigured tier fails closed", async () => {
  const { api, tools, runs } = fakeApi(config);
  plugin.register(api);
  const tool = tools[0][0](owner);
  await assert.rejects(tool.execute("c", { ...valid, routeTier: "strong" }), /no configured/);
  assert.equal(runs.length, 0);
});

test("scope comes from host context, not params; no model override is accepted", () => {
  const limits = normalizeDispatchConfig(config.dispatch);
  assert.throws(
    () => buildDispatchTask({ ...valid, scope: { tenantId: "evil" } }, limits, owner),
    /unknown parameters: scope/,
  );
  assert.throws(() => buildDispatchTask({ ...valid, model: "x/y" }, limits, owner), /unknown/);
  assert.throws(
    () => buildDispatchTask({ ...valid, budget: { maxRetries: 1 } }, limits, owner),
    /unknown budget/,
  );
  assert.throws(
    () => buildDispatchTask({ ...valid, budget: { maxCalls: "2" } }, limits, owner),
    /positive integer/,
  );
  assert.throws(() => buildDispatchTask({ ...valid, budget: 5 }, limits, owner), /budget/);
  const task = buildDispatchTask(valid, limits, owner);
  assert.deepEqual(task.scope, {
    tenantId: "main",
    channel: "webchat",
    conversationId: "agent:main:main",
  });
  assert.equal(task.model, undefined);
  assert.equal(task.budget.maxRetries, 0);
  assert.throws(() => buildDispatchTask(null, limits, owner), /object/);
  for (const bad of [
    {},
    { ...owner, senderIsOwner: false },
    { ...owner, requesterSenderId: undefined },
    { ...owner, deliveryContext: undefined },
    { ...owner, sessionKey: "" },
    { ...owner, sandboxed: true },
    null,
    "not-a-record",
    [],
  ]) {
    assert.throws(() => buildDispatchTask(valid, limits, bad), /trusted requester/);
  }
  assert.throws(
    () => buildDispatchTask({ ...valid, allowedTools: [1] }, limits, owner),
    /allowedTools must be strings/,
  );
  assert.throws(
    () => buildDispatchTask({ ...valid, allowedTools: "read" }, limits, owner),
    /allowedTools must be strings/,
  );
});

test("normalizeDispatchConfig validates the block", () => {
  assert.equal(normalizeDispatchConfig(undefined), undefined);
  assert.deepEqual(normalizeDispatchConfig({}).allowedTools, []);
  assert.throws(() => normalizeDispatchConfig("x"), /object/);
  assert.throws(() => normalizeDispatchConfig({ bogus: 1 }), /not a known/);
  assert.throws(() => normalizeDispatchConfig({ allowedTools: [1] }), /strings/);
  assert.throws(() => normalizeDispatchConfig({ allowedTools: ["subagents"] }), /cannot grant/);
  assert.throws(() => normalizeDispatchConfig({ maxCalls: 0 }), /positive/);
});

test("registerOrchestration requires api.registerTool when dispatch is configured", () => {
  const { api } = fakeApi(config);
  delete api.registerTool;
  assert.throws(() => registerOrchestration(api, { dispatch: {} }), /registerTool/);
});

for (const [mode, tools, callName] of [
  ["completion", [], "complete"],
  ["tools", ["read"], "run"],
]) {
  test(`dispatch worker message carries the contract brief in ${mode} mode`, async () => {
    const { api, tools: registered, runs } = fakeApi(config);
    plugin.register(api);
    const tool = registered[0][0](owner);
    await tool.execute("call-1", {
      goal: "summarise the report",
      successCriteria: ["lists three findings"],
      prohibitedActions: ["write files"],
      routeTier: "standard",
      mode,
      allowedTools: tools,
      budget: { maxCalls: 3, timeoutMs: 1500, maxTokens: 500 },
      outputSchema: { type: "object", properties: { findings: { type: "array" } } },
    });
    const call = runs.find((r) => r[0] === callName)[1];
    const text = call.message;
    assert.match(text, /summarise the report/);
    assert.match(text, /lists three findings/);
    assert.match(text, /write files/);
    assert.match(text, /"maxCalls": 3/);
    assert.match(text, /"maxTokens": 500/);
    assert.match(text, /"timeoutMs": 1500/);
    assert.match(text, /"findings"/);
    assert.doesNotMatch(text, /memory/i);
  });
}
