import { randomUUID } from "node:crypto";
import { TASK_CONTRACT_VERSION } from "./contracts.js";
import { ROUTE_TIERS } from "./model-routing.js";
import { DELEGATION_TOOLS } from "./tool-guard.js";

export const DISPATCH_TOOL_NAME = "orchestration_dispatch";

const DEFAULT_LIMITS = Object.freeze({ maxCalls: 20, timeoutMs: 300_000, maxTokens: 150_000 });

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
const stringList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim());

/**
 * Validate the deployment-owned `dispatch` config block. The ceiling is operator
 * config, never model input: the calling agent may only narrow it.
 */
export function normalizeDispatchConfig(config) {
  if (config === undefined) return undefined;
  if (!isRecord(config)) throw new TypeError("dispatch must be an object");
  const allowed = new Set(["allowedTools", "maxCalls", "maxTimeoutMs", "maxTokens"]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new TypeError(`dispatch.${key} is not a known setting`);
  }
  const allowedTools = config.allowedTools ?? [];
  if (!stringList(allowedTools)) throw new TypeError("dispatch.allowedTools must be strings");
  const clash = allowedTools.filter((t) => DELEGATION_TOOLS.includes(t));
  if (clash.length) throw new TypeError(`dispatch.allowedTools cannot grant ${clash.join(", ")}`);
  const limit = (key, fallback) => {
    const value = config[key] ?? fallback;
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`dispatch.${key} must be a positive integer`);
    }
    return value;
  };
  return Object.freeze({
    allowedTools: Object.freeze([...new Set(allowedTools)]),
    maxCalls: limit("maxCalls", DEFAULT_LIMITS.maxCalls),
    timeoutMs: limit("maxTimeoutMs", DEFAULT_LIMITS.timeoutMs),
    maxTokens: limit("maxTokens", DEFAULT_LIMITS.maxTokens),
  });
}

export const dispatchToolParameters = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["goal", "successCriteria", "routeTier"],
  properties: {
    goal: { type: "string", minLength: 1 },
    successCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    routeTier: { type: "string", enum: [...ROUTE_TIERS] },
    mode: { type: "string", enum: ["tools", "completion"] },
    allowedTools: { type: "array", items: { type: "string", minLength: 1 } },
    prohibitedActions: { type: "array", items: { type: "string", minLength: 1 } },
    outputSchema: { type: "object" },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxCalls: { type: "integer", minimum: 1 },
        timeoutMs: { type: "integer", minimum: 1 },
        maxTokens: { type: "integer", minimum: 1 },
      },
    },
  },
});

const PARAM_KEYS = new Set(Object.keys(dispatchToolParameters.properties));
const BUDGET_KEYS = new Set(Object.keys(dispatchToolParameters.properties.budget.properties));

/**
 * Host-trusted identity and scope, from the documented tool factory context
 * (docs: plugins/building-plugins.md, plugins/tool-plugins.md). Returns the
 * scope, or undefined when any required fact is absent so callers fail closed:
 * no placeholder tenant, channel, or conversation is ever invented.
 */
function trustedScope(context) {
  if (!isRecord(context)) return undefined;
  if (context.senderIsOwner !== true || context.sandboxed === true) return undefined;
  const channel = context.deliveryContext?.channel;
  if (![context.requesterSenderId, context.agentId, context.sessionKey, channel].every(nonEmpty)) {
    return undefined;
  }
  return { tenantId: context.agentId, channel, conversationId: context.sessionKey };
}

/**
 * Build a task contract from model-supplied params. Trust boundary: scope comes
 * from host tool context, never params; tools and budget must fit the operator
 * ceiling; delegation is never grantable; there is no model override, retry, or
 * dependency input.
 */
export function buildDispatchTask(params, limits, context) {
  if (!isRecord(params)) throw new TypeError("parameters must be an object");
  const scope = trustedScope(context);
  if (!scope) throw new TypeError("trusted requester and scope context is required");
  const unknown = Object.keys(params).filter((k) => !PARAM_KEYS.has(k));
  if (unknown.length) throw new TypeError(`unknown parameters: ${unknown.join(", ")}`);
  if (params.budget !== undefined && !isRecord(params.budget)) {
    throw new TypeError("budget must be an object");
  }
  const unknownBudget = Object.keys(params.budget ?? {}).filter((k) => !BUDGET_KEYS.has(k));
  if (unknownBudget.length) throw new TypeError(`unknown budget keys: ${unknownBudget.join(", ")}`);
  const mode = params.mode ?? "completion";
  const tools = params.allowedTools ?? [];
  if (!stringList(tools)) throw new TypeError("allowedTools must be strings");
  if (mode === "completion" && tools.length) {
    throw new TypeError("completion mode must not grant tools");
  }
  const over = tools.filter((t) => !limits.allowedTools.includes(t));
  if (over.length) {
    throw new RangeError(
      `allowedTools exceeds the configured dispatch ceiling: ${over.join(", ")}`,
    );
  }
  const requested = params.budget ?? {};
  const budget = {
    maxCalls: requested.maxCalls ?? limits.maxCalls,
    timeoutMs: requested.timeoutMs ?? limits.timeoutMs,
    maxTokens: requested.maxTokens ?? limits.maxTokens,
    maxRetries: 0,
  };
  for (const key of ["maxCalls", "timeoutMs", "maxTokens"]) {
    if (!Number.isInteger(budget[key]) || budget[key] < 1) {
      throw new TypeError(`budget.${key} must be a positive integer`);
    }
  }
  for (const [key, ceiling] of [
    ["maxCalls", limits.maxCalls],
    ["timeoutMs", limits.timeoutMs],
    ["maxTokens", limits.maxTokens],
  ]) {
    if (budget[key] > ceiling) throw new RangeError(`budget.${key} exceeds ceiling ${ceiling}`);
  }
  return {
    contractVersion: TASK_CONTRACT_VERSION,
    id: `dispatch-${randomUUID()}`,
    goal: params.goal,
    successCriteria: params.successCriteria,
    allowedTools: [...tools],
    prohibitedActions: params.prohibitedActions ?? [],
    mode,
    routeTier: params.routeTier,
    budget,
    scope,
    outputSchema: params.outputSchema ?? { type: "object" },
  };
}

/**
 * Agent tool factory for api.registerTool(factory, { name, optional: true }).
 * Returns null (tool hidden for the run) unless a dispatch ceiling is configured,
 * the requester is the verified owner (senderIsOwner), the run is not sandboxed,
 * and requesterSenderId, agentId, sessionKey, and deliveryContext.channel are present.
 * execute() re-validates the same context and never substitutes defaults.
 * A single dispatch has no independent verifier, so output is always reported
 * as unverified evidence for the calling agent to check.
 */
export function createDispatchToolFactory({ getHandle, limits }) {
  return function dispatchToolFactory(context) {
    if (!limits || !trustedScope(context)) return null;
    return {
      name: DISPATCH_TOOL_NAME,
      label: "Orchestration dispatch",
      description:
        "Dispatch one bounded, least-privilege worker task. Tools and budget are capped by deployment config; " +
        "the result is unverified worker output that you must check against the success criteria.",
      parameters: dispatchToolParameters,
      async execute(_toolCallId, params, signal) {
        const task = buildDispatchTask(params, limits, context ?? {});
        const result = await getHandle().dispatchTask(task, { signal });
        const details = {
          taskId: result.taskId,
          model: result.model,
          verified: false,
          output: result.output,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        };
      },
    };
  };
}
