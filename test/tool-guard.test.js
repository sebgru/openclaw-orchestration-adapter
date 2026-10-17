import test from "node:test";
import assert from "node:assert/strict";
import {
  DELEGATION_TOOLS,
  DENIAL_REASONS,
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

test("deployment-owned exact argument allowlist blocks shell command changes", () => {
  const toolName = "mcp__openclaw__gateway_exec";
  const command = "git -C /workspace/project status --short";
  const guard = new ToolGuard();
  guard.bind({
    sessionKey: KEY,
    taskId: "t",
    allowedTools: [toolName],
    allowedCalls: [{ toolName, params: { command } }],
    budget,
  });
  guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });

  assert.deepEqual(
    guard.check({
      sessionKey: KEY,
      runId: "run-1",
      toolName,
      toolCallId: "call-1",
      params: { command },
    }),
    {},
  );
  assert.match(
    guard.check({
      sessionKey: KEY,
      runId: "run-1",
      toolName,
      toolCallId: "call-1",
      params: { command: `${command}; id` },
    }).blockReason,
    /toolCallId reused/,
  );
  for (const params of [
    { command: `${command}; cat /etc/passwd` },
    { command, elevated: true },
    { command, workdir: "/" },
    { command: "git -C /workspace/project status --short && id" },
  ]) {
    assert.match(
      guard.check({ sessionKey: KEY, runId: "run-1", toolName, params }).blockReason,
      /arguments are not allowlisted/,
    );
  }
});

test("configured exact-call policy blocks calls with absent or incomplete params", () => {
  const guard = new ToolGuard();
  guard.bind({
    sessionKey: KEY,
    taskId: "t",
    allowedTools: ["mcp__openclaw__gateway_exec"],
    allowedCalls: [{ toolName: "mcp__openclaw__gateway_exec", params: { command: "git status" } }],
    budget,
  });
  guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  assert.match(
    guard.check({
      sessionKey: KEY,
      runId: "run-1",
      toolName: "mcp__openclaw__gateway_exec",
    }).blockReason,
    /arguments are not allowlisted/,
  );
  assert.throws(
    () =>
      guard.bind({
        sessionKey: "agent:main:subagent:oca-2222",
        taskId: "t2",
        allowedTools: ["mcp__openclaw__gateway_exec"],
        allowedCalls: [{ toolName: "read", params: {} }],
        budget,
      }),
    /exact params/,
  );
  assert.throws(
    () =>
      guard.bind({
        sessionKey: "agent:main:subagent:oca-3333",
        taskId: "t3",
        allowedTools: ["read", "write"],
        allowedCalls: [{ toolName: "read", params: {} }],
        budget,
      }),
    /constrain every granted tool/,
  );
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
    resolveModel: () => "example/model-fast",
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
      assert.equal(a.provider, "example");
      assert.equal(a.model, "model-fast");
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
  const out = await dispatchTask(task(), { worker, resolveModel: () => "example/model-fast" });
  assert.equal(out.output.text, "answer");
  assert.equal(guard.size, 0);
  assert.equal(
    guard.check({ sessionKey: out.output.sessionKey, runId: "run-9", toolName: "read" }).block,
    true,
  );
});

