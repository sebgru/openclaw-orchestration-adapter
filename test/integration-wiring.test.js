import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrchestration, plugin, registerOrchestration } from "../src/index.js";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function task(over = {}) {
  return {
    contractVersion: 1,
    id: "t",
    goal: "do it",
    successCriteria: ["done"],
    allowedTools: ["read"],
    prohibitedActions: [],
    routeTier: "standard",
    budget: { maxCalls: 2, maxTokens: 100, timeoutMs: 1000, maxRetries: 0 },
    scope: { tenantId: "a", channel: "c", conversationId: "d" },
    outputSchema: { type: "object" },
    ...over,
  };
}

function fakeApi(pluginConfig, runtime = {}) {
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
    ...runtime,
  };
  return {
    api: { on: (...a) => hooks.push(a), runtime: { subagent }, pluginConfig },
    hooks,
    calls,
  };
}

test("default export stays inactive without explicit enablement", () => {
  for (const config of [undefined, {}, { enabled: false }, { enabled: "true" }]) {
    const { api, hooks } = fakeApi(config);
    plugin.register(api);
    assert.equal(hooks.length, 0);
    assert.equal(getOrchestration(api), undefined);
  }
  assert.equal(manifest.activation.onStartup, false);
  assert.equal(manifest.configSchema.properties.enabled.default, false);
});

test("register() wires the hook and a handle whose dispatch uses the guard-bound worker", async () => {
  const { api, hooks, calls } = fakeApi({
    enabled: true,
    agentId: "main",
    workerRoutes: { standard: ["example/model-fast", "example/model-cheap"] },
  });
  plugin.register(api);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0][0], "before_tool_call");
  const handle = getOrchestration(api);
  assert.ok(handle);

  const out = await handle.dispatchTask(task(), { resolveModel: () => "example/model-fast" });
  assert.equal(out.output.text, "done");
  const run = calls.find((c) => c[0] === "run")[1];
  assert.match(run.sessionKey, /^agent:main:subagent:oca-/);
  assert.equal(run.toolsAlsoAllow, undefined);
  assert.equal(handle.guard.size, 0);

  const done = await handle.dispatchTask(task({ mode: "completion", allowedTools: [] }), {
    resolveModel: () => "example/model-cheap",
  });
  assert.equal(done.output.text, "ok");
});

test("dispatchReadyBatch is wired through the handle and still requires a verifier", async () => {
  const { api } = fakeApi({ enabled: true, agentId: "main" });
  const handle = registerOrchestration(api, {
    agentId: "main",
    workerRoutes: { standard: ["example/model-fast"] },
  });
  await assert.rejects(handle.dispatchReadyBatch({ tasks: [] }, {}), /verifier/);
});

test("manifest declares only documented fields and an agentId pattern", () => {
  assert.equal(manifest.id, "openclaw-orchestration-adapter");
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.match("main", new RegExp(manifest.configSchema.properties.agentId.pattern));
  assert.doesNotMatch("a:b", new RegExp(manifest.configSchema.properties.agentId.pattern));
  assert.equal(manifest.configSchema.properties.lifecycleDiagnostics.default, false);
});

