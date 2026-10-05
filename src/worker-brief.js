import { assertValidTask } from "./contracts.js";
import { createMemoryEvidenceBrief } from "./memory-receipt.js";

const MAX_BRIEF_CHARS = 24_000;
const MAX_GOAL_CHARS = 4_000;
const MAX_CRITERIA = 20;
const MAX_GRANTS = 32;

/** Assemble a bounded, provenance-bearing worker brief without granting authority. */
export function createWorkerBrief(task, {
  memoryReceipt,
  memoryContent,
  maxChars = 12_000,
} = {}) {
  assertValidTask(task);
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_BRIEF_CHARS) {
    throw new RangeError(`maxChars must be an integer from 1 to ${MAX_BRIEF_CHARS}`);
  }
  if (task.goal.length > MAX_GOAL_CHARS || task.successCriteria.length > MAX_CRITERIA || task.allowedTools.length > MAX_GRANTS) {
    throw new RangeError("Task brief exceeds structural limits");
  }

  const memory = createMemoryEvidenceBrief(memoryReceipt, memoryContent, { maxChars });
  return Object.freeze({
    schemaVersion: 1,
    task: Object.freeze({
      id: task.id,
      goal: task.goal,
      successCriteria: Object.freeze([...task.successCriteria]),
      dependencies: Object.freeze([...(task.dependencies ?? [])]),
      scope: Object.freeze({ ...task.scope }),
      outputSchema: structuredClone(task.outputSchema),
    }),
    authority: Object.freeze({
      allowedTools: Object.freeze([...task.allowedTools]),
      prohibitedActions: Object.freeze([...task.prohibitedActions]),
      mayDelegate: false,
      maxCalls: task.budget.maxCalls,
      maxTokens: task.budget.maxTokens,
      timeoutMs: task.budget.timeoutMs,
      maxRetries: task.budget.maxRetries,
    }),
    memory,
    provenance: Object.freeze({
      taskContractVersion: task.contractVersion,
      memoryReceiptSchemaVersion: memoryReceipt?.schemaVersion ?? null,
      memoryTurnId: memory.turnId ?? null,
      memorySources: memory.sources ?? null,
    }),
  });
}
