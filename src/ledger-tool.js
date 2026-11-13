import path from "node:path";
import { createLifecycleObserver, reconcileObservations } from "./lifecycle-observer.js";
import {
  assessAcceptance,
  createTaskLedger,
  deriveStatusView,
  renderStatusMarkdown,
} from "./task-ledger.js";

export const LEDGER_TOOL_NAME = "orchestration_ledger_status";

/** Validate `ledger` plugin config. Absent means the status tool is not registered. */
export function normalizeLedgerConfig(config) {
  if (config === undefined) return undefined;
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new TypeError("ledger must be an object");
  for (const key of Object.keys(config))
    if (key !== "file" && key !== "observe")
      throw new TypeError(`ledger.${key} is not a known setting`);
  if (typeof config.file !== "string" || !path.isAbsolute(config.file))
    throw new TypeError("ledger.file must be an absolute path");
  if (config.observe !== undefined && typeof config.observe !== "boolean")
    throw new TypeError("ledger.observe must be a boolean");
  return Object.freeze({
    file: config.file,
    observe: config.observe === true,
    observationsFile: `${config.file}.observed.jsonl`,
  });
}

/**
 * Read-only, owner-only view of the coordinator's durable task ledger: task
 * states, the dependency view, chain integrity and acceptance evidence. It never
 * appends events, so it cannot mark work done, approve a gate, or dispatch.
 */
export function createLedgerToolFactory({ limits }) {
  return function ledgerToolFactory(ctx) {
    if (ctx?.senderIsOwner !== true || ctx?.sandboxed === true) return null;
    return {
      name: LEDGER_TOOL_NAME,
      label: "Orchestration ledger status",
      description:
        "Read-only status of the durable orchestration task ledger: per-task state, dependency DAG, blockers, requested vs actual model, integrity, and acceptance evidence.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { gateTaskId: { type: "string", minLength: 1 } },
      },
      async execute(_id, params) {
        let details;
        try {
          const ledger = createTaskLedger({ file: limits.file });
          const state = ledger.state();
          const view = deriveStatusView(state);
          const observations = limits.observe
            ? createLifecycleObserver({ file: limits.observationsFile }).read()
            : [];
          details = {
            ok: true,
            integrity: ledger.integrity(),
            view,
            acceptance: assessAcceptance(state, { gateTaskId: params?.gateTaskId, observations }),
            hostObserved: limits.observe ? reconcileObservations(state, observations) : null,
            markdown: renderStatusMarkdown(view),
          };
        } catch (e) {
          details = { ok: false, code: e?.code ?? "ledger-error", error: String(e?.message ?? e) };
        }
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    };
  };
}
