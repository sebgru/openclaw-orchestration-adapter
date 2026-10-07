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
export function registerOrchestration(api, { guard = new ToolGuard() } = {}) {
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
  return {
    guard,
    createWorker: ({ agentId, buildMessage }) =>
      createBoundWorker({ subagent: api.runtime.subagent, guard, agentId, buildMessage }),
  };
}

export default {
  id: "openclaw-orchestration-adapter",
  name: "Orchestration Adapter",
  register(api) {
    if (api.pluginConfig?.enabled !== true) return;
    registerOrchestration(api);
  },
};
