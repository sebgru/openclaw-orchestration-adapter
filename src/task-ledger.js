import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, truncateSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const LEDGER_VERSION = 1;
export const EVIDENCE_SOURCES = Object.freeze(["standard-spawn", "adapter-fake-host"]);
export const BLOCKER_CODES = Object.freeze([
  "worker-error",
  "timeout",
  "model-unavailable",
  "model-mismatch",
  "receipt-incomplete",
  "review-rejected",
  "interrupted",
  "admission-unknown",
  "publisher-unavailable",
  "gate-rejected",
]);
const REQUIRED_SPAWN_TOOLS = ["sessions_spawn", "sessions_yield", "subagents"];
const OUTCOME_BLOCKER = { error: "worker-error", timeout: "timeout", aborted: "interrupted" };
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const GENESIS = "0".repeat(64);

export class LedgerError extends Error {
  constructor(message, code = "ledger-error") {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

const sha = (text) => createHash("sha256").update(text).digest("hex");
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
const fail = (message, code) => {
  throw new LedgerError(message, code);
};

/**
 * Decide from tools actually evidenced for the parent session whether a
 * completion-driven chain may start. Never infers a capability from a catalog
 * or an assumption: a missing publisher blocks completion, not silently passes.
 */
export function assessContinuationCapability({ tools, publisherTool } = {}) {
  const have = new Set(Array.isArray(tools) ? tools.filter(nonEmpty) : []);
  const missingSpawn = REQUIRED_SPAWN_TOOLS.filter((t) => !have.has(t));
  const publisher = nonEmpty(publisherTool) && have.has(publisherTool) ? publisherTool : null;
  return {
    canDispatch: missingSpawn.length === 0,
    canPublish: publisher !== null,
    publisherTool: publisher,
    missing: [...missingSpawn, ...(publisher ? [] : ["publisher"])],
  };
}

function validateDag(tasks) {
  const ids = new Map();
  for (const t of tasks) {
    if (!t || !LOCAL_ID.test(t.id ?? "")) fail(`invalid task id: ${t?.id}`, "invalid-plan");
    if (ids.has(t.id)) fail(`duplicate task id: ${t.id}`, "invalid-plan");
    ids.set(t.id, t);
  }
  for (const t of tasks)
    for (const d of t.dependencies ?? []) {
      if (d === t.id) fail(`task ${t.id} depends on itself`, "invalid-plan");
      if (!ids.has(d)) fail(`task ${t.id} has unknown dependency ${d}`, "invalid-plan");
    }
  const done = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id)) fail(`dependency cycle at ${id}`, "invalid-plan");
    visiting.add(id);
    for (const d of ids.get(id).dependencies ?? []) visit(d);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of ids.keys()) visit(id);
}

function normalizeTask(t) {
  if (!nonEmpty(t.goal)) fail(`task ${t.id} needs a goal`, "invalid-plan");
  if (!Array.isArray(t.successCriteria) || !t.successCriteria.length)
    fail(`task ${t.id} needs observable successCriteria`, "invalid-plan");
  if (!Number.isInteger(t.timeoutMs) || t.timeoutMs < 1)
    fail(`task ${t.id} needs an explicit timeoutMs`, "invalid-plan");
  const kind = t.kind ?? "worker";
  if (!["worker", "gate"].includes(kind)) fail(`task ${t.id} has unknown kind`, "invalid-plan");
  return {
    id: t.id,
    kind,
    role: t.role ?? null,
    goal: t.goal,
    successCriteria: [...t.successCriteria],
    dependencies: [...(t.dependencies ?? [])],
    requestedModel: kind === "worker" ? (nonEmpty(t.requestedModel) ? t.requestedModel : fail(`task ${t.id} needs requestedModel`, "invalid-plan")) : null,
    timeoutMs: t.timeoutMs,
    maxAttempts: t.maxAttempts ?? 2,
  };
}

function emptyTask(def) {
  return {
    ...def,
    status: "pending",
    attempt: 0,
    attempts: [],
    blocker: null,
    verified: false,
    dashboardRef: null,
    deferredBy: null,
    approvedBy: null,
  };
}

const openAttempt = (task) => task.attempts.at(-1);