test("opt-in lifecycle diagnostics correlate binding events without raw run/session/task data", async () => {
  const messages = [];
  const disabled = fakeApi({
    enabled: true,
    agentId: "main",
    workerRoutes: { standard: ["example/model-fast"] },
  });
  disabled.api.logger = { info: (message) => messages.push(message) };
  plugin.register(disabled.api);
  await getOrchestration(disabled.api).dispatchTask(task(), {
    resolveModel: () => "example/model-fast",
  });
  assert.equal(messages.length, 0);

  const { api, hooks, calls } = fakeApi({
    enabled: true,
    agentId: "main",
    workerRoutes: { standard: ["example/model-fast"] },
    lifecycleDiagnostics: true,
  });
  api.logger = { info: (message) => messages.push(message) };
  plugin.register(api);
  const handle = getOrchestration(api);
  await handle.dispatchTask(task({ goal: "PRIVATE_TASK_GOAL" }), {
    resolveModel: () => "example/model-fast",
  });

  const run = calls.find(([name]) => name === "run")[1];
  const rawSessionKey = run.sessionKey;
  const hook = hooks.find(([name]) => name === "before_tool_call")[1];
  await hook(
    { toolName: "read", runId: "late-run", toolCallId: "late-call" },
    {
      sessionKey: rawSessionKey,
    },
  );

  const trace = messages.join("\n");
  for (const event of [
    "worker_started",
    "binding_created",
    "admission_confirmed",
    "run_wait_started",
    "run_wait_finished",
    "binding_released",
    "hook_blocked",
  ]) {
    assert.match(trace, new RegExp(event));
  }
  assert.doesNotMatch(trace, /PRIVATE_TASK_GOAL/);
  assert.equal(trace.includes(rawSessionKey), false);
  assert.doesNotMatch(trace, /run-1|late-run/);
  const records = messages.map((message) => JSON.parse(message.split(" lifecycle ")[1]));
  const correlationId = records.find((event) => event.event === "binding_created").correlationId;
  assert.ok(records.filter((event) => event.correlationId === correlationId).length >= 5);
});

test("packaging metadata ships the manifest and any declared skill directory", () => {
  assert.deepEqual(pkg.openclaw.extensions, ["./src/plugin.js"]);
  assert.ok(existsSync(join(root, pkg.openclaw.extensions[0])));
  assert.ok(pkg.files.includes("openclaw.plugin.json"));
  assert.ok(pkg.files.includes("src"));
  assert.ok(pkg.files.includes("skills"));
  assert.ok(pkg.files.includes("NOTICE"));
  const expectedSkills = [
    "skills/requesting-code-review",
    "skills/channel-context-bridge",
    "skills/expansion-grant-guard",
    "skills/task-handoff",
    "skills/loop-circuit-breaker",
    "skills/writing-plans",
    "skills/workflow-orchestration",
    "skills/dispatching-parallel-agents",
    "skills/executing-plans",
    "skills/quality-gate-orchestrator",
    "skills/spend-circuit-breaker",
    "skills/long-running-task-management",
    "skills/verification-before-completion",
    "skills/multi-agent-coordinator",
    "skills/subagent-driven-development",
  ];
  assert.deepEqual(manifest.skills, expectedSkills);
  for (const dir of manifest.skills) {
    assert.ok(
      !isAbsolute(dir) && !normalize(dir).startsWith(".."),
      `skill dir ${dir} must stay in root`,
    );
    assert.ok(existsSync(join(root, dir)), `skill dir ${dir} must exist`);
    assert.ok(existsSync(join(root, dir, "SKILL.md")), `skill ${dir} must contain SKILL.md`);
    assert.ok(
      pkg.files.some(
        (f) => normalize(dir) === normalize(f) || normalize(dir).startsWith(`${normalize(f)}/`),
      ),
      `skill dir ${dir} must be in package files`,
    );
  }
});

