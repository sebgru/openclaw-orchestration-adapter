import { dispatchReadyBatch, dispatchTask } from "./dispatch.js";
import { ToolGuard } from "./tool-guard.js";
import { createBoundWorker } from "./worker-runtime.js";

/**
 * Register the enforcement hook on a public plugin API and return the runtime
 * handle. Uses only api.on("before_tool_call") and api.runtime.subagent.
 * The handler is async: it may wait briefly for run admission (see ToolGuard).
 * `block: true` is terminal in the typed hook runner (docs: plugins/hooks/tool-policy)
 * and handler errors/timeouts fail closed; native Codex/CLI tool relays support
 * blocking but this is verified only from docs, not by a live run.
 */
export function registerOrchestration(api, { guard = new ToolGuard(), agentId } = {}) {
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
    createBoundWorker({ subagent: api.runtime.subagent, guard, agentId: id, buildMessage });
  const handle = {
    guard,
    createWorker,
    /** Public dispatch entry: one validated task through a guard-bound worker. */
    dispatchTask: (task, { resolveModel, signal, agentId: id, buildMessage } = {}) =>
      dispatchTask(task, {
        worker: createWorker({ agentId: id, buildMessage }),
        resolveModel,
        signal,
      }),
    /** Public dispatch entry: one dependency-ready wave with independent verification. */
    dispatchReadyBatch: (plan, { agentId: id, buildMessage, ...options } = {}) =>
      dispatchReadyBatch(plan, { ...options, worker: createWorker({ agentId: id, buildMessage }) }),
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
    registerOrchestration(api, { agentId: api.pluginConfig.agentId });
  },
};
