// Task 12.2 local acceptance: call/time budget controls vs advisory token hint.
// Fake-host only (in-memory subagent runtime). This proves adapter-side behavior
// in src/dispatch.js, src/worker-runtime.js and src/tool-guard.js; it does NOT
// prove live Gateway acceptance, host cancellation of a running model, or real
// token accounting.
import test from "node:test";
import assert from "node:assert/strict";
import { DENIAL_REASONS, ToolGuard, createBoundWorker, dispatchTask } from "../src/index.js";
import { resolveMaxTokens } from "../src/contracts.js";

function task(budget = {}, over = {}) {
  return {
    contractVersion: 1,
    id: "t12-2",
    goal: "bounded work",
    successCriteria: ["done"],
    allowedTools: ["read"],
    prohibitedActions: [],
    routeTier: "standard",
    budget: { maxCalls: 2, maxTokens: 100, timeoutMs: 1000, maxRetries: 0, ...budget },
    scope: { tenantId: "a", channel: "c", conversationId: "d" },
    outputSchema: { type: "object" },
    ...over,
  };
}

// Fake host. `onWait({ key, ask })` plays the model's tool calls through the guard,
// as the host would via before_tool_call. Nothing here counts or limits tokens.
function fakeHost(guard, { onWait, waitForRun } = {}) {
  const calls = [];
  let key;
  const ask = (toolName = "read", extra = {}) =>
    guard.check({ sessionKey: key, runId: "run-1", toolName, ...extra });
  return {
    calls,
    async complete(a) {
      calls.push(["complete", a]);
      return { text: "completion" };
    },
    async run(a) {
      calls.push(["run", a]);
      key = a.sessionKey;
      return { runId: "run-1", sessionKey: a.sessionKey };
    },
    async waitForRun(a) {
      calls.push(["wait", a]);
      if (waitForRun) return waitForRun(a);
      await onWait?.({ key, ask });
      return { status: "ok" };
    },
    async getSessionMessages() {
      return { messages: [{ role: "assistant", content: "answer" }] };
    },
    async deleteSession(a) {
      calls.push(["delete", a]);
    },
  };
}

const run = (t, subagent, guard, extra = {}) =>
  dispatchTask(t, {
    worker: createBoundWorker({ subagent, guard, agentId: "main" }),
    resolveModel: () => "example/model",
    ...extra,
  });

test("success: calls up to maxCalls pass, the timeout is forwarded to the host, binding released", async () => {
  const guard = new ToolGuard();
  const results = [];
  const host = fakeHost(guard, {
    onWait: ({ ask }) => {
      results.push(ask("read", { toolCallId: "a" }), ask("read", { toolCallId: "b" }));
      // A repeated host callback for an already charged id is not charged again.
      results.push(ask("read", { toolCallId: "b" }));
    },
  });
  const out = await run(task({ maxCalls: 2, timeoutMs: 750 }), host, guard);
  assert.deepEqual(results, [{}, {}, {}]);
  assert.equal(out.output.text, "answer");
  assert.equal(host.calls.find((c) => c[0] === "wait")[1].timeoutMs, 750);
  assert.equal(guard.size, 0);
  assert.equal(host.calls.at(-1)[0], "delete");
});

test("over-call: the call beyond maxCalls is blocked with call_budget_exhausted; the run itself is not stopped", async () => {
  const guard = new ToolGuard();
  const seen = [];
  const host = fakeHost(guard, {
    onWait: ({ ask }) => {
      for (const id of ["a", "b", "c", "d"]) seen.push(ask("read", { toolCallId: id }));
    },
  });
  const out = await run(task({ maxCalls: 2 }), host, guard);
  assert.deepEqual(
    seen.map((r) => Boolean(r.block)),
    [false, false, true, true],
  );
  assert.match(seen[2].blockReason, /tool call budget exhausted/);
  assert.equal(seen[2].reason, DENIAL_REASONS.CALL_BUDGET);
  assert.deepEqual(
    guard.denials.map((d) => d.reason),
    [DENIAL_REASONS.CALL_BUDGET, DENIAL_REASONS.CALL_BUDGET],
  );
  // Limitation: blocking only denies the tool call. A fake run that ignores the
  // denial still ends "ok"; the adapter does not terminate the model run.
  assert.equal(out.output.text, "answer");
  assert.equal(guard.size, 0);
});

