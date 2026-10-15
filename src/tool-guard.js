import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Marker embedded in every session key this plugin creates for a worker run. */
export const WORKER_SESSION_MARKER = ":subagent:oca-";

/** Tools that would let a worker delegate; never grantable (v1: no nested delegation). */
export const DELEGATION_TOOLS = Object.freeze([
  "sessions_spawn",
  "sessions_send",
  "sessions_yield",
  "subagents",
  "spawn_agent",
  "agents_wait",
]);

const DELEGATION_SET = new Set(DELEGATION_TOOLS);

export function newWorkerSessionKey(agentId) {
  if (typeof agentId !== "string" || !/^[A-Za-z0-9_-]+$/.test(agentId)) {
    throw new TypeError("agentId must be a simple identifier");
  }
  return `agent:${agentId}:subagent:oca-${randomUUID()}`;
}

/** Stable, non-sensitive denial categories for guard audit evidence. */
export const DENIAL_REASONS = Object.freeze({
  WRONG_SESSION: "wrong_session",
  UNCONFIRMED: "unconfirmed_binding",
  RUN_MISMATCH: "wrong_run",
  TIME_BUDGET: "time_budget_exhausted",
  DELEGATION: "delegation_forbidden",
  NOT_GRANTED: "out_of_grant",
  CALL_BUDGET: "call_budget_exhausted",
  CALL_ID_REUSE: "call_id_reused",
});

const MAX_DENIALS = 100;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

function blocked(blockReason, reason) {
  const result = { block: true, blockReason: `orchestration-adapter: ${blockReason}` };
  if (reason) Object.defineProperty(result, "reason", { value: reason, enumerable: false });
  return result;
}

/**
 * Binds each worker run to exact granted tools and a budget, and decides
 * before_tool_call outcomes. Fail closed: any call from this plugin's worker
 * session namespace that is not bound to a confirmed run, or is outside the
 * grant/budget/deadline, is blocked. Calls from unrelated sessions are not
 * this guard's concern and pass through untouched.
 */
export class ToolGuard {
  #bindings = new Map();
  #waiters = new Map();
  #now;
  #admissionWaitMs;
  #onDecision;
  #salt = randomBytes(16);
  #denials = [];
  #reportedCallIds = new Set();

  /**
   * admissionWaitMs bounds how long checkWhenAdmitted() holds a tool call while
   * the binding awaits confirm(); it must stay below the host's 15s
   * before_tool_call handler timeout (which also fails closed).
   */
  constructor({ now = Date.now, admissionWaitMs = 5000, onDecision } = {}) {
    this.#now = now;
    this.#admissionWaitMs = admissionWaitMs;
    this.#onDecision = typeof onDecision === "function" ? onDecision : undefined;
  }

  /** Attach the default audit sink once when a shared guard is first registered. */
  setOnDecision(onDecision) {
    if (!this.#onDecision && typeof onDecision === "function") this.#onDecision = onDecision;
  }

  /** Bounded, sanitized denial history; raw identifiers and payloads are never retained. */
  get denials() {
    return this.#denials.map((denial) => ({ ...denial }));
  }

  #hash(value) {
    if (typeof value !== "string" || !value) return null;
    return createHash("sha256").update(this.#salt).update(value).digest("hex").slice(0, 12);
  }

  #record(reason, { sessionKey, runId, toolName, toolCallId }) {
    try {
      const record = {
        reason,
        toolName: typeof toolName === "string" && SAFE_TOOL_NAME.test(toolName) ? toolName : null,
        session: this.#hash(sessionKey),
        run: this.#hash(runId),
      };
      this.#denials.push(record);
      if (this.#denials.length > MAX_DENIALS) this.#denials.shift();
      const callHash = this.#hash(toolCallId);
      const isNewCall = callHash === null || !this.#reportedCallIds.has(callHash);
      if (callHash !== null && isNewCall) {
        this.#reportedCallIds.add(callHash);
        if (this.#reportedCallIds.size > MAX_DENIALS) {
          this.#reportedCallIds.delete(this.#reportedCallIds.values().next().value);
        }
      }
      if (isNewCall) this.#onDecision?.({ ...record });
    } catch {
      // Audit failures must never change the blocking decision.
    }
  }

  /** True when the session key belongs to the worker namespace. */
  isWorkerSession(sessionKey) {
    return typeof sessionKey === "string" && sessionKey.includes(WORKER_SESSION_MARKER);
  }

  get size() {
    return this.#bindings.size;
  }

  /** Register a pending binding before run() is called. runId is unknown until confirm(). */
  bind({ sessionKey, taskId, allowedTools, budget }) {
    if (!this.isWorkerSession(sessionKey))
      throw new TypeError("sessionKey outside worker namespace");
    if (this.#bindings.has(sessionKey)) throw new Error("sessionKey already bound");
    if (typeof taskId !== "string" || !taskId) throw new TypeError("taskId required");
    if (!Array.isArray(allowedTools) || !allowedTools.every((t) => typeof t === "string" && t)) {
      throw new TypeError("allowedTools must be an array of tool names");
    }
    const delegating = allowedTools.filter((t) => DELEGATION_SET.has(t));
    if (delegating.length) throw new Error(`delegation tools cannot be granted: ${delegating}`);
    if (!Number.isInteger(budget?.maxCalls) || budget.maxCalls < 1) {
      throw new RangeError("budget.maxCalls must be a positive integer");
    }
    if (!Number.isInteger(budget?.timeoutMs) || budget.timeoutMs < 1) {
      throw new RangeError("budget.timeoutMs must be a positive integer");
    }
    this.#bindings.set(sessionKey, {
      taskId,
      allowed: new Set(allowedTools),
      maxCalls: budget.maxCalls,
      deadline: this.#now() + budget.timeoutMs,
      calls: 0,
      charged: new Map(),
      runId: null,
    });
  }

