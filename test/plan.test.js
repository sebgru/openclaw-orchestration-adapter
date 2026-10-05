import test from "node:test";
import assert from "node:assert/strict";
import {
  assertValidTask,
  cancelPlan,
  createPlan,
  readyTaskIds,
  transitionTask,
  validateTask,
} from "../src/index.js";

function task(id, dependencies = []) {
  return {
    contractVersion: 1,
    id,
    goal: `Complete ${id}`,
    successCriteria: [`${id} result is verified`],
    allowedTools: ["read"],
    prohibitedActions: ["write", "external-send"],
    routeTier: "standard",
    budget: { maxCalls: 4, maxTokens: 8000, timeoutMs: 30000, maxRetries: 1 },
    scope: { tenantId: "opaque-tenant", channel: "webchat", conversationId: "opaque-chat" },
    outputSchema: { type: "object" },
    dependencies,
  };
}

test("accepts a valid v1 task and rejects missing safety bounds", () => {
  const valid = task("one");
  assert.deepEqual(validateTask(valid), []);
  assert.equal(assertValidTask(valid), valid);

  const invalid = task("bad");
  delete invalid.scope.tenantId;
  delete invalid.budget.maxCalls;
  assert.match(validateTask(invalid).join(" "), /budget\.maxCalls/);
  assert.match(validateTask(invalid).join(" "), /opaque tenantId/);
  assert.throws(() => assertValidTask(invalid), /Invalid task contract/);
});

test("rejects duplicate IDs, unknown dependencies, and dependency cycles", () => {
  assert.throws(() => createPlan([task("x"), task("x")]), /Duplicate task ID/);
  assert.throws(() => createPlan([task("x", ["missing"])]), /unknown dependency/);
  assert.throws(() => createPlan([task("x", ["y"]), task("y", ["x"])]), /dependency cycle/);
});

test("readiness and transitions enforce dependency completion", () => {
  const plan = createPlan([task("first"), task("second", ["first"])]);
  assert.deepEqual(readyTaskIds(plan), ["first"]);
  assert.throws(() => transitionTask(plan, "second", "ready"), /not ready/);

  transitionTask(plan, "first", "ready");
  transitionTask(plan, "first", "running");
  transitionTask(plan, "first", "verifying");
  transitionTask(plan, "first", "succeeded");
  assert.deepEqual(readyTaskIds(plan), ["second"]);
  transitionTask(plan, "second", "ready");
  assert.throws(() => transitionTask(plan, "second", "succeeded"), /Invalid task transition/);
});

test("plan snapshots input and cancellation preserves completed tasks", () => {
  const source = task("first");
  const plan = createPlan([source, task("second", ["first"])]);
  source.successCriteria[0] = "changed after planning";
  assert.equal(plan.tasks.get("first").contract.successCriteria[0], "first result is verified");

  transitionTask(plan, "first", "ready");
  transitionTask(plan, "first", "running");
  transitionTask(plan, "first", "verifying");
  transitionTask(plan, "first", "succeeded");
  cancelPlan(plan);
  assert.equal(plan.tasks.get("first").state, "succeeded");
  assert.equal(plan.tasks.get("second").state, "cancelled");
});
