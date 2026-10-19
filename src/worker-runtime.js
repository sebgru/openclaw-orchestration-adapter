import { randomUUID } from "node:crypto";
import { newWorkerSessionKey } from "./tool-guard.js";
import { createWorkerBrief } from "./worker-brief.js";

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
 * Default worker message: the bounded contract brief (goal, success criteria,
 * prohibited actions, budget, output schema). No memory receipt or content is
 * passed, so the brief never carries memory evidence.
 */
export function defaultWorkerMessage(task) {
  const { task: contract, authority } = createWorkerBrief(task);
  const brief = {
    task: contract,
    authority: {
      prohibitedActions: authority.prohibitedActions,
      mayDelegate: authority.mayDelegate,
      maxCalls: authority.maxCalls,
      maxTokens: authority.maxTokens,
      timeoutMs: authority.timeoutMs,
      maxRetries: authority.maxRetries,
    },
  };
  return [
    "Complete this task within the contract below. Meet every success criterion,",
    "avoid every prohibited action, stay within the budget, and answer in the",
    "requested output schema. Do not delegate.",
    "",
    JSON.stringify(brief, null, 2),
  ].join("\n");
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
 * toolsAlsoAllow is additive, not a ceiling, so it is passed only for granted
 * tools in `ownedTools` (tools this plugin itself registers, e.g. the canary);
 * host tools are never added. The ceiling is the before_tool_call guard in plugin.js.
 */
export function createBoundWorker({
  subagent,
  guard,
  agentId,
  buildMessage,
  checkModel,
  ownedTools = [],
}) {
  if (!subagent || typeof subagent.run !== "function")
    throw new TypeError("subagent runtime required");
  if (!guard) throw new TypeError("guard required");
  const message = buildMessage ?? defaultWorkerMessage;

  return async function worker({ task, grant, model, signal }) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    // Fail closed before any runtime call: the worker never starts on a rejected model.
    checkModel?.(model, task);
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
    const correlationId = randomUUID();
    const emit = (event, fields = {}) => guard.lifecycle?.({ event, correlationId, ...fields });
    const alsoAllow = grant.allowedTools.filter((t) => ownedTools.includes(t));
    guard.bind({
      sessionKey,
      taskId: task.id,
      allowedTools: grant.allowedTools,
      ...(grant.allowedCalls === undefined ? {} : { allowedCalls: grant.allowedCalls }),
      budget: grant.budget,
      correlationId,
    });
    let terminalReason = "failed";
    emit("worker_started", { session: guard.fingerprint?.(sessionKey) ?? null });
    const onAbort = () => {
      terminalReason = "aborted";
      emit("abort_requested");
      guard.release(sessionKey, "aborted");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const accepted = await subagent.run({
        sessionKey,
        message: message(task, grant),
        promptMode: "minimal",
        deliver: false,
        ...(alsoAllow.length ? { toolsAlsoAllow: alsoAllow } : {}),
        ...splitModel(model),
      });
      guard.confirm(sessionKey, accepted);
      emit("run_wait_started", {
        session: guard.fingerprint?.(sessionKey) ?? null,
        run: guard.fingerprint?.(accepted.runId) ?? null,
      });
      const result = await subagent.waitForRun({
        runId: accepted.runId,
        timeoutMs: grant.budget.timeoutMs,
      });
      const safeStatus = ["ok", "error", "timeout", "cancelled"].includes(result?.status)
        ? result.status
        : "other";
      emit("run_wait_finished", { status: safeStatus });
      if (result.status !== "ok") {
        throw new Error(`worker run ended with status ${result.status}`);
      }
      const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 20 });
      terminalReason = "completed";
      return {
        mode: "tools",
        runId: accepted.runId,
        sessionKey,
        text: lastAssistantText(messages),
      };
    } catch (error) {
      if (terminalReason !== "aborted") {
        terminalReason = error?.name === "TimeoutError" ? "timeout" : "failed";
        emit("worker_ended", {
          reason: terminalReason,
          errorClass: typeof error?.name === "string" ? error.name.slice(0, 40) : "Error",
        });
      }
      throw error;
      // c8 reports a phantom uncovered branch on the `finally` keyword when a
      // `return` lives in the `try`; the finally body is fully exercised.
    } /* c8 ignore next */ finally {
      signal?.removeEventListener("abort", onAbort);
      guard.release(sessionKey, terminalReason);
      try {
        await subagent.deleteSession({ sessionKey });
      } catch {
        // Best effort: the binding is already gone, so the session can run nothing.
      }
    }
  };
}
