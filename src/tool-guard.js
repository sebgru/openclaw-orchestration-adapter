import { randomUUID } from "node:crypto";

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

function blocked(blockReason) {
  return { block: true, blockReason: `orchestration-adapter: ${blockReason}` };
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

  /**
   * admissionWaitMs bounds how long checkWhenAdmitted() holds a tool call while
   * the binding awaits confirm(); it must stay below the host's 15s
   * before_tool_call handler timeout (which also fails closed).
   */
  constructor({ now = Date.now, admissionWaitMs = 5000 } = {}) {
    this.#now = now;
    this.#admissionWaitMs = admissionWaitMs;
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

  /** Decide a before_tool_call. Returns {} to allow or a terminal block result. */
  check({ sessionKey, runId, toolName }) {
    if (!this.isWorkerSession(sessionKey)) return {};
    const binding = this.#bindings.get(sessionKey);
    if (!binding) return blocked("worker call has no active binding");
    if (binding.runId === null) return blocked("worker binding is not yet confirmed");
    if (runId !== binding.runId) return blocked("runId does not match the bound run");
    if (this.#now() >= binding.deadline) return blocked("task time budget exhausted");
    if (typeof toolName !== "string" || DELEGATION_SET.has(toolName)) {
      return blocked("delegation is not permitted");
    }
    if (!binding.allowed.has(toolName)) return blocked(`tool ${toolName} is not granted`);
    if (binding.calls >= binding.maxCalls) return blocked("tool call budget exhausted");
    binding.calls += 1;
    return {};
  }
}
