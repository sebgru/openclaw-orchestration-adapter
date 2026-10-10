/**
 * Worker-only model routing.
 *
 * The package has no provider/model defaults. Deployments define candidate pools
 * in plugin config; each pool is also the allow-list for automatic worker use.
 * Candidates are ranked by array order, and at most one model is selected before
 * execution. A failed model invocation is not retried with another candidate.
 */

export const ROUTE_TIERS = Object.freeze(["priority", "cheap", "standard", "strong"]);
export const DEFAULT_WORKER_ROUTES = Object.freeze({});

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

/** Validate deployment-owned route pools; list order defines preference. */
export function normalizeWorkerRoutes(routes) {
  if (routes === undefined) return DEFAULT_WORKER_ROUTES;
  if (!isRecord(routes)) throw new TypeError("workerRoutes must be an object");
  for (const key of Object.keys(routes)) {
    if (!ROUTE_TIERS.includes(key)) throw new TypeError(`workerRoutes.${key} is not a route tier`);
  }
  const normalized = {};
  for (const [tier, list] of Object.entries(routes)) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new TypeError(`workerRoutes.${tier} must be a non-empty array`);
    }
    if (new Set(list).size !== list.length) {
      throw new TypeError(`workerRoutes.${tier} must not repeat models`);
    }
    if (!list.every((model) => typeof model === "string" && model.trim() !== "")) {
      throw new TypeError(`workerRoutes.${tier} entries must be non-empty model references`);
    }
    normalized[tier] = Object.freeze([...list]);
  }
  return Object.freeze(normalized);
}

function configuredModels(routes) {
  return new Set(Object.values(routes).flat());
}

/** Require a model to be explicitly included in a configured worker pool. */
export function assertWorkerModel(model, { routes, tier } = {}) {
  const table = normalizeWorkerRoutes(routes);
  if (
    configuredModels(table).has(model) &&
    (tier === undefined || table[tier]?.includes(model))
  ) {
    return model;
  }
  throw new WorkerRouteError(
    "model-not-allowed",
    `${String(model)} is not configured in the requested worker route pool`,
  );
}

/**
 * Build a `resolveModel(routeTier, task)` adapter for dispatchTask.
 *
 * The first configured candidate is preferred. If an availability callback is
 * supplied, the first available candidate is selected before dispatch. Runtime
 * execution is attempted once; this resolver does not provide execution failover.
 */
export function createWorkerModelResolver({ routes, isAvailable } = {}) {
  const table = normalizeWorkerRoutes(routes);
  if (isAvailable !== undefined && typeof isAvailable !== "function") {
    throw new TypeError("isAvailable must be a function");
  }
  const available = async (model, tier, taskId) =>
    isAvailable === undefined || (await isAvailable(model, { tier, taskId })) === true;

  return async function resolveWorkerModel(routeTier, task) {
    if (!ROUTE_TIERS.includes(routeTier)) {
      throw new WorkerRouteError("unknown-tier", `routeTier ${String(routeTier)} is not routable`);
    }
    const candidates = table[routeTier] ?? [];
    if (task?.model !== undefined) {
      const model = assertWorkerModel(task.model, { routes: table });
      if (!candidates.includes(model)) {
        throw new WorkerRouteError(
          "model-not-allowed",
          `requested model is not in ${routeTier} pool`,
        );
      }
      if (!(await available(model, routeTier, task.id))) {
        throw new WorkerRouteError("unavailable", `requested worker model ${model} is unavailable`);
      }
      return model;
    }
    for (const model of candidates) {
      if (await available(model, routeTier, task?.id)) return model;
    }
    throw new WorkerRouteError(
      "unavailable",
      `no configured worker model is available for tier ${routeTier}`,
    );
  };
}