test("time limit inside the run: calls after the deadline are blocked with time_budget_exhausted", async () => {
  const clock = { t: 1_000 };
  const guard = new ToolGuard({ now: () => clock.t });
  const seen = [];
  const host = fakeHost(guard, {
    onWait: ({ ask }) => {
      seen.push(ask("read", { toolCallId: "a" }));
      clock.t += 499;
      seen.push(ask("read", { toolCallId: "b" }));
      clock.t += 1; // now == deadline (bind time + timeoutMs): exhausted
      seen.push(ask("read", { toolCallId: "c" }));
    },
  });
  await run(task({ maxCalls: 10, timeoutMs: 500 }), host, guard);
  assert.deepEqual(
    seen.map((r) => Boolean(r.block)),
    [false, false, true],
  );
  assert.equal(seen[2].reason, DENIAL_REASONS.TIME_BUDGET);
});

test("timeout: dispatch rejects with TimeoutError, aborts the worker, revokes the binding", async () => {
  const guard = new ToolGuard();
  let key;
  const host = fakeHost(guard, { waitForRun: () => new Promise(() => {}) });
  const origRun = host.run;
  host.run = async (a) => {
    key = a.sessionKey;
    return origRun(a);
  };
  const started = Date.now();
  await assert.rejects(run(task({ timeoutMs: 60 }), host, guard), {
    name: "TimeoutError",
    message: /exceeded 60ms/,
  });
  assert.ok(Date.now() - started < 1000);
  // Cleanup runs asynchronously after the abort; wait for the binding release.
  for (let i = 0; i < 50 && guard.size > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(guard.size, 0);
  // The worker is parked on a waitForRun() that never settles, so its finally
  // block never runs; the abort handler itself requests a best-effort
  // deleteSession exactly once (cleanup, not host-run cancellation).
  const deletes = host.calls.filter((c) => c[0] === "delete");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0][1].sessionKey, key);
  // Limitation: the fake host has no cancel; the only enforced effect is that any
  // later tool call from that session is blocked (fail closed).
  const late = guard.check({ sessionKey: key, runId: "run-1", toolName: "read" });
  assert.equal(late.block, true);
  assert.equal(late.reason, DENIAL_REASONS.WRONG_SESSION);
});

test("completion mode: only the time limit is passed to the host; maxCalls has no enforcement point", async () => {
  const guard = new ToolGuard();
  const host = fakeHost(guard);
  const out = await run(
    task({ maxCalls: 1, timeoutMs: 321 }, { mode: "completion", allowedTools: [] }),
    host,
    guard,
  );
  assert.equal(out.output.text, "completion");
  assert.deepEqual(
    host.calls.map((c) => c[0]),
    ["complete"],
  );
  const args = host.calls[0][1];
  assert.equal(args.timeoutMs, 321);
  assert.equal("maxCalls" in args, false);
  assert.equal("maxTokens" in args, false);
  assert.equal(guard.size, 0);
});

test("maxTokens is an advisory hint only: written into the worker brief, never passed to the host or the guard", async () => {
  const guard = new ToolGuard();
  const host = fakeHost(guard, {
    // The fake "model" is free to exceed any token figure; nothing observes or blocks it.
    onWait: ({ ask }) => assert.deepEqual(ask("read", { toolCallId: "a" }), {}),
  });
  const out = await run(task({ maxTokens: 7 }), host, guard);
  assert.equal(out.output.text, "answer");
  const runArgs = host.calls.find((c) => c[0] === "run")[1];
  assert.ok(runArgs.message.includes('"maxTokens": 7'), "hint is in the prompt text");
  assert.equal("maxTokens" in runArgs, false);
  assert.equal("maxTokens" in host.calls.find((c) => c[0] === "wait")[1], false);
  assert.throws(
    () =>
      guard.bind({
        sessionKey: "agent:main:subagent:oca-x",
        taskId: "t",
        allowedTools: ["read"],
        budget: { maxTokens: 7 },
      }),
    /maxCalls/,
  );

  // Omitted maxTokens resolves to the default hint, still advisory.
  const host2 = fakeHost(guard);
  await run(task({ maxTokens: undefined }), host2, guard);
  const text = host2.calls.find((c) => c[0] === "run")[1].message;
  assert.ok(text.includes(`"maxTokens": ${resolveMaxTokens(undefined)}`));
});
