/**
 * Worker-only model routing.
 *
 * This module selects models for dispatched execution workers only. It never
 * touches the owner/main-session model chain, registers no hooks, and reads no
 * Gateway config. Selection is fail-closed: a model outside the subscription
 * allow-list is rejected, and when no allowed candidate is available the
 * resolver throws instead of falling back to any other model.
 */

/** Subscription-backed models that tier routing may select automatically. */
export const WORKER_MODELS = Object.freeze([
  "openai/gpt-6-luna",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-6-sol",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-opus-5-5",
]);

/** Models that are never auto-selected and need an explicit per-task approval. */
export const APPROVAL_ONLY_WORKER_MODELS = Object.freeze(["openai/gpt-6-astra"]);

/** Default tier mapping; candidates are tried in order, never outside the list. */
export const DEFAULT_WORKER_ROUTES = Object.freeze({
  cheap: Object.freeze(["anthropic/claude-haiku-4-5", "openai/gpt-6-luna"]),
  standard: Object.freeze(["openai/gpt-6-luna", "anthropic/claude-sonnet-5-5"]),
  strong: Object.freeze(["openai/gpt-6-sol", "anthropic/claude-opus-5-5"]),
});

const TIERS = Object.keys(DEFAULT_WORKER_ROUTES);
const AUTO = new Set(WORKER_MODELS);
const APPROVAL_ONLY = new Set(APPROVAL_ONLY_WORKER_MODELS);

export class WorkerRouteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkerRouteError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate an optional tier override; it may narrow or reorder the allow-list, never extend it. */
export function normalizeWorkerRoutes(routes) {
  if (routes === undefined) return DEFAULT_WORKER_ROUTES;
  if (!isRecord(routes)) throw new TypeError("workerRoutes must be an object");
  for (const key of Object.keys(routes)) {
    if (!TIERS.includes(key)) throw new TypeError(`workerRoutes.${key} is not a route tier`);
  }
  const normalized = {};
  for (const tier of TIERS) {
    const list = routes[tier] ?? DEFAULT_WORKER_ROUTES[tier];
    if (!Array.isArray(list) || list.length === 0) {
      throw new TypeError(`workerRoutes.${tier} must be a non-empty array`);
    }
    if (new Set(list).size !== list.length) {
      throw new TypeError(`workerRoutes.${tier} must not repeat models`);
    }
    for (const model of list) {
      if (APPROVAL_ONLY.has(model)) {
        throw new TypeError(
          `workerRoutes.${tier}: ${model} is approval-only and never auto-selected`,
        );
      }
      if (!AUTO.has(model)) {
        throw new TypeError(
          `workerRoutes.${tier}: ${String(model)} is not an allowed worker model`,
        );
      }
    }
    normalized[tier] = Object.freeze([...list]);
  }
  return Object.freeze(normalized);
}

function normalizeApprovals(approvals = []) {
  if (!Array.isArray(approvals)) throw new TypeError("modelApprovals must be an array");
  return approvals.map((approval) => {
    if (
      !isRecord(approval) ||
      typeof approval.taskId !== "string" ||
      approval.taskId.trim() === "" ||
      !APPROVAL_ONLY.has(approval.model)
    ) {
      throw new TypeError("each model approval needs a taskId and an approval-only model");
    }
    return Object.freeze({ taskId: approval.taskId, model: approval.model });
  });
}

/**
 * Throw unless `model` may run this task: either an allow-listed subscription
 * model, or an approval-only model with a matching per-task approval.
 */
export function assertWorkerModel(model, { task, modelApprovals } = {}) {
  if (AUTO.has(model)) return model;
  if (APPROVAL_ONLY.has(model)) {
    const approved = normalizeApprovals(modelApprovals).some(
      (approval) => approval.taskId === task?.id && approval.model === model,
    );
    if (approved) return model;
    throw new WorkerRouteError(
      "approval-required",
      `${model} requires an explicit approval for task ${task?.id ?? "(unknown)"}`,
    );
  }
  throw new WorkerRouteError(
    "model-not-allowed",
    `${String(model)} is not an allowed subscription worker model`,
  );
}

/**
 * Build a `resolveModel(routeTier, task)` adapter for dispatchTask.
 *
 * - No `task.model`: the first available candidate of the tier wins.
 * - `task.model` set: that exact model is used if allowed (approval-only models
 *   need a matching `{ taskId, model }` entry in `modelApprovals`).
 * - `isAvailable(model, { tier, taskId })` may veto candidates; when every
 *   candidate is vetoed the resolver throws (no fallback outside the list).
 */
export function createWorkerModelResolver({ routes, modelApprovals, isAvailable } = {}) {
  const table = normalizeWorkerRoutes(routes);
  const approvals = normalizeApprovals(modelApprovals);
  if (isAvailable !== undefined && typeof isAvailable !== "function") {
    throw new TypeError("isAvailable must be a function");
  }
  const available = async (model, tier, taskId) =>
    isAvailable === undefined || (await isAvailable(model, { tier, taskId })) === true;

  return async function resolveWorkerModel(routeTier, task) {
    if (!TIERS.includes(routeTier)) {
      throw new WorkerRouteError("unknown-tier", `routeTier ${String(routeTier)} is not routable`);
    }
    if (task?.model !== undefined) {
      const model = assertWorkerModel(task.model, { task, modelApprovals: approvals });
      if (!(await available(model, routeTier, task.id))) {
        throw new WorkerRouteError("unavailable", `requested worker model ${model} is unavailable`);
      }
      return model;
    }
    for (const model of table[routeTier]) {
      if (await available(model, routeTier, task?.id)) return model;
    }
    throw new WorkerRouteError(
      "unavailable",
      `no allowed worker model is available for tier ${routeTier}`,
    );
  };
}