test("tools worker carries exact allowed calls through dispatch into the guard", async () => {
  const guard = new ToolGuard();
  let boundKey;
  const subagent = fakeSubagent({
    async run(a) {
      boundKey = a.sessionKey;
      return { runId: "run-9", sessionKey: a.sessionKey };
    },
    async waitForRun() {
      const ask = (params) =>
        guard.check({ sessionKey: boundKey, runId: "run-9", toolName: "read", params });
      assert.deepEqual(ask({ path: "README.md" }), {});
      assert.match(ask({ path: "secrets.txt" }).blockReason, /arguments are not allowlisted/);
      return { status: "ok" };
    },
  });
  const worker = createBoundWorker({ subagent, guard, agentId: "main" });
  const out = await dispatchTask(
    task({ allowedCalls: [{ toolName: "read", params: { path: "README.md" } }] }),
    { worker, resolveModel: () => "example/model-fast" },
  );
  assert.equal(out.output.text, "answer");
  assert.equal(guard.size, 0);
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
  api.pluginConfig = { enabled: true, workerRoutes: { standard: ["example/model-fast"] } };
  plugin.register(api);
  assert.equal(hooks[0][0], "before_tool_call");

  const handle = registerOrchestration(api);
  handle.guard.bind({
    sessionKey: KEY,
    taskId: "t",
    allowedTools: ["read"],
    allowedCalls: [{ toolName: "read", params: { path: "README.md" } }],
    budget,
  });
  handle.guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  const hook = hooks.at(-1)[1];
  assert.deepEqual(
    await hook(
      { toolName: "read", params: { path: "README.md" }, runId: "run-1" },
      { sessionKey: KEY },
    ),
    {},
  );
  assert.equal(
    (
      await hook(
        { toolName: "read", params: { path: "README.md", recursive: true }, runId: "run-1" },
        { sessionKey: KEY },
      )
    ).block,
    true,
  );
  assert.equal((await hook({ toolName: "read" }, { sessionKey: KEY, runId: "run-1" })).block, true);
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
  const handle = registerOrchestration(api, {
    guard,
    workerRoutes: { standard: ["example/model-fast"] },
  });
  const worker = handle.createWorker({ agentId: "main" });
  const out = await dispatchTask(task(), { worker, resolveModel: () => "example/model-fast" });
  assert.equal(out.output.text, "answer");
  assert.deepEqual(order, ["admitted", "first-tool-call", "wait"]);
});

