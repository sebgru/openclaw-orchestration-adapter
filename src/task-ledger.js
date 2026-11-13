import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const LEDGER_VERSION = 1;
export const EVIDENCE_SOURCES = Object.freeze(["standard-spawn", "adapter-fake-host"]);
export const BLOCKER_CODES = Object.freeze([
  "worker-error",
  "timeout",
  "model-unavailable",
  "model-mismatch",
  "receipt-incomplete",
  "timeout-mismatch",
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
    requestedModel:
      kind === "worker"
        ? nonEmpty(t.requestedModel)
          ? t.requestedModel
          : fail(`task ${t.id} needs requestedModel`, "invalid-plan")
        : null,
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
const liveChild = (att) =>
  Boolean(att?.receipt?.childSessionKey) && !att.completion && !att.abandoned;

/** Fold ledger events into current task state. Pure: replay is the only source of truth. */
export function reduceLedger(events) {
  const state = { planId: null, capability: null, tasks: new Map(), notes: [], nudges: [] };
  const block = (task, code, reason, evidenceSource) => {
    task.status = "blocked";
    const att = openAttempt(task);
    task.blocker = {
      code,
      reason,
      resolved: false,
      evidenceSource: evidenceSource ?? att?.evidenceSource ?? null,
    };
    if (att) att.blockerCodes.push(code);
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
        task.attempts.push({
          n: data.attempt,
          reservedAt: ts,
          receipt: null,
          queued: false,
          completion: null,
          verification: null,
          evidenceSource: null,
          outcome: "reserved",
          blockerCodes: [],
          trigger: data.trigger ?? null,
          abandoned: null,
        });
        if (data.trigger?.type === "owner-nudge")
          state.nudges.push({ taskId: data.taskId, ref: data.trigger.ref, ts });
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
        att.completion = {
          outcome: data.outcome,
          digest: data.digest ?? null,
          duplicate: false,
          at: ts,
        };
        att.outcome = data.outcome;
        if (task.status === "running") {
          if (data.outcome === "ok") task.status = "review-ready";
          else block(task, OUTCOME_BLOCKER[data.outcome], data.reason ?? data.outcome);
        } else if (data.outcome !== "ok") att.blockerCodes.push(OUTCOME_BLOCKER[data.outcome]);
        break;
      case "owner_nudge_recorded":
        state.nudges.push({ taskId: null, ref: data.ref, ts });
        break;
      case "completion_duplicate":
      case "completion_unmatched":
        state.notes.push({ type, ts, ...data });
        break;
      case "verification_recorded":
        att.verification = {
          verdict: data.verdict,
          verifier: data.verifier,
          evidenceRefs: data.evidenceRefs,
          findings: data.findings ?? null,
          at: ts,
        };
        if (data.verdict === "pass") {
          task.verified = true;
          task.status = "verified";
        } else
          block(
            task,
            "review-rejected",
            data.findings ?? "verification rejected",
            att.evidenceSource,
          );
        break;
      case "dashboard_synced":
        task.dashboardRef = data.ref;
        task.status = "done";
        if (task.blocker && !task.blocker.resolved)
          task.blocker = { ...task.blocker, resolved: true, resolution: "published" };
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
        task.deferredBy = { ownerDecision: data.ownerDecision, approvedBy: data.approvedBy };
        break;
      case "interruption_reconciled":
        block(task, data.code, data.reason);
        break;
      case "blocker_resolved":
        task.blocker = {
          ...task.blocker,
          resolved: true,
          resolution: data.reason,
          authorizedBy: data.authorizedBy,
        };
        if (att && data.childStatus && liveChild(att))
          att.abandoned = { status: data.childStatus, evidence: data.childEvidence };
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
        next = upstreamBlocked.length
          ? `resolve blocker on ${upstreamBlocked.join(", ")}`
          : `await ${waitingOn.join(", ")}`;
      } else if (t.kind === "gate") {
        status = "gated";
        next = "owner decision required";
      } else {
        status = "ready";
        next = t.attempt ? `retry attempt ${t.attempt + 1}` : "dispatch";
      }
    } else if (status === "running") {
      const a = openAttempt(t);
      next = a.receipt
        ? "await trusted completion; do not treat queued delivery as completion"
        : "reconcile admission via subagents before any re-dispatch";
    } else if (status === "review-ready") next = "verify independently against acceptance criteria";
    else if (status === "verified") next = "publish dashboard checkpoint, then mark done";
    else if (status === "blocked")
      next = t.blocker.resolved
        ? "retry"
        : t.blocker.code === "publisher-unavailable"
          ? "result is verified; retry the dashboard checkpoint (recordDashboardSync) once the publisher works; do not re-run the worker"
          : `resolve ${t.blocker.code}`;
    return {
      id: t.id,
      kind: t.kind,
      role: t.role,
      status,
      verified: t.verified,
      attempt: t.attempt,
      dependencies: [...t.dependencies],
      waitingOn,
      blocker:
        t.blocker && !t.blocker.resolved
          ? {
              code: t.blocker.code,
              reason: t.blocker.reason,
              evidenceSource: t.blocker.evidenceSource,
            }
          : null,
      requestedModel: t.requestedModel,
      actualModel: openAttempt(t)?.receipt?.resolvedModel ?? null,
      evidenceSource: openAttempt(t)?.evidenceSource ?? null,
      dashboardRef: t.dashboardRef,
      nextAction: next ?? (status === "done" ? "none" : "owner review"),
    };
  });
  return {
    planId: state.planId,
    tasks: rows,
    edges: rows.flatMap((r) => r.dependencies.map((d) => [d, r.id])),
  };
}