test("cancellation revokes the binding so later tool calls fail closed; runtime cancel is not assumed", async () => {
  let release;
  const { api, hooks } = fakeApi(
    { enabled: true, agentId: "main", workerRoutes: { standard: ["example/model-fast"] } },
    { waitForRun: () => new Promise((r) => (release = r)) },
  );
  plugin.register(api);
  const { guard, dispatchTask } = getOrchestration(api);
  assert.equal(typeof api.runtime.subagent.cancelRun, "undefined");
  const ac = new AbortController();
  const p = dispatchTask(task(), { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(guard.size, 1);
  ac.abort("stop");
  await assert.rejects(p, { name: "AbortError" });
  assert.equal(guard.size, 0);
  release({ status: "ok" });
  // The still-running worker's tool calls are now terminal blocks.
  const late = await hooks[0][1](
    { toolName: "read", runId: "run-1" },
    { sessionKey: "agent:main:subagent:oca-late" },
  );
  assert.equal(late.block, true);
});

test("fake host holds an early dispatch tool call through run admission and enforces its grant", async () => {
  const hooks = [];
  const registeredTools = [];
  const context = {
    senderIsOwner: true,
    requesterSenderId: "owner-1",
    agentId: "main",
    sessionKey: "agent:main:main",
    deliveryContext: { channel: "webchat" },
  };
  const beforeToolCall = (event, ctx) =>
    hooks.find(([name]) => name === "before_tool_call")[1](event, ctx);
  let acceptedSessionKey;
  let racedToolCall;
  let raceWasHeld;
  let admissionChecks;
  const subagent = {
    async run(args) {
      acceptedSessionKey = args.sessionKey;
      let settled = false;
      racedToolCall = beforeToolCall(
        { toolName: "read", runId: "host-run-1" },
        { sessionKey: args.sessionKey },
      ).then((result) => {
        settled = true;
        return result;
      });
      // Give the hook a turn to register its admission waiter before run()
      // returns the host-issued runId/sessionKey pair.
      await Promise.resolve();
      raceWasHeld = !settled;
      return { runId: "host-run-1", sessionKey: args.sessionKey };
    },
    async waitForRun() {
      const allowed = await racedToolCall;
      const wrongRun = await beforeToolCall(
        { toolName: "read", runId: "host-run-other" },
        { sessionKey: acceptedSessionKey },
      );
      const ungranted = await beforeToolCall(
        { toolName: "write", runId: "host-run-1" },
        { sessionKey: acceptedSessionKey },
      );
      const wrongSession = await beforeToolCall(
        { toolName: "read", runId: "host-run-1" },
        { sessionKey: `${acceptedSessionKey}-other` },
      );
      admissionChecks = { allowed, wrongRun, ungranted, wrongSession };
      return { status: "ok" };
    },
    async getSessionMessages() {
      return { messages: [{ role: "assistant", content: "host harness complete" }] };
    },
    async deleteSession() {},
  };
  const api = {
    on: (...args) => hooks.push(args),
    registerTool: (...args) => registeredTools.push(args),
    runtime: { subagent },
    pluginConfig: {
      enabled: true,
      agentId: "main",
      workerRoutes: { standard: ["example/model-fast"] },
      dispatch: { allowedTools: ["read"], maxCalls: 2, maxTimeoutMs: 2_000, maxTokens: 500 },
    },
  };

  plugin.register(api);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0][0], "before_tool_call");
  assert.equal(registeredTools.length, 1);
  const [factory, registration] = registeredTools[0];
  assert.deepEqual(registration, { name: "orchestration_dispatch", optional: true });
  assert.equal(factory({ ...context, senderIsOwner: false }), null);
  const tool = factory(context);
  assert.ok(tool);

  const result = await tool.execute("call-1", {
    goal: "read one item",
    successCriteria: ["return the item"],
    routeTier: "standard",
    mode: "tools",
    allowedTools: ["read"],
    budget: { maxCalls: 2, timeoutMs: 1_500, maxTokens: 300 },
  });

  assert.equal(raceWasHeld, true);
  assert.equal(admissionChecks.allowed.block, undefined);
  assert.equal(admissionChecks.wrongRun.block, true);
  assert.equal(admissionChecks.ungranted.block, true);
  assert.equal(admissionChecks.wrongSession.block, true);
  assert.equal(result.details.output.text, "host harness complete");
  assert.equal(getOrchestration(api).guard.size, 0);
});

