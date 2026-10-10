export const TASK_CONTRACT_VERSION = 1;
export const DEFAULT_MAX_TOKENS = 150_000;

/** Resolve the per-attempt token ceiling; null explicitly means unlimited. */
export function resolveMaxTokens(maxTokens) {
  return maxTokens === undefined ? DEFAULT_MAX_TOKENS : maxTokens;
}

const TASK_MODES = new Set(["tools", "completion"]);
const ROUTE_TIERS = new Set(["cheap", "standard", "strong"]);
const TASK_STATES = new Set([
  "pending",
  "ready",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

/** Validate the public, versioned input contract without mutating it. */
export function validateTask(task) {
  const errors = [];
  if (!isRecord(task)) return ["task must be an object"];
  if (task.contractVersion !== TASK_CONTRACT_VERSION) errors.push("contractVersion must be 1");
  if (!nonEmptyString(task.id)) errors.push("id must be a non-empty string");
  if (!nonEmptyString(task.goal)) errors.push("goal must be a non-empty string");
  if (
    !Array.isArray(task.successCriteria) ||
    task.successCriteria.length === 0 ||
    !task.successCriteria.every(nonEmptyString)
  ) {
    errors.push("successCriteria must contain one or more non-empty strings");
  }
  if (!Array.isArray(task.allowedTools) || !task.allowedTools.every(nonEmptyString)) {
    errors.push("allowedTools must be an array of non-empty strings");
  }
  if (!Array.isArray(task.prohibitedActions) || !task.prohibitedActions.every(nonEmptyString)) {
    errors.push("prohibitedActions must be an array of non-empty strings");
  }
  if (task.mode !== undefined && !TASK_MODES.has(task.mode)) {
    errors.push("mode must be tools or completion");
  }
  if (task.mode === "completion" && Array.isArray(task.allowedTools) && task.allowedTools.length) {
    errors.push("completion mode must not grant tools");
  }
  if (!ROUTE_TIERS.has(task.routeTier)) errors.push("routeTier must be cheap, standard, or strong");
  if (task.model !== undefined && !nonEmptyString(task.model)) {
    errors.push("model must be a non-empty model reference when set");
  }
  if (!isRecord(task.budget)) {
    errors.push("budget must be an object");
  } else {
    for (const key of ["maxCalls", "timeoutMs"]) {
      if (!Number.isInteger(task.budget[key]) || !positiveFinite(task.budget[key])) {
        errors.push(`budget.${key} must be a positive integer`);
      }
    }
    if (
      task.budget.maxTokens !== undefined &&
      task.budget.maxTokens !== null &&
      (!Number.isInteger(task.budget.maxTokens) || !positiveFinite(task.budget.maxTokens))
    ) {
      errors.push("budget.maxTokens must be a positive integer or null for unlimited");
    }
    if (task.budget.maxRetries !== 0 && task.budget.maxRetries !== 1) {
      errors.push("budget.maxRetries must be 0 or 1");
    }
  }
  if (
    !isRecord(task.scope) ||
    !nonEmptyString(task.scope.tenantId) ||
    !nonEmptyString(task.scope.channel) ||
    !nonEmptyString(task.scope.conversationId)
  ) {
    errors.push("scope must include opaque tenantId, channel, and conversationId values");
  }
  if (!isRecord(task.outputSchema)) errors.push("outputSchema must be a JSON Schema object");
  if (
    task.dependencies !== undefined &&
    (!Array.isArray(task.dependencies) || !task.dependencies.every(nonEmptyString))
  ) {
    errors.push("dependencies must be an array of task IDs");
  }
  return errors;
}

export function assertValidTask(task) {
  const errors = validateTask(task);
  if (errors.length) throw new TypeError(`Invalid task contract: ${errors.join("; ")}`);
  return task;
}

export function isTaskState(value) {
  return TASK_STATES.has(value);
}
