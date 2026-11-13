import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";

const HOST_OUTCOME = {
  ok: "ok",
  error: "error",
  timeout: "timeout",
  killed: "aborted",
  reset: "aborted",
  deleted: "aborted",
};

const MAX_BYTES = 1024 * 1024;
const MAX_FIELD = 256;

const text = (v) => (typeof v === "string" && v.length > 0 ? v.slice(0, MAX_FIELD) : null);

/**
 * Host-observed subagent lifecycle log. It is fed only by the host's
 * `subagent_spawned` / `subagent_ended` hooks, never by worker text, so it is a
 * trusted second source for spawn receipts and terminal outcomes. It is a
 * separate append-only file: the coordinator's task ledger stays single-writer.
 * It observes only; it cannot resume the requester session or spawn work.
 */
export function createLifecycleObserver({ file, now = () => new Date().toISOString() } = {}) {
  if (typeof file !== "string" || file.length === 0) throw new TypeError("observer file required");
  let full = false;

  function append(record) {
    if (full) return false;
    try {
      if (existsSync(file) && statSync(file).size >= MAX_BYTES) {
        full = true;
        appendFileSync(file, `${JSON.stringify({ kind: "truncated", ts: now() })}\n`, {
          mode: 0o600,
        });
        return false;
      }
      appendFileSync(file, `${JSON.stringify({ ...record, ts: now() })}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  return {
    observeSpawned(event) {
      const childSessionKey = text(event?.childSessionKey);
      if (!childSessionKey) return false;
      return append({
        kind: "spawned",
        runId: text(event.runId),
        childSessionKey,
        label: text(event.label),
        mode: text(event.mode),
        resolvedModel: text(event.resolvedModel),
        resolvedProvider: text(event.resolvedProvider),
      });
    },
    observeEnded(event) {
      const childSessionKey = text(event?.targetSessionKey);
      if (!childSessionKey) return false;
      return append({
        kind: "ended",
        runId: text(event.runId),
        childSessionKey,
        targetKind: text(event.targetKind),
        outcome: text(event.outcome),
        reason: text(event.reason),
      });
    },
    read() {
      if (!existsSync(file)) return [];
      const out = [];
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // a torn tail line is ignored
        }
      }
      return out;
    },
  };
}

/**
 * Compare ledger tasks with host observations (matched on childSessionKey).
 * Returns per-task findings; never mutates the ledger. Findings tell the
 * coordinator what to reconcile after a lost or reset parent turn.
 */
export function reconcileObservations(state, observations) {
  const byChild = new Map();
  for (const o of observations) {
    if (!o.childSessionKey) continue;
    const e = byChild.get(o.childSessionKey) ?? { spawned: null, ended: null };
    if (o.kind === "spawned") e.spawned ??= o;
    else if (o.kind === "ended") e.ended ??= o;
    byChild.set(o.childSessionKey, e);
  }
  const findings = [];
  if (observations.some((o) => o.kind === "truncated"))
    findings.push({
      code: "observations-truncated",
      detail: "observer log hit its size cap; later host events were not recorded",
    });
  for (const task of state.tasks.values()) {
    const att = task.attempts.at(-1);
    const key = att?.receipt?.childSessionKey;
    if (!key) continue;
    const obs = byChild.get(key);
    if (!obs) continue;
    const base = { taskId: task.id, childSessionKey: key };
    if (obs.spawned) {
      const r = att.receipt;
      for (const [field, host, rec] of [
        ["runId", obs.spawned.runId, r.runId],
        ["resolvedModel", obs.spawned.resolvedModel, r.resolvedModel],
        ["resolvedProvider", obs.spawned.resolvedProvider, r.resolvedProvider],
      ])
        if (host && rec && host !== rec)
          findings.push({
            ...base,
            code: "host-receipt-mismatch",
            detail: `${field}: host observed ${host}, ledger recorded ${rec}`,
          });
    }
    if (obs.ended) {
      const recorded = att.completion?.outcome ?? null;
      if (!recorded && task.status === "running")
        findings.push({
          ...base,
          code: "host-ended-unrecorded",
          detail: `host reports child ended (${obs.ended.outcome ?? "unknown"}) but the ledger has no completion`,
          nextAction:
            "resume: read the child result via sessions_history, then recordCompletion and continue",
        });
      else if (
        recorded &&
        HOST_OUTCOME[obs.ended.outcome] &&
        recorded !== HOST_OUTCOME[obs.ended.outcome]
      )
        findings.push({
          ...base,
          code: "host-outcome-mismatch",
          detail: `host outcome ${obs.ended.outcome}, ledger outcome ${recorded}`,
        });
    }
  }
  return findings;
}
