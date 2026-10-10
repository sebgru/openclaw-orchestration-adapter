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
 * Model routing here is worker-only: no model-resolution hook is registered, so
 * the owner/main-session model chain is never touched. Every handle-created
 * worker rejects models outside the subscription allow-list (see model-routing.js),
 * including models returned by a caller-supplied resolveModel.
 */
export function registerOrchestration(
  api,
  { guard = new ToolGuard(), agentId, workerRoutes } = {},
) {
  const routes = normalizeWorkerRoutes(workerRoutes);
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
  const createWorker = ({ agentId: id = agentId, buildMessage, modelApprovals } = {}) =>
    createBoundWorker({
      subagent: api.runtime.subagent,
      guard,
      agentId: id,
      buildMessage,
      checkModel: (model, task) => assertWorkerModel(model, { task, modelApprovals }),
    });
  const resolverFor = ({ resolveModel, modelApprovals, isAvailable }) =>
    resolveModel ?? createWorkerModelResolver({ routes, modelApprovals, isAvailable });
  const handle = {
    guard,
    routes,
    createWorker,
    /** Public dispatch entry: one validated task through a guard-bound worker. */
    dispatchTask: (
      task,
      { resolveModel, modelApprovals, isAvailable, signal, agentId: id, buildMessage } = {},
    ) =>
      dispatchTask(task, {
        worker: createWorker({ agentId: id, buildMessage, modelApprovals }),
        resolveModel: resolverFor({ resolveModel, modelApprovals, isAvailable }),
        signal,
      }),
    /** Public dispatch entry: one dependency-ready wave with independent verification. */
    dispatchReadyBatch: (
      plan,
      { agentId: id, buildMessage, resolveModel, modelApprovals, isAvailable, ...options } = {},
    ) =>
      dispatchReadyBatch(plan, {
        ...options,
        resolveModel: resolverFor({ resolveModel, modelApprovals, isAvailable }),
        worker: createWorker({ agentId: id, buildMessage, modelApprovals }),
      }),
  };
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
    });
  },
};