  /**
   * Attach the host-issued runId and verify the canonical accepted sessionKey
   * equals the one we bound. A mismatch releases the binding and throws.
   */
  confirm(sessionKey, { runId, sessionKey: acceptedKey }) {
    const binding = this.#bindings.get(sessionKey);
    if (!binding) throw new Error("no pending binding");
    if (typeof runId !== "string" || !runId || acceptedKey !== sessionKey) {
      this.#bindings.delete(sessionKey);
      throw new Error("run admission did not confirm the bound sessionKey/runId");
    }
    binding.runId = runId;
    this.#wake(sessionKey);
  }

  release(sessionKey) {
    const had = this.#bindings.delete(sessionKey);
    this.#wake(sessionKey);
    return had;
  }

  #wake(sessionKey) {
    const waiters = this.#waiters.get(sessionKey);
    this.#waiters.delete(sessionKey);
    for (const wake of waiters ?? []) wake();
  }

  /**
   * before_tool_call entry point. subagent.run() resolves at admission (the
   * Gateway `agent` RPC returns {runId} immediately), so the host may emit the
   * first tool call before this plugin's continuation has run confirm(). For a
   * pending binding, hold the call until confirm()/release() or the admission
   * wait elapses, then decide with check(); a timeout stays a terminal block.
   * The runId is never adopted from a hook event.
   */
  async checkWhenAdmitted(input) {
    const binding = this.isWorkerSession(input?.sessionKey) && this.#bindings.get(input.sessionKey);
    if (binding && binding.runId === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, this.#admissionWaitMs);
        timer.unref?.();
        function done() {
          clearTimeout(timer);
          resolve();
        }
        const list = this.#waiters.get(input.sessionKey) ?? [];
        list.push(done);
        this.#waiters.set(input.sessionKey, list);
      });
    }
    return this.check(input);
  }

  /**
   * Decide a before_tool_call. Returns {} to allow or a terminal block result.
   * `toolCallId` (optional host event field) identifies one logical call: when
   * several registered hooks see the same call, it is charged against maxCalls
   * once. Without an id calls cannot be told apart and each check is charged
   * (fail closed: over-counting never grants extra budget).
   */
  check(input) {
    const result = this.#decide(input ?? {});
    if (result.block) this.#record(result.reason, input ?? {});
    return result;
  }

  #decide({ sessionKey, runId, toolName, toolCallId }) {
    if (!this.isWorkerSession(sessionKey)) return {};
    const binding = this.#bindings.get(sessionKey);
    if (!binding) return blocked("worker call has no active binding", DENIAL_REASONS.WRONG_SESSION);
    if (binding.runId === null)
      return blocked("worker binding is not yet confirmed", DENIAL_REASONS.UNCONFIRMED);
    if (runId !== binding.runId)
      return blocked("runId does not match the bound run", DENIAL_REASONS.RUN_MISMATCH);
    if (this.#now() >= binding.deadline)
      return blocked("task time budget exhausted", DENIAL_REASONS.TIME_BUDGET);
    if (typeof toolName !== "string" || DELEGATION_SET.has(toolName)) {
      return blocked("delegation is not permitted", DENIAL_REASONS.DELEGATION);
    }
    if (!binding.allowed.has(toolName))
      return blocked(`tool ${toolName} is not granted`, DENIAL_REASONS.NOT_GRANTED);
    const id = typeof toolCallId === "string" && toolCallId ? toolCallId : null;
    if (id !== null && binding.charged.has(id)) {
      if (binding.charged.get(id) !== toolName)
        return blocked("toolCallId reused for another tool", DENIAL_REASONS.CALL_ID_REUSE);
      return {};
    }
    if (binding.calls >= binding.maxCalls)
      return blocked("tool call budget exhausted", DENIAL_REASONS.CALL_BUDGET);
    binding.calls += 1;
    if (id !== null) binding.charged.set(id, toolName);
    return {};
  }
}