/** Fold ledger events into current task state. Pure: replay is the only source of truth. */
export function reduceLedger(events) {
  const state = { planId: null, capability: null, tasks: new Map(), notes: [] };
  const block = (task, code, reason, evidenceSource) => {
    task.status = "blocked";
    task.blocker = { code, reason, resolved: false, evidenceSource: evidenceSource ?? openAttempt(task)?.evidenceSource ?? null };
  };
  for (const { type, data, ts } of events) {
    const task = data.taskId ? state.tasks.get(data.taskId) : undefined;
    const att = task ? openAttempt(task) : undefined;
    switch (type) {
      case "plan_declared":
        state.planId = data.planId;
        for (const def of data.tasks) state.tasks.set(def.id, emptyTask(def));
        break;
      case "task_added":
        state.tasks.set(data.task.id, emptyTask(data.task));
        break;
      case "capability_recorded":
        state.capability = data.capability;
        break;
      case "dispatch_reserved":
        task.attempt = data.attempt;
        task.status = "running";
        task.attempts.push({ n: data.attempt, reservedAt: ts, receipt: null, queued: false, completion: null, verification: null, evidenceSource: null, outcome: "reserved" });
        break;
      case "spawn_receipt":
        att.receipt = data.receipt;
        att.evidenceSource = data.receipt.evidenceSource;
        att.outcome = "running";
        if (data.problem) block(task, data.problem.code, data.problem.reason);
        break;
      case "queued_observed":
        att.queued = true;
        break;
      case "completion_observed":
        att.completion = { outcome: data.outcome, digest: data.digest ?? null, duplicate: false, at: ts };
        att.outcome = data.outcome;
        if (data.outcome === "ok") task.status = "review-ready";
        else block(task, OUTCOME_BLOCKER[data.outcome], data.reason ?? data.outcome);
        break;
      case "completion_duplicate":
      case "completion_unmatched":
        state.notes.push({ type, ts, ...data });
        break;
      case "verification_recorded":
        att.verification = { verdict: data.verdict, evidenceRefs: data.evidenceRefs, findings: data.findings ?? null, at: ts };
        if (data.verdict === "pass") {
          task.verified = true;
          task.status = "verified";
        } else block(task, "review-rejected", data.findings ?? "verification rejected", att.evidenceSource);
        break;
      case "dashboard_synced":
        task.dashboardRef = data.ref;
        task.status = "done";
        break;
      case "publisher_unavailable":
        block(task, "publisher-unavailable", data.reason, att?.evidenceSource);
        break;
      case "gate_approved":
        task.approvedBy = data.approvedBy;
        task.dashboardRef = data.ref;
        task.status = "done";
        break;
      case "gate_rejected":
        block(task, "gate-rejected", data.reason);
        break;
      case "task_deferred":
        task.status = "deferred";
        task.deferredBy = data.ownerDecision;
        break;
      case "interruption_reconciled":
        block(task, data.code, data.reason);
        break;
      case "blocker_resolved":
        task.blocker = { ...task.blocker, resolved: true, resolution: data.reason, authorizedBy: data.authorizedBy };
        task.verified = false;
        task.status = "pending";
        break;
      default:
        break;
    }
  }
  return state;
}

