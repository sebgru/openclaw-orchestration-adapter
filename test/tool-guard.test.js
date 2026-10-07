import test from "node:test";
import assert from "node:assert/strict";
import {
  DELEGATION_TOOLS,
  ToolGuard,
  createBoundWorker,
  dispatchTask,
  plugin,
  registerOrchestration,
  validateTask,
} from "../src/index.js";

const KEY = "agent:main:subagent:oca-1111";
const budget = { maxCalls: 2, timeoutMs: 1000 };

function bound(extra = {}, clock = { t: 0 }) {
  const guard = new ToolGuard({ now: () => clock.t });
  guard.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget, ...extra });
  guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  return { guard, clock };
}
const call = (guard, over = {}) =>
  guard.check({ sessionKey: KEY, runId: "run-1", toolName: "read", ...over });

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

test("granted tool passes; ungranted, delegation, and unbound calls block", () => {
  const { guard } = bound();
  assert.deepEqual(call(guard), {});
  assert.equal(call(guard, { toolName: "exec" }).block, true);
  for (const t of DELEGATION_TOOLS) assert.equal(call(guard, { toolName: t }).block, true);
  // unbound worker-namespace session is rejected; foreign sessions are untouched
  assert.equal(
    guard.check({ sessionKey: "agent:main:subagent:oca-other", runId: "x", toolName: "read" })
      .block,
    true,
  );
  assert.deepEqual(guard.check({ sessionKey: "agent:main:main", toolName: "exec" }), {});
  assert.deepEqual(guard.check({ toolName: "exec" }), {});
});

test("runId mismatch, missing runId, and unconfirmed binding block", () => {
  const { guard } = bound();
  assert.equal(call(guard, { runId: "run-2" }).block, true);
  assert.equal(call(guard, { runId: undefined }).block, true);
  const pending = new ToolGuard();
  pending.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  assert.match(call(pending).blockReason, /not yet confirmed/);
});

test("call and time budgets bound the run", () => {
  const { guard, clock } = bound();
  assert.deepEqual(call(guard), {});
  assert.deepEqual(call(guard), {});
  assert.match(call(guard).blockReason, /call budget/);
  const fresh = bound({}, clock);
  clock.t = 1000;
  assert.match(call(fresh.guard).blockReason, /time budget/);
});

test("bind rejects delegation grants, bad budgets, duplicates; confirm rejects key drift", () => {
  const g = new ToolGuard();
  const base = { sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget };
  assert.throws(() => g.bind({ ...base, allowedTools: ["sessions_spawn"] }), /delegation/);
  assert.throws(() => g.bind({ ...base, sessionKey: "agent:main:main" }), /namespace/);
  assert.throws(() => g.bind({ ...base, budget: { maxCalls: 0, timeoutMs: 1 } }), /maxCalls/);
  assert.throws(() => g.bind({ ...base, budget: { maxCalls: 1, timeoutMs: 0 } }), /timeoutMs/);
  assert.throws(() => g.bind({ ...base, allowedTools: [""] }), /allowedTools/);
  assert.throws(() => g.bind({ ...base, taskId: "" }), /taskId/);
  g.bind(base);
  assert.throws(() => g.bind(base), /already bound/);
  assert.throws(() => g.confirm(KEY, { runId: "r", sessionKey: "other" }), /did not confirm/);
  assert.equal(g.size, 0);
  assert.throws(() => g.confirm(KEY, { runId: "r", sessionKey: KEY }), /no pending/);
});

test("completion mode contract grants no tools", () => {
  assert.deepEqual(validateTask(task({ mode: "completion", allowedTools: [] })), []);
  assert.match(validateTask(task({ mode: "completion" })).join(), /must not grant tools/);
  assert.match(validateTask(task({ mode: "x" })).join(), /mode must be/);
});