test("separate registrations share one default guard across factory/hook lifetimes", async () => {
  const a = fakeApi({ enabled: true, agentId: "main", workerRoutes: undefined });
  const b = fakeApi({ enabled: true, agentId: "main", workerRoutes: undefined });
  const ha = registerOrchestration(a.api, { agentId: "main" });
  const hb = registerOrchestration(b.api, { agentId: "main" });
  assert.equal(ha.guard, hb.guard);
  const key = "agent:main:subagent:oca-split";
  try {
    ha.guard.bind({
      sessionKey: key,
      taskId: "t",
      allowedTools: ["read"],
      budget: { maxCalls: 1, timeoutMs: 1000 },
    });
    ha.guard.confirm(key, { runId: "r1", sessionKey: key });
    // Hook registered by the *other* registration must see the binding.
    const result = await b.hooks[0][1]({ toolName: "read", runId: "r1" }, { sessionKey: key });
    assert.deepEqual(result, {});
  } finally {
    ha.guard.release(key);
  }
});

function bindShared(h, key, maxCalls) {
  h.guard.bind({
    sessionKey: key,
    taskId: "t",
    allowedTools: ["read"],
    budget: { maxCalls, timeoutMs: 1000 },
  });
  h.guard.confirm(key, { runId: "r1", sessionKey: key });
}

test("two registrations charge each logical call once when toolCallId is present", async () => {
  const a = fakeApi({ enabled: true });
  const b = fakeApi({ enabled: true });
  const h = registerOrchestration(a.api, { agentId: "main" });
  registerOrchestration(b.api, { agentId: "main" });
  const key = "agent:main:subagent:oca-dedupe";
  bindShared(h, key, 2);
  try {
    const fire = async (id) => {
      const event = { toolName: "read", runId: "r1", toolCallId: id };
      return [
        await a.hooks[0][1](event, { sessionKey: key }),
        await b.hooks[0][1](event, { sessionKey: key }),
      ];
    };
    assert.deepEqual(await fire("c1"), [{}, {}]);
    assert.deepEqual(await fire("c2"), [{}, {}]);
    const [x, y] = await fire("c3");
    assert.equal(x.block, true);
    assert.equal(y.block, true);
    // Already-charged call ids stay allowed for the other hook after exhaustion.
    assert.deepEqual(await fire("c2"), [{}, {}]);
  } finally {
    h.guard.release(key);
  }
});

test("without toolCallId every hook invocation is charged (fail closed)", async () => {
  const a = fakeApi({ enabled: true });
  const b = fakeApi({ enabled: true });
  const h = registerOrchestration(a.api, { agentId: "main" });
  registerOrchestration(b.api, { agentId: "main" });
  const key = "agent:main:subagent:oca-nocallid";
  bindShared(h, key, 2);
  try {
    const event = { toolName: "read", runId: "r1" };
    assert.deepEqual(await a.hooks[0][1](event, { sessionKey: key }), {});
    assert.deepEqual(await b.hooks[0][1](event, { sessionKey: key }), {});
    assert.equal((await a.hooks[0][1](event, { sessionKey: key })).block, true);
  } finally {
    h.guard.release(key);
  }
});

test("shared guard slot is validated, non-writable, and survives a cache-busted reload", async () => {
  const slot = Symbol.for("openclaw-orchestration-adapter.toolGuard");
  const saved = Object.getOwnPropertyDescriptor(globalThis, slot);
  try {
    const url = new URL("../src/plugin.js", import.meta.url);
    const first = await import(`${url.href}?reload=1`);
    const second = await import(`${url.href}?reload=2`);
    assert.equal(first.sharedToolGuard(), second.sharedToolGuard());
    const desc = Object.getOwnPropertyDescriptor(globalThis, slot);
    assert.equal(desc.writable, false);
    assert.equal(desc.enumerable, false);
    // Tampered slot is replaced by a working guard rather than trusted.
    Object.defineProperty(globalThis, slot, { value: { check: () => ({}) }, configurable: true });
    const repaired = first.sharedToolGuard();
    assert.equal(typeof repaired.checkWhenAdmitted, "function");
    assert.equal(globalThis[slot], repaired);
    assert.equal(first.sharedToolGuard(), repaired);
  } finally {
    if (saved) Object.defineProperty(globalThis, slot, saved);
    else delete globalThis[slot];
  }
});