/** Derive readiness, blockers and the unmet-dependency DAG view for each task. */
export function deriveStatusView(state) {
  const done = (id) => state.tasks.get(id)?.status === "done";
  const rows = [...state.tasks.values()].map((t) => {
    const waitingOn = t.dependencies.filter((d) => !done(d));
    const upstreamBlocked = waitingOn.filter((d) => state.tasks.get(d).status === "blocked");
    let status = t.status;
    let next;
    if (status === "pending") {
      if (waitingOn.length) {
        status = upstreamBlocked.length ? "blocked-upstream" : "waiting";
        next = upstreamBlocked.length ? `resolve blocker on ${upstreamBlocked.join(", ")}` : `await ${waitingOn.join(", ")}`;
      } else if (t.kind === "gate") {
        status = "gated";
        next = "owner decision required";
      } else {
        status = "ready";
        next = t.attempt ? `retry attempt ${t.attempt + 1}` : "dispatch";
      }
    } else if (status === "running") {
      const a = openAttempt(t);
      next = a.receipt ? "await trusted completion; do not treat queued delivery as completion" : "reconcile admission via subagents before any re-dispatch";
    } else if (status === "review-ready") next = "verify independently against acceptance criteria";
    else if (status === "verified") next = "publish dashboard checkpoint, then mark done";
    else if (status === "blocked") next = t.blocker.resolved ? "retry" : `resolve ${t.blocker.code}`;
    return {
      id: t.id,
      kind: t.kind,
      role: t.role,
      status,
      attempt: t.attempt,
      dependencies: [...t.dependencies],
      waitingOn,
      blocker: t.blocker && !t.blocker.resolved ? { code: t.blocker.code, reason: t.blocker.reason, evidenceSource: t.blocker.evidenceSource } : null,
      requestedModel: t.requestedModel,
      actualModel: openAttempt(t)?.receipt?.resolvedModel ?? null,
      evidenceSource: openAttempt(t)?.evidenceSource ?? null,
      dashboardRef: t.dashboardRef,
      nextAction: next ?? (status === "done" ? "none" : "owner review"),
    };
  });
  return { planId: state.planId, tasks: rows, edges: rows.flatMap((r) => r.dependencies.map((d) => [d, r.id])) };
}

