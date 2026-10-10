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
  { guard = new ToolGuard(), agentId, workerRoutes, dispatch } = {},
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