export function renderStatusMarkdown(view) {
  const lines = [
    "| Task | Status | Waiting on | Blocker | Model (req → actual) | Source | Next |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of view.tasks) {
    lines.push(
      `| ${r.id} | ${r.status} | ${r.waitingOn.join(", ") || "-"} | ${r.blocker ? `${r.blocker.code}` : "-"} | ${r.requestedModel ?? "-"} → ${r.actualModel ?? "-"} | ${r.evidenceSource ?? "-"} | ${r.nextAction} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Check whether the ledger's own entries satisfy the ACCEPT-01 criteria. This is
 * not live acceptance: `evidenceSource` and receipts are coordinator-asserted, so
 * synthetic or hand-written entries can satisfy it. `hostCorroborated` is true only
 * when every standard-spawn done task has a matching host-observed spawn and a
 * successful, uncontradicted end record with the same run id in a non-truncated
 * observation log (pass `observations` from the lifecycle observer); even
 * then the owner must review the run log. Only `standard-spawn` receipts
 * count; adapter fake-host evidence is listed separately. The ledger cannot see
 * owner chat, so "zero nudge" means: every dependent dispatch was triggered by a
 * recorded trusted completion and no owner-nudge was recorded. The coordinator
 * must record every nudge it receives for that claim to be meaningful.
 */
export function assessAcceptance(state, { gateTaskId, observations = [] } = {}) {
  const tasks = [...state.tasks.values()];
  const fake = tasks
    .filter((t) => t.attempts.some((a) => a.evidenceSource === "adapter-fake-host"))
    .map((t) => t.id);
  const doneStd = tasks.filter(
    (t) =>
      t.kind === "worker" &&
      t.status === "done" &&
      openAttempt(t)?.evidenceSource === "standard-spawn",
  );
  const keyOwner = new Map();
  for (const t of tasks)
    for (const a of t.attempts)
      if (a.receipt?.childSessionKey && a.completion?.outcome === "ok")
        keyOwner.set(a.receipt.childSessionKey, t.id);
  const chained = doneStd.filter((t) => {
    const trig = openAttempt(t).trigger;
    return (
      t.dependencies.length > 0 &&
      trig?.type === "completion" &&
      t.dependencies.includes(keyOwner.get(trig.childSessionKey))
    );
  });
  const dependent = doneStd.filter((t) => t.dependencies.length);
  const review = doneStd.some((t) => t.role === "review");
  const independentlyVerified = doneStd.every((t) =>
    nonEmpty(openAttempt(t).verification?.verifier),
  );
  const gate = gateTaskId ? state.tasks.get(gateTaskId) : undefined;
  const haltedAtGate =
    Boolean(gate) &&
    gate.kind === "gate" &&
    gate.status === "pending" &&
    gate.dependencies.every((d) => state.tasks.get(d)?.status === "done");
  const zeroNudge =
    state.nudges.length === 0 && dependent.length > 0 && chained.length === dependent.length;
  const seen = new Map();
  for (const o of observations) {
    if (!o?.childSessionKey) continue;
    const e = seen.get(o.childSessionKey) ?? {};
    if (o.kind === "spawned") e.spawned ??= o;
    else if (o.kind === "ended") (e.ended ??= []).push(o);
    seen.set(o.childSessionKey, e);
  }
  const uncorroborated = doneStd
    .filter((t) => {
      const r = openAttempt(t).receipt;
      const e = seen.get(r.childSessionKey);
      return !(
        e?.spawned &&
        e.spawned.runId === r.runId &&
        !observations.some((o) => o?.kind === "truncated") &&
        e.ended?.some((end) => end.runId === r.runId && end.outcome === "ok") &&
        !e.ended.some((end) => end.runId === r.runId && end.outcome !== "ok")
      );
    })
    .map((t) => t.id);
  const accept01 = {
    ledgerCriteriaMet:
      doneStd.length >= 3 &&
      chained.length >= 2 &&
      review &&
      independentlyVerified &&
      haltedAtGate &&
      zeroNudge &&
      fake.length === 0,
    standardDoneTasks: doneStd.map((t) => t.id),
    chainedTaskIds: chained.map((t) => t.id),
    ownerNudges: state.nudges.length,
    zeroNudge,
    independentlyVerified,
    haltedAtGate,
    reason: fake.length ? "adapter-fake-host evidence present; excluded" : undefined,
    hostCorroborated: doneStd.length > 0 && uncorroborated.length === 0,
    uncorroboratedTaskIds: uncorroborated,
    notice:
      "Computed from coordinator-written ledger entries; this is not proof of a live standard-spawn run. Owner review of the run log is still required.",
  };
  const scenarios = {
    "worker-error": ["worker-error"],
    timeout: ["timeout"],
    "model-unavailable": ["model-unavailable"],
    "review-rejected": ["review-rejected"],
    interrupted: ["interrupted"],
  };
  const stdCodes = new Set(
    tasks.flatMap((t) =>
      t.attempts
        .filter((a) => a.evidenceSource === "standard-spawn")
        .flatMap((a) => a.blockerCodes),
    ),
  );
  return {
    accept01,
    accept02: Object.fromEntries(
      Object.entries(scenarios).map(([name, codes]) => [
        name,
        codes.some((c) => stdCodes.has(c)) ? "covered-by-standard-spawn" : "uncovered",
      ]),
    ),
    fakeHostTaskIds: fake,
  };
}

/** Append-only, hash-chained, lock-guarded JSONL ledger for standard-spawn orchestration. */
export function createTaskLedger({
  file,
  now = () => new Date().toISOString(),
  requireCapability = true,
  owners = [],
  providerAliases = {},
} = {}) {
  if (!nonEmpty(file) || !path.isAbsolute(file))
    throw new TypeError("file must be an absolute path");
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

  /**
   * The lock is created atomically (O_EXCL) and carries a unique token. It is never
   * removed on a guess: two processes judging the same lock "stale" could each delete
   * the other's fresh lock. A crashed writer's lock is cleared only by the explicit,
   * operator-invoked `breakStaleLock`.
   */
  function acquireLock() {
    let fd;
    try {
      fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      fail(
        "ledger is locked; inspect the lock and establish that all writers are quiescent before manual removal",
        "ledger-busy",
      );
    }
    const token = randomUUID();
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token }));
    } catch (e) {
      releaseLock({ fd, token: null, force: true });
      throw e;
    }
    return { fd, token };
  }

  /** Release only the lock this writer created; a replaced foreign lock is left alone. */
  function releaseLock({ fd, token, force = false }) {
    try {
      closeSync(fd);
    } finally {
      let own = force;
      if (!own)
        try {
          own = JSON.parse(readFileSync(lockFile, "utf8"))?.token === token;
        } catch {
          own = false;
        }
      if (own)
        try {
          unlinkSync(lockFile);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
    }
  }

  function inspectLock() {
    let raw;
    try {
      raw = readFileSync(lockFile, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return { locked: false };
      throw e;
    }
    let info = null;
    try {
      info = JSON.parse(raw);
    } catch {
      // unreadable lock content stays "unknown"
    }
    let writerAlive = "unknown";
    if (info?.host === hostname() && Number.isInteger(info.pid)) {
      try {
        process.kill(info.pid, 0);
        writerAlive = true;
      } catch (e) {
        writerAlive = e.code === "ESRCH" ? false : "unknown";
      }
    }
    return {
      locked: true,
      pid: info?.pid ?? null,
      host: info?.host ?? null,
      token: info?.token ?? null,
      writerAlive,
    };
  }

  function commit(type, build) {
    const lock = acquireLock();
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
      releaseLock(lock);
    }
  }

  /**
   * Compare the receipt with the requested model without substituting. Exact
   * `provider/model` is the norm; a runtime-specific provider name is accepted
   * only if the caller configured it in `providerAliases` for that requested provider.
   */
  function matchModel(requested, r) {
    if (`${r.resolvedProvider}/${r.resolvedModel}` === requested) return "exact";
    const i = requested.indexOf("/");
    if (i < 0) return r.resolvedModel === requested ? "exact" : null;
    const [reqProvider, reqModel] = [requested.slice(0, i), requested.slice(i + 1)];
    const aliases = providerAliases?.[reqProvider];
    if (
      r.resolvedModel === reqModel &&
      Array.isArray(aliases) &&
      aliases.includes(r.resolvedProvider)
    )
      return "provider-alias";
    return null;
  }

  const requireOwner = (who) => {
    if (!owners.length)
      fail(
        "no owner identities configured; owner decisions cannot be recorded",
        "owners-not-configured",
      );
    if (!nonEmpty(who) || !owners.includes(who))
      fail(`${who} is not a configured owner`, "not-owner");
  };
  const need = (s, id) => s.tasks.get(id) ?? fail(`unknown task ${id}`, "unknown-task");
  const state = () => reduceLedger(load().events);
  const publishRetryable = (t) =>
    t.status === "blocked" &&
    t.verified &&
    t.blocker?.code === "publisher-unavailable" &&
    !t.blocker.resolved;
  const needAttempt = (t, wantStatus) => {
    if (t.status !== wantStatus)
      fail(`${t.id} is ${t.status}, expected ${wantStatus}`, "invalid-transition");
    return openAttempt(t);
  };

  return {
    state,
    view: () => deriveStatusView(state()),
    events: () => load().events,
    inspectLock,
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
        validateDag([
          ...[...s.tasks.values()].map((t) => ({ id: t.id, dependencies: t.dependencies })),
          def,
        ]);
        return { task: def };
      });
    },

    recordCapability(input) {
      return commit("capability_recorded", () => ({
        capability: assessContinuationCapability(input),
      }));
    },

    /** Durably reserve an attempt BEFORE calling sessions_spawn; returns the attempt number. */
    reserveDispatch(taskId, { trigger } = {}) {
      let attempt;
      commit("dispatch_reserved", (s) => {
        const t = need(s, taskId);
        if (t.kind !== "worker")
          fail(`${taskId} is an owner gate, not dispatchable`, "not-dispatchable");
        if (requireCapability && !s.capability?.canDispatch)
          fail(
            "continuation capability not evidenced; record tools actually available to the parent",
            "capability-missing",
          );
        if (t.status !== "pending")
          fail(`${taskId} is ${t.status}; duplicate dispatch refused`, "duplicate-dispatch");
        const unmet = t.dependencies.filter((d) => s.tasks.get(d).status !== "done");
        if (unmet.length) fail(`${taskId} waits on ${unmet.join(", ")}`, "dependency-unmet");
        if (t.attempt >= t.maxAttempts)
          fail(`${taskId} exhausted its ${t.maxAttempts} attempts`, "attempts-exhausted");
        if (t.attempt > 0 && !t.blocker?.resolved)
          fail(`${taskId} retry needs an explicit resolved blocker`, "blocker-unresolved");
        if (t.attempt > 0 && liveChild(openAttempt(t)))
          fail(
            `${taskId} prior attempt has a live child; retry would duplicate execution`,
            "live-child",
          );
        let recorded = null;
        if (trigger !== undefined) {
          if (trigger?.type === "initial" && !t.dependencies.length) recorded = { type: "initial" };
          else if (trigger?.type === "retry" && t.attempt > 0) recorded = { type: "retry" };
          else if (trigger?.type === "owner-nudge" && nonEmpty(trigger.ref))
            recorded = { type: "owner-nudge", ref: trigger.ref };
          else if (trigger?.type === "completion") {
            const src = [...s.tasks.values()].find(
              (x) =>
                t.dependencies.includes(x.id) &&
                x.attempts.some(
                  (a) => a.receipt?.childSessionKey === trigger.childSessionKey && a.completion,
                ),
            );
            if (!src)
              fail(
                "completion trigger must reference a recorded completion of a dependency",
                "invalid-trigger",
              );
            recorded = {
              type: "completion",
              childSessionKey: trigger.childSessionKey,
              fromTask: src.id,
            };
          } else fail("invalid dispatch trigger", "invalid-trigger");
        }
        attempt = t.attempt + 1;
        return { taskId, attempt, trigger: recorded };
      });
      return attempt;
    },

    /** Record the sessions_spawn receipt; a missing or mismatching field blocks the attempt. */
    recordReceipt(taskId, input) {
      return commit("spawn_receipt", (s) => {
        const t = need(s, taskId);
        const a = needAttempt(t, "running");
        if (a.receipt) fail(`${taskId} attempt ${a.n} already has a receipt`, "duplicate-receipt");
        const evidenceSource = input.evidenceSource;
        if (!EVIDENCE_SOURCES.includes(evidenceSource))
          fail("receipt needs an explicit evidenceSource", "invalid-receipt");
        const receipt = {
          evidenceSource,
          runId: input.runId ?? null,
          childSessionKey: input.childSessionKey ?? null,
          resolvedModel: input.resolvedModel ?? null,
          resolvedProvider: input.resolvedProvider ?? null,
          requestedModel: t.requestedModel,
          appliedTimeout: input.appliedTimeout ?? "unconfirmed",
          requestedTimeoutMs: t.timeoutMs,
          modelMatch: null,
        };
        let problem;
        const missing = ["runId", "childSessionKey", "resolvedModel", "resolvedProvider"].filter(
          (k) => !nonEmpty(receipt[k]),
        );
        if (input.unavailable)
          problem = { code: "model-unavailable", reason: String(input.unavailable) };
        else if (missing.length)
          problem = { code: "receipt-incomplete", reason: `missing ${missing.join(", ")}` };
        else if (!(receipt.modelMatch = matchModel(t.requestedModel, receipt)))
          problem = {
            code: "model-mismatch",
            reason: `requested ${t.requestedModel}, receipt ${receipt.resolvedProvider}/${receipt.resolvedModel}`,
          };
        if (
          !problem &&
          receipt.appliedTimeout !== "unconfirmed" &&
          receipt.appliedTimeout !== t.timeoutMs
        )
          problem = {
            code: "timeout-mismatch",
            reason: `requested ${t.timeoutMs}ms, receipt applied ${String(receipt.appliedTimeout)}`,
          };
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
      const locate = (s) => {
        for (const t of s.tasks.values()) {
          const a = t.attempts.find((x) => x.receipt?.childSessionKey === childSessionKey);
          if (a) return { t, a };
        }
        return undefined;
      };
      const pre = locate(state());
      if (!pre) {
        commit("completion_unmatched", () => ({
          childSessionKey,
          reason: "no recorded receipt matches",
        }));
        fail("completion matches no recorded receipt; ignored", "unmatched-completion");
      }
      if (pre.a.completion) {
        commit("completion_duplicate", () => ({ taskId: pre.t.id, childSessionKey }));
        fail(`duplicate completion for ${pre.t.id}`, "duplicate-completion");
      }
      if (pre.a.abandoned) {
        commit("completion_unmatched", () => ({
          childSessionKey,
          taskId: pre.t.id,
          reason: "attempt was abandoned by an owner-authorized resolution",
        }));
        fail(`attempt for ${pre.t.id} was abandoned; completion ignored`, "unmatched-completion");
      }
      return commit("completion_observed", (s) => {
        const { t, a } = locate(s);
        if (!["ok", "error", "timeout", "aborted"].includes(outcome))
          fail("unknown outcome", "invalid-completion");
        // A blocked attempt (e.g. receipt mismatch) can still have a live child; its completion is recorded but never unblocks.
        if (!["running", "blocked"].includes(t.status) || openAttempt(t) !== a)
          fail(`${t.id} is ${t.status}; stale completion not accepted`, "invalid-transition");
        return { taskId: t.id, outcome, digest, reason };
      });
    },

    recordVerification(taskId, { verdict, evidenceRefs, findings, verifier }) {
      return commit("verification_recorded", (s) => {
        const a = needAttempt(need(s, taskId), "review-ready");
        if (!nonEmpty(verifier))
          fail("verification needs a verifier identity", "invalid-verification");
        if ([a.receipt?.childSessionKey, a.receipt?.runId].includes(verifier))
          fail("a worker cannot verify its own result", "invalid-verification");
        if (!["pass", "reject"].includes(verdict))
          fail("verdict must be pass or reject", "invalid-verification");
        if (verdict === "pass" && !(Array.isArray(evidenceRefs) && evidenceRefs.length))
          fail("a pass requires fresh evidence references", "invalid-verification");
        if (verdict === "reject" && !nonEmpty(findings))
          fail("a rejection records findings", "invalid-verification");
        return { taskId, verdict, verifier, evidenceRefs: evidenceRefs ?? [], findings };
      });
    },

    /** Done requires a verified result AND a confirmed dashboard checkpoint; no other path exists. */
    recordDashboardSync(taskId, ref) {
      return commit("dashboard_synced", (s) => {
        const t = need(s, taskId);
        if (!publishRetryable(t)) needAttempt(t, "verified");
        if (!nonEmpty(ref))
          fail("dashboard sync needs a confirmation reference", "invalid-checkpoint");
        if (requireCapability && !s.capability?.canPublish)
          fail(
            "no publisher capability evidenced; task cannot be completed",
            "publisher-unavailable",
          );
        return { taskId, ref };
      });
    },

    /** Record that the publisher failed; the task stays incomplete and visibly blocked. */
    recordPublisherFailure(taskId, reason) {
      return commit("publisher_unavailable", (s) => {
        const t = need(s, taskId);
        if (!publishRetryable(t)) needAttempt(t, "verified");
        return { taskId, reason: reason ?? "publisher unavailable" };
      });
    },

    approveGate(taskId, { approvedBy, ref }) {
      requireOwner(approvedBy);
      return commit("gate_approved", (s) => {
        const t = need(s, taskId);
        if (t.kind !== "gate" || t.status !== "pending")
          fail(`${taskId} is not an open owner gate`, "invalid-transition");
        const unmet = t.dependencies.filter((d) => s.tasks.get(d).status !== "done");
        if (unmet.length) fail(`gate ${taskId} waits on ${unmet.join(", ")}`, "dependency-unmet");
        if (!nonEmpty(approvedBy) || !nonEmpty(ref))
          fail("gate approval needs approver and reference", "invalid-gate");
        return { taskId, approvedBy, ref };
      });
    },

    rejectGate(taskId, reason, { rejectedBy } = {}) {
      requireOwner(rejectedBy);
      return commit("gate_rejected", (s) => {
        const t = need(s, taskId);
        if (t.kind !== "gate" || t.status !== "pending")
          fail(`${taskId} is not an open owner gate`, "invalid-transition");
        return { taskId, reason: reason ?? "gate rejected" };
      });
    },

    deferTask(taskId, { ownerDecision, approvedBy } = {}) {
      requireOwner(approvedBy);
      return commit("task_deferred", (s) => {
        const t = need(s, taskId);
        if (!nonEmpty(ownerDecision))
          fail("deferral requires an owner decision reference", "invalid-deferral");
        if (!["pending", "blocked"].includes(t.status))
          fail(
            `${taskId} is ${t.status}; only pending or blocked tasks can be deferred`,
            "invalid-transition",
          );
        if (liveChild(openAttempt(t)))
          fail(`${taskId} has a live child; resolve it before deferral`, "live-child");
        return { taskId, ownerDecision, approvedBy };
      });
    },

    /** Reopen a blocked task for a retry only after the side effects were inspected. */
    resolveBlocker(
      taskId,
      { reason, authorizedBy, sideEffectsChecked, childStatus, childEvidence },
    ) {
      return commit("blocker_resolved", (s) => {
        const t = need(s, taskId);
        if (t.status !== "blocked" || t.blocker.resolved)
          fail(`${taskId} has no open blocker`, "invalid-transition");
        if (!nonEmpty(reason) || !nonEmpty(authorizedBy))
          fail("resolution needs reason and authorizedBy", "invalid-resolution");
        if (sideEffectsChecked !== true && t.kind === "worker" && openAttempt(t))
          fail("confirm side effects of the prior attempt were inspected", "invalid-resolution");
        if (t.blocker.code === "publisher-unavailable")
          fail(
            "publisher-unavailable is cleared by recordDashboardSync, not resolveBlocker",
            "invalid-resolution",
          );
        if (liveChild(openAttempt(t))) {
          if (!["terminal", "cancelled"].includes(childStatus) || !nonEmpty(childEvidence))
            fail(
              "the blocked attempt still has a live child; confirm via subagents that it is terminal or cancelled and cite the evidence",
              "live-child",
            );
          return { taskId, reason, authorizedBy, childStatus, childEvidence };
        }
        return { taskId, reason, authorizedBy };
      });
    },

    /** Record an owner nudge so zero-nudge acceptance cannot pass silently. */
    recordOwnerNudge(ref) {
      if (!nonEmpty(ref)) fail("nudge needs a reference", "invalid-nudge");
      return commit("owner_nudge_recorded", () => ({ ref }));
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
        } else if (t.status === "running")
          flagged.push({
            taskId: t.id,
            action: "await-completion",
            childSessionKey: a.receipt.childSessionKey,
          });
        else if (t.status === "review-ready") flagged.push({ taskId: t.id, action: "verify" });
        else if (publishRetryable(t)) flagged.push({ taskId: t.id, action: "publish-checkpoint" });
        else if (t.status === "verified")
          flagged.push({ taskId: t.id, action: "publish-checkpoint" });
      }
      return { state: s, flagged };
    },
  };
}
