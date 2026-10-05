import { assertValidTask, isTaskState } from "./contracts.js";

const TERMINAL = new Set(["succeeded", "failed", "blocked", "cancelled"]);
const ALLOWED_TRANSITIONS = {
  pending: new Set(["ready", "blocked", "cancelled"]),
  ready: new Set(["running", "blocked", "cancelled"]),
  running: new Set(["verifying", "failed", "blocked", "cancelled"]),
  verifying: new Set(["succeeded", "failed", "blocked", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(["ready"]),
  blocked: new Set(["ready", "cancelled"]),
  cancelled: new Set(),
};

/** Build a transient plan, rejecting duplicate IDs, missing dependencies, and cycles. */
export function createPlan(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0)
    throw new TypeError("A plan needs at least one task");

  const byId = new Map();
  for (const task of tasks) {
    assertValidTask(task);
    if (byId.has(task.id)) throw new TypeError(`Duplicate task ID: ${task.id}`);
    const snapshot = structuredClone(task);
    byId.set(
      task.id,
      Object.freeze({ ...snapshot, dependencies: [...(snapshot.dependencies ?? [])] }),
    );
  }

  for (const task of byId.values()) {
    for (const dependency of task.dependencies) {
      if (dependency === task.id) throw new TypeError(`Task ${task.id} cannot depend on itself`);
      if (!byId.has(dependency))
        throw new TypeError(`Task ${task.id} has unknown dependency ${dependency}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new TypeError(`Plan contains a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);

  return {
    tasks: new Map([...byId].map(([id, task]) => [id, { contract: task, state: "pending" }])),
  };
}

/** Return pending task IDs whose dependencies have all succeeded. */
export function readyTaskIds(plan) {
  return [...plan.tasks]
    .filter(
      ([, entry]) =>
        entry.state === "pending" &&
        entry.contract.dependencies.every((id) => plan.tasks.get(id)?.state === "succeeded"),
    )
    .map(([id]) => id);
}

/** Apply one explicit state transition; terminal states cannot be silently reopened. */
export function transitionTask(plan, taskId, nextState) {
  const entry = plan.tasks.get(taskId);
  if (!entry) throw new TypeError(`Unknown task ID: ${taskId}`);
  if (!isTaskState(nextState)) throw new TypeError(`Unknown task state: ${nextState}`);
  if (!ALLOWED_TRANSITIONS[entry.state].has(nextState)) {
    throw new TypeError(`Invalid task transition: ${entry.state} -> ${nextState}`);
  }
  if (nextState === "ready" && !readyTaskIds(plan).includes(taskId)) {
    throw new TypeError(`Task ${taskId} is not ready; dependencies have not succeeded`);
  }
  entry.state = nextState;
  return { ...entry };
}

export function cancelPlan(plan) {
  for (const [id, entry] of plan.tasks) {
    if (!TERMINAL.has(entry.state)) entry.state = "cancelled";
    plan.tasks.set(id, entry);
  }
}
