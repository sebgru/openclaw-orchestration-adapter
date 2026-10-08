import { newWorkerSessionKey } from "./tool-guard.js";

function splitModel(model) {
  const slash = model.indexOf("/");
  return slash > 0 ? { provider: model.slice(0, slash), model: model.slice(slash + 1) } : { model };
}

function lastAssistantText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "assistant")
      return typeof m.content === "string" ? m.content : (m.content ?? null);
  }
  return null;
}

/**
 * Build a `worker` function for dispatchTask backed by api.runtime.subagent.
 *
 * - mode "completion": tool-free subagent.complete(); no session, no binding.
 * - mode "tools": the sessionKey is chosen here and bound to the exact grant
 *   BEFORE run() is called. run() resolves at ADMISSION, not completion (docs:
 *   concepts/agent-loop "agent RPC ... returns { runId } immediately";
 *   waitForRun() is the separate completion call). The host-issued runId is
 *   attached right after admission via guard.confirm(); a tool call that
 *   arrives in that gap is held by the guard until confirm() (bounded wait,
 *   then terminal block). The runId is never taken from a hook event. The
 *   binding is always released (and the session deleted best-effort) on
 *   completion, timeout, or abort.
 *
 * Cancellation limit: api.runtime.subagent has no cancel/abort call, waitForRun()
 * timeouts do not cancel the run, and deleteSession() is not documented to stop
 * an in-flight run. On abort, timeout, or error the only guaranteed action is
 * revoking the binding, which makes every later before_tool_call in that
 * session a terminal block (fail closed). The model run itself may keep going
 * until the host ends it; its output is discarded.
 *
 * toolsAlsoAllow is deliberately never used: it is additive, not a ceiling.
 * The ceiling is the before_tool_call guard in plugin.js.
 */
export function createBoundWorker({ subagent, guard, agentId, buildMessage }) {
  if (!subagent || typeof subagent.run !== "function")
    throw new TypeError("subagent runtime required");
  if (!guard) throw new TypeError("guard required");
  const message = buildMessage ?? ((task) => task.goal);

  return async function worker({ task, grant, model, signal }) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    if (grant.mode === "completion") {
      const { text } = await subagent.complete({
        agentId,
        message: message(task, grant),
        timeoutMs: task.budget.timeoutMs,
        model,
        signal,
      });
      return { mode: "completion", text };
    }

    const sessionKey = newWorkerSessionKey(agentId);
    guard.bind({
      sessionKey,
      taskId: task.id,
      allowedTools: grant.allowedTools,
      budget: grant.budget,
    });
    const onAbort = () => guard.release(sessionKey);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const accepted = await subagent.run({
        sessionKey,
        message: message(task, grant),
        promptMode: "minimal",
        deliver: false,
        ...splitModel(model),
      });
      guard.confirm(sessionKey, accepted);
      const result = await subagent.waitForRun({
        runId: accepted.runId,
        timeoutMs: grant.budget.timeoutMs,
      });
      if (result.status !== "ok") {
        throw new Error(`worker run ended with status ${result.status}`);
      }
      const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 20 });
      return {
        mode: "tools",
        runId: accepted.runId,
        sessionKey,
        text: lastAssistantText(messages),
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      guard.release(sessionKey);
      try {
        await subagent.deleteSession({ sessionKey });
      } catch {
        // Best effort: the binding is already gone, so the session can run nothing.
      }
    }
  };
}