export function renderStatusMarkdown(view) {
  const lines = ["| Task | Status | Waiting on | Blocker | Model (req → actual) | Source | Next |", "|---|---|---|---|---|---|---|"];
  for (const r of view.tasks) {
    lines.push(
      `| ${r.id} | ${r.status} | ${r.waitingOn.join(", ") || "-"} | ${r.blocker ? `${r.blocker.code}` : "-"} | ${r.requestedModel ?? "-"} → ${r.actualModel ?? "-"} | ${r.evidenceSource ?? "-"} | ${r.nextAction} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Evaluate acceptance evidence. Only `standard-spawn` receipts count; adapter
 * fake-host evidence is listed separately and never satisfies either criterion.
 */
export function assessAcceptance(state, { gateTaskId } = {}) {
  const tasks = [...state.tasks.values()];
  const std = (t) => t.attempts.some((a) => a.evidenceSource === "standard-spawn");
  const fake = tasks.filter((t) => t.attempts.some((a) => a.evidenceSource === "adapter-fake-host")).map((t) => t.id);
  const doneStd = tasks.filter((t) => t.kind === "worker" && t.status === "done" && openAttempt(t)?.evidenceSource === "standard-spawn");
  const dependent = doneStd.filter((t) => t.dependencies.length);
  const review = doneStd.some((t) => t.role === "review");
  const gate = gateTaskId ? state.tasks.get(gateTaskId) : undefined;
  const accept01 = {
    met: dependent.length >= 2 && doneStd.length >= 3 && review && gate?.status !== "done" && Boolean(gate) && fake.length === 0,
    standardDoneTasks: doneStd.map((t) => t.id),
    haltedAtGate: Boolean(gate) && gate.status !== "done",
    reason: fake.length ? "adapter-fake-host evidence present; excluded" : undefined,
  };
  const seen = new Set();
  for (const t of tasks)
    for (const a of t.attempts) {
      if (a.evidenceSource !== "standard-spawn") continue;
      if (a.outcome === "error") seen.add("worker-error");
      if (a.outcome === "timeout") seen.add("timeout");
      if (a.outcome === "aborted") seen.add("interrupted");
      if (a.verification?.verdict === "reject") seen.add("review-rejected");
    }
  for (const t of tasks) if (t.blocker && std(t) && ["model-unavailable", "model-mismatch", "admission-unknown"].includes(t.blocker.code)) seen.add(t.blocker.code === "admission-unknown" ? "interrupted" : "model-unavailable");
  const scenarios = ["worker-error", "timeout", "model-unavailable", "review-rejected", "interrupted"];
  return {
    accept01,
    accept02: Object.fromEntries(scenarios.map((s) => [s, seen.has(s) ? "covered-by-standard-spawn" : "uncovered"])),
    fakeHostTaskIds: fake,
  };
}

/** Append-only, hash-chained, lock-guarded JSONL ledger for standard-spawn orchestration. */
export function createTaskLedger({ file, now = () => new Date().toISOString(), requireCapability = true } = {}) {
  if (!nonEmpty(file) || !path.isAbsolute(file)) throw new TypeError("file must be an absolute path");
  const lockFile = `${file}.lock`;

  function load() {
    if (!existsSync(file)) return { events: [], head: GENESIS, tornTail: false, validBytes: 0 };
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const events = [];
    let head = GENESIS;
    let tornTail = false;
    let validBytes = 0;
    lines.forEach((line, i) => {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        if (i === lines.length - 1) {
          tornTail = true;
          return;
        }
        return fail(`ledger line ${i + 1} is unreadable`, "ledger-corrupt");
      }
      const { hash, ...body } = rec;
      if (body.prev !== head || hash !== sha(JSON.stringify(body)) || body.seq !== i + 1)
        fail(`ledger chain broken at line ${i + 1}`, "ledger-corrupt");
      head = hash;
      validBytes += Buffer.byteLength(line) + 1;
      events.push(body);
    });
    return { events, head, tornTail, validBytes };
  }

  /** `build(state)` validates against replayed state and returns the event data, or throws. */
  function commit(type, build) {
    let lock;
    try {
      lock = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (e) {
      if (e.code === "EEXIST") fail("ledger is locked by another writer; inspect before removing the lock", "ledger-busy");
      throw e;
    }
    try {
      const { events, head, tornTail, validBytes } = load();
      const data = build(reduceLedger(events));
      const body = { seq: events.length + 1, ts: now(), type, data, prev: head };
      // The torn tail never became durable; drop it so the chain stays contiguous.
      if (tornTail) truncateSync(file, validBytes);
      const fd = openSync(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ ...body, hash: sha(JSON.stringify(body)) })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return reduceLedger([...events, body]);
    } finally {
      closeSync(lock);
      unlinkSync(lockFile);
    }
  }

  const need = (s, id) => s.tasks.get(id) ?? fail(`unknown task ${id}`, "unknown-task");
  const state = () => reduceLedger(load().events);
  const needAttempt = (t, wantStatus) => {
    if (t.status !== wantStatus) fail(`${t.id} is ${t.status}, expected ${wantStatus}`, "invalid-transition");
    return openAttempt(t);
  };

  return {
    state,
    view: () => deriveStatusView(state()),
    events: () => load().events,
    integrity: () => {
      const { events, tornTail } = load();
      return { events: events.length, tornTail };
    },

    declarePlan({ planId, tasks }) {
      if (!nonEmpty(planId)) fail("planId required", "invalid-plan");
      if (!Array.isArray(tasks) || !tasks.length) fail("plan needs tasks", "invalid-plan");
      const defs = tasks.map(normalizeTask);
      validateDag(defs);
      return commit("plan_declared", (s) => {
        if (s.planId) fail("plan already declared; use addTask to extend", "plan-exists");
        return { planId, tasks: defs };
      });
    },

    addTask(task) {
      const def = normalizeTask(task);
      return commit("task_added", (s) => {
        if (s.tasks.has(def.id)) fail(`duplicate task id: ${def.id}`, "invalid-plan");
        validateDag([...[...s.tasks.values()].map((t) => ({ id: t.id, dependencies: t.dependencies })), def]);
        return { task: def };
      });
    },

    recordCapability(input) {
      return commit("capability_recorded", () => ({ capability: assessContinuationCapability(input) }));
    },

    /** Durably reserve an attempt BEFORE calling sessions_spawn; returns the attempt number. */
    reserveDispatch(taskId) {
      let attempt;
      commit("dispatch_reserved", (s) => {
        const t = need(s, taskId);
        if (t.kind !== "worker") fail(`${taskId} is an owner gate, not dispatchable`, "not-dispatchable");
        if (requireCapability && !s.capability?.canDispatch)
          fail("continuation capability not evidenced; record tools actually available to the parent", "capability-missing");
        if (t.status !== "pending") fail(`${taskId} is ${t.status}; duplicate dispatch refused`, "duplicate-dispatch");
        const unmet = t.dependencies.filter((d) => s.tasks.get(d).status !== "done");
        if (unmet.length) fail(`${taskId} waits on ${unmet.join(", ")}`, "dependency-unmet");
        if (t.attempt >= t.maxAttempts) fail(`${taskId} exhausted its ${t.maxAttempts} attempts`, "attempts-exhausted");
        if (t.attempt > 0 && !t.blocker?.resolved) fail(`${taskId} retry needs an explicit resolved blocker`, "blocker-unresolved");
        attempt = t.attempt + 1;
        return { taskId, attempt };
      });
      return attempt;
    },

    /** Record the sessions_spawn receipt; a missing or mismatching field blocks the attempt. */
    recordReceipt(taskId, input) {
      return commit("spawn_receipt", (s) => {
        const t = need(s, taskId);
        const a = needAttempt(t, "running");
        if (a.receipt) fail(`${taskId} attempt ${a.n} already has a receipt`, "duplicate-receipt");
        const evidenceSource = input.evidenceSource ?? "standard-spawn";
        if (!EVIDENCE_SOURCES.includes(evidenceSource)) fail("unknown evidenceSource", "invalid-receipt");
        const receipt = {
          evidenceSource,
          runId: input.runId ?? null,
          childSessionKey: input.childSessionKey ?? null,
          resolvedModel: input.resolvedModel ?? null,
          resolvedProvider: input.resolvedProvider ?? null,
          requestedModel: t.requestedModel,
          appliedTimeout: input.appliedTimeout ?? "unconfirmed",
          requestedTimeoutMs: t.timeoutMs,
        };
        let problem;
        const missing = ["runId", "childSessionKey", "resolvedModel", "resolvedProvider"].filter((k) => !nonEmpty(receipt[k]));
        if (input.unavailable) problem = { code: "model-unavailable", reason: String(input.unavailable) };
        else if (missing.length) problem = { code: "receipt-incomplete", reason: `missing ${missing.join(", ")}` };
        else if (`${receipt.resolvedProvider}/${receipt.resolvedModel}` !== t.requestedModel && receipt.resolvedModel !== t.requestedModel)
          problem = { code: "model-mismatch", reason: `requested ${t.requestedModel}, receipt ${receipt.resolvedProvider}/${receipt.resolvedModel}` };
        return { taskId, receipt, problem };
      });
    },

    /** A queued/accepted delivery is visible but never advances the task. */
    recordQueued(taskId) {
      return commit("queued_observed", (s) => {
        needAttempt(need(s, taskId), "running");
        return { taskId };
      });
    },

    /** Record a trusted completion envelope; identity is matched on childSessionKey, not worker text. */
    recordCompletion({ childSessionKey, outcome, digest, reason }) {
      const find = (s) => [...s.tasks.values()].find((x) => x.attempts.some((a) => a.receipt?.childSessionKey === childSessionKey));
      const pre = find(state());
      if (!pre) {
        commit("completion_unmatched", () => ({ childSessionKey, reason: "no recorded receipt matches" }));
        fail("completion matches no recorded receipt; ignored", "unmatched-completion");
      }
      if (pre.attempts.some((a) => a.receipt?.childSessionKey === childSessionKey && a.completion)) {
        commit("completion_duplicate", () => ({ taskId: pre.id, childSessionKey }));
        fail(`duplicate completion for ${pre.id}`, "duplicate-completion");
      }
      return commit("completion_observed", (s) => {
        const t = find(s);
        if (!["ok", "error", "timeout", "aborted"].includes(outcome)) fail("unknown outcome", "invalid-completion");
        if (t.status !== "running" || openAttempt(t).receipt?.childSessionKey !== childSessionKey)
          fail(`${t.id} is ${t.status}; stale completion not accepted`, "invalid-transition");
        return { taskId: t.id, outcome, digest, reason };
      });
    },

    recordVerification(taskId, { verdict, evidenceRefs, findings }) {
      return commit("verification_recorded", (s) => {
        needAttempt(need(s, taskId), "review-ready");
        if (!["pass", "reject"].includes(verdict)) fail("verdict must be pass or reject", "invalid-verification");
        if (verdict === "pass" && !(Array.isArray(evidenceRefs) && evidenceRefs.length))
          fail("a pass requires fresh evidence references", "invalid-verification");
        if (verdict === "reject" && !nonEmpty(findings)) fail("a rejection records findings", "invalid-verification");
        return { taskId, verdict, evidenceRefs: evidenceRefs ?? [], findings };
      });
    },

    /** Done requires a verified result AND a confirmed dashboard checkpoint; no other path exists. */
    recordDashboardSync(taskId, ref) {
      return commit("dashboard_synced", (s) => {
        needAttempt(need(s, taskId), "verified");
        if (!nonEmpty(ref)) fail("dashboard sync needs a confirmation reference", "invalid-checkpoint");
        if (requireCapability && !s.capability?.canPublish)
          fail("no publisher capability evidenced; task cannot be completed", "publisher-unavailable");
        return { taskId, ref };
      });
    },

    /** Record that the publisher failed; the task stays incomplete and visibly blocked. */
    recordPublisherFailure(taskId, reason) {
      return commit("publisher_unavailable", (s) => {
        needAttempt(need(s, taskId), "verified");
        return { taskId, reason: reason ?? "publisher unavailable" };
      });
    },

    approveGate(taskId, { approvedBy, ref }) {
      return commit("gate_approved", (s) => {
        const t = need(s, taskId);
        if (t.kind !== "gate" || t.status !== "pending") fail(`${taskId} is not an open owner gate`, "invalid-transition");
        const unmet = t.dependencies.filter((d) => s.tasks.get(d).status !== "done");
        if (unmet.length) fail(`gate ${taskId} waits on ${unmet.join(", ")}`, "dependency-unmet");
        if (!nonEmpty(approvedBy) || !nonEmpty(ref)) fail("gate approval needs approver and reference", "invalid-gate");
        return { taskId, approvedBy, ref };
      });
    },

    rejectGate(taskId, reason) {
      return commit("gate_rejected", (s) => {
        const t = need(s, taskId);
        if (t.kind !== "gate" || t.status !== "pending") fail(`${taskId} is not an open owner gate`, "invalid-transition");
        return { taskId, reason: reason ?? "gate rejected" };
      });
    },

    deferTask(taskId, ownerDecision) {
      return commit("task_deferred", (s) => {
        need(s, taskId);
        if (!nonEmpty(ownerDecision)) fail("deferral requires an owner decision reference", "invalid-deferral");
        return { taskId, ownerDecision };
      });
    },

    /** Reopen a blocked task for a retry only after the side effects were inspected. */
    resolveBlocker(taskId, { reason, authorizedBy, sideEffectsChecked }) {
      return commit("blocker_resolved", (s) => {
        const t = need(s, taskId);
        if (t.status !== "blocked" || t.blocker.resolved) fail(`${taskId} has no open blocker`, "invalid-transition");
        if (!nonEmpty(reason) || !nonEmpty(authorizedBy)) fail("resolution needs reason and authorizedBy", "invalid-resolution");
        if (sideEffectsChecked !== true && t.kind === "worker" && openAttempt(t))
          fail("confirm side effects of the prior attempt were inspected", "invalid-resolution");
        if (t.blocker.code === "publisher-unavailable") fail("publisher-unavailable is cleared by recordDashboardSync, not resolveBlocker", "invalid-resolution");
        return { taskId, reason, authorizedBy };
      });
    },

    /**
     * Reconcile after a restart/compaction/session change. Reserved attempts with no
     * receipt are unknown (the spawn may have happened); running attempts keep waiting
     * for a trusted completion. Neither is ever re-dispatched automatically.
     */
    recover() {
      const s0 = state();
      const flagged = [];
      let s = s0;
      for (const t of s0.tasks.values()) {
        const a = openAttempt(t);
        if (t.status === "running" && a && !a.receipt) {
          s = commit("interruption_reconciled", () => ({
            taskId: t.id,
            code: "admission-unknown",
            reason: `attempt ${a.n} reserved without a spawn receipt; inspect subagents for a matching run before any retry`,
          }));
          flagged.push({ taskId: t.id, action: "inspect-admission" });
        } else if (t.status === "running") flagged.push({ taskId: t.id, action: "await-completion", childSessionKey: a.receipt.childSessionKey });
        else if (t.status === "review-ready") flagged.push({ taskId: t.id, action: "verify" });
        else if (t.status === "verified") flagged.push({ taskId: t.id, action: "publish-checkpoint" });
      }
      return { state: s, flagged };
    },
  };
}
