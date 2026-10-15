import {
  DISPATCH_TOOL_NAME,
  createDispatchToolFactory,
  normalizeDispatchConfig,
} from "./agent-tool.js";
import { dispatchReadyBatch, dispatchTask } from "./dispatch.js";
import {
  assertWorkerModel,
  createWorkerModelResolver,
  normalizeWorkerRoutes,
} from "./model-routing.js";
import { ToolGuard } from "./tool-guard.js";
import { createBoundWorker } from "./worker-runtime.js";

const SHARED_GUARD = Symbol.for("openclaw-orchestration-adapter.toolGuard");

/**
 * Process-wide default guard. The host may call register(api) more than once
 * (separate registry loads, possibly re-imported module copies) and run the
 * agent-tool factory from one registration while before_tool_call fires from
 * another. Per-registration guards would split bind/confirm from the hook
 * check, so the default guard is shared via a globalThis symbol, which also
 * survives duplicate module instances. Because every registration also adds
 * its own before_tool_call hook on that shared guard, one logical call may be
 * checked several times; the hook forwards event.toolCallId so the guard
 * charges each call once (see ToolGuard.check).
 */
function denialLogger(api) {
  return typeof api?.logger?.warn === "function"
    ? (denial) => api.logger.warn("orchestration-adapter: tool call denied", denial)
    : undefined;
}

export function sharedToolGuard(api) {
  const existing = globalThis[SHARED_GUARD];
  if (isGuardLike(existing)) {
    existing.setOnDecision?.(denialLogger(api));
    return existing;
  }
  // Missing or tampered slot: install a fresh guard (no bindings, so workers
  // fail closed) as a non-writable, non-enumerable property.
  const guard = new ToolGuard({ onDecision: denialLogger(api) });
  Object.defineProperty(globalThis, SHARED_GUARD, {
    value: guard,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return guard;
}

// Duck-typed on purpose: a re-imported module copy has its own ToolGuard class.
function isGuardLike(g) {
  return (
    g !== null &&
    typeof g === "object" &&
    ["bind", "confirm", "release", "check", "checkWhenAdmitted"].every(
      (m) => typeof g[m] === "function",
    )
  );
}

/**
 * Register the enforcement hook on a public plugin API and return the runtime
 * handle. Uses only api.on("before_tool_call") and api.runtime.subagent.
 * The handler is async: it may wait briefly for run admission (see ToolGuard).
 * `block: true` is terminal in the typed hook runner (docs: plugins/hooks/tool-policy)
 * and handler errors/timeouts fail closed; native Codex/CLI tool relays support
 * blocking but this is verified only from docs, not by a live run.
 *
 * When `dispatch` config is present, one optional agent tool (`orchestration_dispatch`)
 * is registered via api.registerTool(factory, { name, optional: true }); it is only
 * exposed to verified-owner, non-sandboxed runs and must be allowlisted by the operator.
 *
 * Model routing here is worker-only: no model-resolution hook is registered, so
 * the owner/main-session model chain is never touched. Every handle-created
 * worker rejects models outside configured route pools (see model-routing.js),
 * including models returned by a caller-supplied resolveModel. The configured
 * workerRoutes are the allow-list; the package defines no provider-specific models.
 */
export function registerOrchestration(
  api,
  { guard = sharedToolGuard(api), agentId, workerRoutes, dispatch } = {},
) {
  const routes = normalizeWorkerRoutes(workerRoutes);
  const dispatchLimits = normalizeDispatchConfig(dispatch);
  api.on(
    "before_tool_call",
    (event, ctx) =>
      guard.checkWhenAdmitted({
        sessionKey: ctx?.sessionKey,
        runId: event?.runId ?? ctx?.runId,
        toolName: event?.toolName,
        toolCallId: event?.toolCallId,
      }),
    { priority: 1000 },
  );
  const createWorker = ({ agentId: id = agentId, buildMessage } = {}) =>
    createBoundWorker({
      subagent: api.runtime.subagent,
      guard,
      agentId: id,
      buildMessage,
      checkModel: (model, task) => assertWorkerModel(model, { routes, tier: task?.routeTier }),
    });
  const resolverFor = ({ resolveModel, isAvailable }) =>
    resolveModel ?? createWorkerModelResolver({ routes, isAvailable });
  const handle = {
    guard,
    routes,
    createWorker,
    /** Public dispatch entry: one validated task through a guard-bound worker. */
    dispatchTask: (task, { resolveModel, isAvailable, signal, agentId: id, buildMessage } = {}) =>
      dispatchTask(task, {
        worker: createWorker({ agentId: id, buildMessage }),
        resolveModel: resolverFor({ resolveModel, isAvailable }),
        signal,
      }),
    /** Public dispatch entry: one dependency-ready wave with independent verification. */
    dispatchReadyBatch: (
      plan,
      { agentId: id, buildMessage, resolveModel, isAvailable, ...options } = {},
    ) =>
      dispatchReadyBatch(plan, {
        ...options,
        resolveModel: resolverFor({ resolveModel, isAvailable }),
        worker: createWorker({ agentId: id, buildMessage }),
      }),
  };
  if (dispatchLimits) {
    if (typeof api.registerTool !== "function") throw new TypeError("api.registerTool required");
    api.registerTool(
      createDispatchToolFactory({ getHandle: () => handle, limits: dispatchLimits }),
      {
        name: DISPATCH_TOOL_NAME,
        optional: true,
      },
    );
  }
  handles.set(api, handle);
  return handle;
}

const handles = new WeakMap();

/** The handle created by register() for this plugin API, or undefined when inactive. */
export function getOrchestration(api) {
  return handles.get(api);
}

export default {
  id: "openclaw-orchestration-adapter",
  name: "Orchestration Adapter",
  register(api) {
    if (api.pluginConfig?.enabled !== true) return;
    registerOrchestration(api, {
      agentId: api.pluginConfig.agentId,
      workerRoutes: api.pluginConfig.workerRoutes,
      dispatch: api.pluginConfig.dispatch,
    });
  },
};