function fakeSubagent(over = {}) {
  const calls = [];
  return {
    calls,
    async complete(a) {
      calls.push(["complete", a]);
      return { text: "plan" };
    },
    async run(a) {
      calls.push(["run", a]);
      return { runId: "run-9", sessionKey: a.sessionKey };
    },
    async waitForRun(a) {
      calls.push(["wait", a]);
      return { status: "ok" };
    },
    async getSessionMessages() {
      return {
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "answer" },
        ],
      };
    },
    async deleteSession(a) {
      calls.push(["delete", a]);
    },
    ...over,
  };
}

test("completion worker uses tool-free complete() and never binds a session", async () => {
  const subagent = fakeSubagent();
  const guard = new ToolGuard();
  const worker = createBoundWorker({ subagent, guard, agentId: "main" });
  const out = await dispatchTask(task({ mode: "completion", allowedTools: [] }), {
    worker,
    resolveModel: () => "openai/gpt-6-luna",
  });
  assert.equal(out.output.text, "plan");
  assert.deepEqual(
    subagent.calls.map((c) => c[0]),
    ["complete"],
  );
  assert.equal(guard.size, 0);
});

test("tools worker binds before run, enforces grant during run, cleans up after", async () => {
  const guard = new ToolGuard();
  let boundKey;
  const subagent = fakeSubagent({
    async run(a) {
      assert.equal(guard.size, 1, "bound before run()");
      assert.equal(a.toolsAlsoAllow, undefined);
      assert.equal(a.provider, "openai");
      assert.equal(a.model, "gpt-6-luna");
      assert.equal(
        guard.check({ sessionKey: a.sessionKey, runId: "run-9", toolName: "read" }).block,
        true,
      );
      boundKey = a.sessionKey;
      return { runId: "run-9", sessionKey: a.sessionKey };
    },
    async waitForRun() {
      const ask = (toolName) => guard.check({ sessionKey: boundKey, runId: "run-9", toolName });
      assert.deepEqual(ask("read"), {});
      assert.equal(ask("exec").block, true);
      return { status: "ok" };
    },
  });
  const worker = createBoundWorker({ subagent, guard, agentId: "main" });
  const out = await dispatchTask(task(), { worker, resolveModel: () => "openai/gpt-6-luna" });
  assert.equal(out.output.text, "answer");
  assert.equal(guard.size, 0);
  assert.equal(
    guard.check({ sessionKey: out.output.sessionKey, runId: "run-9", toolName: "read" }).block,
    true,
  );
});

