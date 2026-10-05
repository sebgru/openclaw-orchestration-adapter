import { assertValidTask } from "./contracts.js";
import { readyTaskIds, transitionTask } from "./plan.js";

function makeGrant(task) {
  return Object.freeze({
    taskId: task.id,
    scope: structuredClone(task.scope),
    allowedTools: [...task.allowedTools],
    prohibitedActions: [...task.prohibitedActions],
    mayDelegate: false,
    budget: structuredClone(task.budget),
    outputSchema: structuredClone(task.outputSchema),
  });
}

function abortError(reason = "Task cancelled") {
  const error = new Error(String(reason));
  error.name = "AbortError";
  return error;
}

/**
 * Mark an error as an explicitly classified infrastructure fault (the dispatch
 * module's own budget/timeout enforcement, not a worker, resolver, or verifier
 * outcome). Only errors carrying this classification are eligible for retry.
 */
function infrastructureError(error) {
  error.failureKind = "infrastructure";
  error.retryable = true;
  return error;
}

function isRetryableInfrastructureError(error) {
  return Boolean(error) && error.failureKind === "infrastructure" && error.retryable === true;
}

async function runBoundedVerifier(verify, args, timeoutMs, signal) {
  const controller = new AbortController();
  let timeoutId;
  let abortListener;
  const cancellation = new Promise((_, reject) => {
    abortListener = () => {
      controller.abort(signal.reason);
      reject(abortError(signal.reason || "Task cancelled"));
    };
    if (signal?.aborted) abortListener();
    else signal?.addEventListener("abort", abortListener, { once: true });
  });
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort("Verification timed out");
      const error = new Error("Independent verification exceeded the task timeout");
      error.name = "TimeoutError";
      reject(infrastructureError(error));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        verify(args[0], args[1], { ...args[2], signal: controller.signal }),
      ),
      timeout,
      cancellation,
    ]);
  } finally {
    clearTimeout(timeoutId);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}

/**
 * Dispatch one validated task using caller-supplied policy and worker adapters.
 * The model resolver and verifier are deliberately injected; this module owns
 * neither provider selection nor claims of completion.
 */
export async function dispatchTask(task, { worker, resolveModel, signal } = {}) {
  assertValidTask(task);
  if (typeof worker !== "function") throw new TypeError("worker must be a function");
  if (typeof resolveModel !== "function") throw new TypeError("resolveModel must be a function");
  if (signal?.aborted) throw abortError(signal.reason || "Task cancelled");

  const controller = new AbortController();
  let timeoutId;
  let abortListener;
  const cancellation = new Promise((_, reject) => {
    abortListener = () => {
      controller.abort(signal.reason);
      reject(abortError(signal.reason || "Task cancelled"));
    };
    if (signal?.aborted) abortListener();
    else signal?.addEventListener("abort", abortListener, { once: true });
  });
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort("Task timed out");
      const error = new Error(`Task ${task.id} exceeded ${task.budget.timeoutMs}ms`);
      error.name = "TimeoutError";
      reject(infrastructureError(error));
    }, task.budget.timeoutMs);
  });

  try {
    const model = await Promise.race([
      Promise.resolve().then(() => resolveModel(task.routeTier, structuredClone(task))),
      timeout,
      cancellation,
    ]);
    if (typeof model !== "string" || model.trim() === "") {
      throw new TypeError("resolveModel must return a non-empty model identifier");
    }
    const work = Promise.resolve().then(() =>
      worker({
        task: structuredClone(task),
        grant: makeGrant(task),
        model,
        signal: controller.signal,
      }),
    );
    const output = await Promise.race([work, timeout, cancellation]);
    return { taskId: task.id, model, output };
  } finally {
    clearTimeout(timeoutId);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}

/**
 * Dispatch one dependency-ready wave, capped by maxParallel. Successful worker
 * results remain in `verifying` until an independent verifier accepts them.
 */
export async function dispatchReadyBatch(
  plan,
  { worker, resolveModel, verify, maxParallel = 1, signal } = {},
) {
  if (typeof verify !== "function")
    throw new TypeError("verify must be an independent verifier function");
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 32) {
    throw new RangeError("maxParallel must be an integer from 1 to 32");
  }
  if (signal?.aborted) return { dispatched: [], cancelled: true };

  const taskIds = readyTaskIds(plan).slice(0, maxParallel);
  const results = await Promise.all(
    taskIds.map(async (taskId) => {
      const entry = plan.tasks.get(taskId);
      transitionTask(plan, taskId, "ready");
      transitionTask(plan, taskId, "running");
      try {
        const result = await dispatchTask(entry.contract, { worker, resolveModel, signal });
        transitionTask(plan, taskId, "verifying");
        const verification = await runBoundedVerifier(
          verify,
          [entry.contract, result.output, { model: result.model }],
          entry.contract.budget.timeoutMs,
          signal,
        );
        if (!verification || typeof verification.ok !== "boolean") {
          throw new TypeError("verify must return an object with boolean ok");
        }
        transitionTask(
          plan,
          taskId,
          verification.ok ? "succeeded" : "failed",
          verification.ok ? undefined : { reason: "verifier-rejected", retryable: false },
        );
        return {
          taskId,
          state: verification.ok ? "succeeded" : "failed",
          model: result.model,
          verification,
        };
      } catch (error) {
        const current = plan.tasks.get(taskId)?.state;
        if (current === "running" || current === "verifying") {
          transitionTask(
            plan,
            taskId,
            signal?.aborted ? "cancelled" : "failed",
            signal?.aborted
              ? undefined
              : { reason: error.name || "Error", retryable: isRetryableInfrastructureError(error) },
          );
        }
        return {
          taskId,
          state: plan.tasks.get(taskId)?.state ?? "failed",
          error: {
            name: error.name || "Error",
            message: String(error.message || error).slice(0, 500),
          },
        };
      }
    }),
  );
  return { dispatched: results, cancelled: Boolean(signal?.aborted) };
}