test("a held call is blocked when admission never confirms, or the binding is released", async () => {
  const slow = new ToolGuard({ admissionWaitMs: 20 });
  slow.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  // The production timer is intentionally unref'ed. Keep this test worker alive
  // while asserting the timeout path, including under c8/CI.
  const keepAlive = setTimeout(() => {}, 100);
  const timedOut = await slow.checkWhenAdmitted({
    sessionKey: KEY,
    runId: "run-1",
    toolName: "read",
  });
  clearTimeout(keepAlive);
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

test("toolCallId dedupes repeated hook checks and blocks reuse for another tool", () => {
  const guard = new ToolGuard();
  guard.bind({
    sessionKey: KEY,
    taskId: "t",
    allowedTools: ["read", "write"],
    budget: { maxCalls: 1, timeoutMs: 1000 },
  });
  guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  // Several registered hooks observing the same logical call charge it once.
  assert.deepEqual(call(guard, { toolCallId: "c1" }), {});
  assert.deepEqual(call(guard, { toolCallId: "c1" }), {});
  // Reusing the id for a different granted tool is refused, not re-charged.
  assert.match(
    call(guard, { toolName: "write", toolCallId: "c1" }).blockReason,
    /reused for another tool/,
  );
  // A fresh call id with the budget already spent still blocks.
  assert.match(call(guard, { toolCallId: "c2" }).blockReason, /call budget/);
});

test("each block reason is recorded distinctly with hashed identifiers only", () => {
  const events = [];
  const clock = { t: 0 };
  const guard = new ToolGuard({ now: () => clock.t, onDecision: (d) => events.push(d) });
  guard.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  assert.equal(call(guard).block, true); // unconfirmed
  guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  guard.check({ sessionKey: "agent:main:subagent:oca-other", runId: "run-1", toolName: "read" });
  call(guard, { runId: "run-SECRET" });
  call(guard, { toolName: "exec" });
  call(guard, { toolName: "sessions_spawn" });
  assert.deepEqual(call(guard), {});
  assert.deepEqual(call(guard), {});
  call(guard); // call budget
  clock.t = 5000;
  call(guard); // time budget
  assert.deepEqual(
    events.map((e) => e.reason),
    [
      DENIAL_REASONS.UNCONFIRMED,
      DENIAL_REASONS.WRONG_SESSION,
      DENIAL_REASONS.RUN_MISMATCH,
      DENIAL_REASONS.NOT_GRANTED,
      DENIAL_REASONS.DELEGATION,
      DENIAL_REASONS.CALL_BUDGET,
      DENIAL_REASONS.TIME_BUDGET,
    ],
  );
  assert.equal(new Set(Object.values(DENIAL_REASONS)).size, Object.keys(DENIAL_REASONS).length);
  const dump = JSON.stringify(events);
  for (const raw of [KEY, "oca-1111", "oca-other", "run-1", "run-SECRET"]) {
    assert.equal(dump.includes(raw), false, `leaked ${raw}`);
  }
  assert.match(events[0].session, /^[0-9a-f]{12}$/);
  assert.equal(events[0].session, events[2].session);
  assert.notEqual(events[0].session, events[1].session);
  assert.deepEqual(Object.keys(events[0]).sort(), ["reason", "run", "session", "toolName"]);
  assert.equal(guard.denials.length, events.length);
});

test("allowed and foreign-session calls are never logged", () => {
  const events = [];
  const guard = new ToolGuard({ onDecision: (d) => events.push(d) });
  guard.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  assert.deepEqual(call(guard), {});
  assert.deepEqual(guard.check({ sessionKey: "agent:main:main", toolName: "exec" }), {});
  assert.deepEqual(guard.check(), {});
  assert.deepEqual(events, []);
  assert.deepEqual(guard.denials, []);
});

test("a throwing callback cannot weaken blocking; unsafe tool names and growth are bounded", () => {
  const guard = new ToolGuard({
    onDecision: () => {
      throw new Error("sink down");
    },
  });
  guard.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  const r = call(guard, { toolName: "rm -rf /secret path" });
  assert.equal(r.block, true);
  assert.equal(Object.keys(r).includes("reason"), false);
  for (let i = 0; i < 150; i += 1) call(guard, { toolName: "exec" });
  assert.equal(guard.denials.length, 100);
  assert.equal(guard.denials[0].toolName, "exec");
  assert.equal(guard.denials.at(-1).toolName, "exec");
  assert.equal(
    guard.denials.some((d) => d.toolName === null),
    false,
  );
});

test("distinct denied call ids are reported once and the dedupe set stays bounded", () => {
  const reported = [];
  const guard = new ToolGuard({ onDecision: (d) => reported.push(d) });
  guard.bind({ sessionKey: KEY, taskId: "t", allowedTools: ["read"], budget });
  guard.confirm(KEY, { runId: "run-1", sessionKey: KEY });
  for (let i = 0; i < 150; i += 1) {
    assert.equal(call(guard, { toolName: "exec", toolCallId: `denied-${i}` }).block, true);
  }
  assert.equal(reported.length, 150);
  // The dedupe set evicts the oldest ids past its bound, so an evicted id is
  // reported again rather than being silently suppressed forever.
  assert.equal(call(guard, { toolName: "exec", toolCallId: "denied-0" }).block, true);
  assert.equal(reported.length, 151);
  assert.equal(guard.denials.length, 100);
});

test("plugin default guard warns once per denied tool call with sanitized fields", async () => {
  const warns = [];
  let hook;
  const api = {
    logger: { warn: (...a) => warns.push(a) },
    on: (_name, fn) => {
      hook = fn;
    },
    runtime: { subagent: {} },
  };
  const handle = registerOrchestration(api, {});
  const sessionKey = `${KEY}-logging`;
  handle.guard.bind({ sessionKey, taskId: "log-test", allowedTools: ["read"], budget });
  handle.guard.confirm(sessionKey, { runId: "run-log-test", sessionKey });
  const event = {
    toolName: "exec",
    runId: "run-log-test",
    toolCallId: "denied-call-1",
    params: { cmd: "secret" },
  };
  const ctx = { sessionKey };
  assert.equal((await hook(event, ctx)).block, true);
  assert.equal((await hook(event, ctx)).block, true);
  assert.equal(warns.length, 1);
  assert.equal(warns[0][1].reason, DENIAL_REASONS.NOT_GRANTED);
  assert.equal(JSON.stringify(warns).includes("secret"), false);
  assert.equal(JSON.stringify(warns).includes(sessionKey), false);
});

test("lifecycle diagnostics are bounded, fail-neutral, and ignore non-function sinks", () => {
  const events = [];
  const guard = new ToolGuard({ onLifecycle: (event) => events.push(event) });
  guard.lifecycle({ event: "one" });
  assert.deepEqual(events, [{ event: "one" }]);
  // A throwing diagnostics sink can never change enforcement.
  const throwing = new ToolGuard({
    onLifecycle: () => {
      throw new Error("sink down");
    },
  });
  throwing.lifecycle({ event: "swallowed" });
  // Non-function sinks (constructor and setter) are ignored, not invoked.
  const quiet = new ToolGuard({ onLifecycle: "not a function" });
  quiet.lifecycle({ event: "ignored" });
  quiet.setOnLifecycle("still not a function");
  quiet.lifecycle({ event: "ignored" });
  assert.deepEqual(events, [{ event: "one" }]);
  // The stream is capped per guard so a hot session cannot log unbounded.
  const capped = new ToolGuard({ onLifecycle: (event) => events.push(event) });
  for (let i = 0; i < 4100; i += 1) capped.lifecycle({ event: "e", i });
  assert.equal(events.length, 1 + 4096);
  assert.equal(events.at(-1).event, "e");
});

test("worker lifecycle events tolerate guards without fingerprinting or lifecycle", async () => {
  const events = [];
  const guard = {
    bind: () => {},
    confirm: () => {},
    release: () => {},
    lifecycle: (event) => events.push(event),
  };
  const worker = createBoundWorker({ subagent: fakeSubagent(), guard, agentId: "main" });
  const out = await worker({
    task: task(),
    grant: { mode: "tools", allowedTools: ["read"], budget },
    model: "example/model-fast",
  });
  assert.equal(out.text, "answer");
  assert.deepEqual(
    events.map((e) => e.event),
    ["worker_started", "run_wait_started", "run_wait_finished"],
  );
  assert.equal(events[0].session, null);
  assert.equal(events[1].session, null);
  assert.equal(events[1].run, null);
  assert.equal(events[2].status, "ok");
  // A guard exposing only bind/confirm/release is still a valid no-op target.
  const bare = { bind: () => {}, confirm: () => {}, release: () => {} };
  const plain = createBoundWorker({ subagent: fakeSubagent(), guard: bare, agentId: "main" });
  const done = await plain({
    task: task(),
    grant: { mode: "tools", allowedTools: [], budget },
    model: "example/model-fast",
  });
  assert.equal(done.mode, "tools");
});

test("worker lifecycle reports unknown statuses and sanitized error classes", async () => {
  const events = [];
  const guard = {
    bind: () => {},
    confirm: () => {},
    release: () => {},
    lifecycle: (event) => events.push(event),
  };
  const run = (subagent) =>
    createBoundWorker({ subagent, guard, agentId: "main" })({
      task: task(),
      grant: { mode: "tools", allowedTools: [], budget },
      model: "example/model-fast",
    });

  await assert.rejects(
    run(fakeSubagent({ waitForRun: async () => ({ status: "weird" }) })),
    /status weird/,
  );
  assert.equal(events.find((e) => e.event === "run_wait_finished").status, "other");

  const timeout = new Error("slow");
  timeout.name = "TimeoutError";
  await assert.rejects(
    run(
      fakeSubagent({
        waitForRun: async () => {
          throw timeout;
        },
      }),
    ),
  );
  const timedOut = events.filter((e) => e.event === "worker_ended").at(-1);
  assert.equal(timedOut.reason, "timeout");
  assert.equal(timedOut.errorClass, "TimeoutError");
  assert.equal(JSON.stringify(timedOut).includes("slow"), false);

  const notAnError = { name: 42 };
  await assert.rejects(
    run(
      fakeSubagent({
        waitForRun: async () => {
          throw notAnError;
        },
      }),
    ),
  );
  const failed = events.filter((e) => e.event === "worker_ended").at(-1);
  assert.equal(failed.reason, "failed");
  assert.equal(failed.errorClass, "Error");
});