test("cancellation and failed runs release the binding and delete the session", async () => {
  const guard = new ToolGuard();
  const ac = new AbortController();
  const subagent = fakeSubagent({
    waitForRun: () => new Promise(() => {}),
  });
  const worker = createBoundWorker({ subagent, guard, agentId: "main" });
  const p = dispatchTask(task(), { worker, resolveModel: () => "m", signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(guard.size, 1);
  ac.abort("stop");
  await assert.rejects(p, { name: "AbortError" });
  assert.equal(guard.size, 0);

  const failing = fakeSubagent({ waitForRun: async () => ({ status: "error" }) });
  await assert.rejects(
    dispatchTask(task(), {
      worker: createBoundWorker({ subagent: failing, guard, agentId: "main" }),
      resolveModel: () => "m",
    }),
    /status error/,
  );
  assert.equal(guard.size, 0);
  assert.equal(failing.calls.at(-1)[0], "delete");

  const drift = fakeSubagent({
    run: async () => ({ runId: "r", sessionKey: "other" }),
    deleteSession: async () => {
      throw new Error("x");
    },
  });
  await assert.rejects(
    dispatchTask(task(), {
      worker: createBoundWorker({ subagent: drift, guard, agentId: "main" }),
      resolveModel: () => "m",
    }),
    /did not confirm/,
  );
  assert.equal(guard.size, 0);
});

test("pre-aborted signal, missing deps, and bad agentId fail closed", async () => {
  const ac = new AbortController();
  ac.abort();
  const w = createBoundWorker({
    subagent: fakeSubagent(),
    guard: new ToolGuard(),
    agentId: "main",
  });
  await assert.rejects(
    w({ task: task(), grant: { mode: "tools" }, model: "m", signal: ac.signal }),
  );
  assert.throws(() => createBoundWorker({ guard: new ToolGuard() }), /subagent/);
  assert.throws(() => createBoundWorker({ subagent: fakeSubagent() }), /guard/);
  await assert.rejects(
    createBoundWorker({ subagent: fakeSubagent(), guard: new ToolGuard(), agentId: "a:b" })({
      task: task(),
      grant: { mode: "tools", allowedTools: [], budget },
      model: "m",
    }),
    /agentId/,
  );
});

test("plugin registers a priority hook that enforces the guard; disabled by default", async () => {
  const hooks = [];
  const api = {
    on: (...a) => hooks.push(a),
    runtime: { subagent: fakeSubagent() },
    pluginConfig: {},
  };
  plugin.register(api);
  assert.equal(hooks.length, 0);
  api.pluginConfig = { enabled: true };
  plugin.register(api);
  assert.equal(hooks[0][0], "before_tool_call");

  const handle = registerOrchestration(api);
  handle.guard.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  handle.guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  const hook = hooks.at(-1)[1];
  assert.deepEqual(await hook({ toolName: "read", runId: "run-1" }, { sessionKey: KEY }), {});
  assert.deepEqual(await hook({ toolName: "read" }, { sessionKey: KEY, runId: "run-1" }), {});
  assert.equal((await hook({ toolName: "exec", runId: "run-1" }, { sessionKey: KEY })).block, true);
  assert.deepEqual(await hook(undefined, undefined), {});
  assert.equal(typeof handle.createWorker({ agentId: "main" }), "function");
});

test("contract: run() resolves at admission; a tool call racing confirm() is held, then judged", async () => {
  // Models the documented API: run() returns {runId, sessionKey} immediately and
  // the worker may emit its first before_tool_call before the caller's
  // continuation runs. waitForRun() is the only completion signal.
  const guard = new ToolGuard();
  const hooks = [];
  const api = { on: (...a) => hooks.push(a), runtime: {}, pluginConfig: { enabled: true } };
  const order = [];
  let hookResult;
  const subagent = fakeSubagent({
    async run(a) {
      order.push("admitted");
      // Host starts the worker; first tool call fires before run()'s caller resumes.
      queueMicrotask(() => {
        order.push("first-tool-call");
        hookResult = hooks[0][1](
          { toolName: "read", runId: "run-9" },
          { sessionKey: a.sessionKey },
        );
      });
      return { runId: "run-9", sessionKey: a.sessionKey };
    },
    async waitForRun() {
      order.push("wait");
      assert.deepEqual(await hookResult, {});
      return { status: "ok" };
    },
  });
  api.runtime.subagent = subagent;
  const handle = registerOrchestration(api, { guard });
  const worker = handle.createWorker({ agentId: "main" });
  const out = await dispatchTask(task(), { worker, resolveModel: () => "openai/gpt-6-luna" });
  assert.equal(out.output.text, "answer");
  assert.deepEqual(order, ["admitted", "first-tool-call", "wait"]);
});

test("a held call is blocked when admission never confirms, or the binding is released", async () => {
  const slow = new ToolGuard({ admissionWaitMs: 20 });
  slow.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  const timedOut = await slow.checkWhenAdmitted({
    sessionKey: KEY,
    runId: "run-1",
    toolName: "read",
  });
  assert.match(timedOut.blockReason, /not yet confirmed/);

  // Keep the deadline short: the guard intentionally unrefs its timeout, so
  // a long pending waiter alone does not keep Node's test worker alive.
  const g = new ToolGuard({ admissionWaitMs: 20 });
  g.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  const held = g.checkWhenAdmitted({ sessionKey: KEY, runId: "run-1", toolName: "read" });
  g.release(KEY);
  assert.match((await held).blockReason, /no active binding/);

  // runId from the hook is never adopted: a different id after confirm is blocked.
  g.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  const racing = g.checkWhenAdmitted({ sessionKey: KEY, runId: "attacker", toolName: "read" });
  g.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  assert.match((await racing).blockReason, /runId does not match/);
});
