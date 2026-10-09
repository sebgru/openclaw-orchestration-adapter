import test from "node:test";
import assert from "node:assert/strict";
import {
  assessPlanCompletion,
  createPlan,
  dispatchReadyBatch,
  recordGateOutcome,
  transitionTask,
} from "../src/index.js";

const declaredAt = "2026-10-09T08:00:00.000Z";
const observedAt = "2026-10-09T08:05:00.000Z";
const task = {
  contractVersion: 1,
  id: "task-1",
  goal: "Complete the change",
  successCriteria: ["The result passes verification"],
  allowedTools: [],
  prohibitedActions: ["external-send"],
  routeTier: "standard",
  budget: { maxCalls: 1, maxTokens: 1000, timeoutMs: 10000, maxRetries: 0 },
  scope: { tenantId: "tenant", channel: "webchat", conversationId: "chat" },
  outputSchema: { type: "object" },
};

function planWithGate(type = "tests") {
  return createPlan([task], {
    declaredAt,
    gates: [
      {
        id: "quality",
        type,
        description: "Verify the resulting change",
        maxEvidenceAgeMs: 10 * 60 * 1000,
      },
    ],
  });
}

function succeedTask(plan) {
  transitionTask(plan, "task-1", "ready");
  transitionTask(plan, "task-1", "running");
  transitionTask(plan, "task-1", "verifying");
  transitionTask(plan, "task-1", "succeeded");
}

test("completion needs succeeded tasks and fresh observable gate evidence", () => {
  const plan = planWithGate();
  recordGateOutcome(
    plan.gates,
    "quality",
    { status: "pass", evidence: { summary: "CI passed", source: "run/123", observedAt } },
    { recordedAt: observedAt },
  );
  assert.equal(assessPlanCompletion(plan, { now: "2026-10-09T08:09:00.000Z" }).complete, false);
  succeedTask(plan);
  assert.equal(assessPlanCompletion(plan, { now: "2026-10-09T08:09:00.000Z" }).complete, true);
  const stale = assessPlanCompletion(plan, { now: "2026-10-09T08:16:00.000Z" });
  assert.equal(stale.complete, false);
  assert.deepEqual(stale.incompleteGates, ["quality"]);
});

test("pending, failed, and blocked gates hold completion; a waiver needs rationale", () => {
  const plan = planWithGate("approval");
  succeedTask(plan);
  assert.equal(assessPlanCompletion(plan, { now: observedAt }).complete, false);
  assert.throws(
    () =>
      recordGateOutcome(plan.gates, "quality", { status: "waived" }, { recordedAt: observedAt }),
    /rationale/,
  );
  recordGateOutcome(
    plan.gates,
    "quality",
    { status: "blocked", reason: "Owner approval has not arrived" },
    { recordedAt: observedAt },
  );
  assert.equal(assessPlanCompletion(plan, { now: observedAt }).complete, false);
  recordGateOutcome(
    plan.gates,
    "quality",
    { status: "fail", reason: "Required review rejected the result" },
    { recordedAt: observedAt },
  );
  assert.equal(assessPlanCompletion(plan, { now: observedAt }).complete, false);
  recordGateOutcome(
    plan.gates,
    "quality",
    {
      status: "waived",
      rationale: "This read-only plan has no external approval action.",
      waivedBy: "owner",
    },
    { recordedAt: observedAt },
  );
  assert.equal(assessPlanCompletion(plan, { now: observedAt }).complete, true);
  assert.equal(assessPlanCompletion(plan, { now: "2026-10-09T08:16:00.000Z" }).complete, false);
});

test("plans without declared gates cannot report completion", () => {
  const plan = createPlan([task]);
  succeedTask(plan);
  const assessment = assessPlanCompletion(plan, { now: observedAt });
  assert.equal(assessment.complete, false);
  assert.equal(assessment.noGatesDeclared, true);
});

test("approval preflight gates block dispatch until observed evidence or a rationale waiver exists", async () => {
  const now = new Date().toISOString();
  const plan = createPlan([task], {
    declaredAt: now,
    gates: [
      {
        id: "owner-approval",
        type: "approval",
        description: "Owner authorizes the bounded plan",
        maxEvidenceAgeMs: 60_000,
      },
      {
        id: "tests",
        type: "tests",
        description: "Run the relevant tests",
        maxEvidenceAgeMs: 60_000,
      },
    ],
  });
  let workerCalls = 0;
  const options = {
    resolveModel: () => "configured:model",
    worker: async () => {
      workerCalls += 1;
      return { output: "complete" };
    },
    verify: async () => ({ ok: true }),
  };
  const held = await dispatchReadyBatch(plan, options);
  assert.equal(held.blocked, true);
  assert.deepEqual(held.blockedGates, ["owner-approval"]);
  assert.equal(workerCalls, 0);
  assert.equal(plan.tasks.get("task-1").state, "pending");

  const approvedAt = new Date().toISOString();
  recordGateOutcome(
    plan.gates,
    "owner-approval",
    {
      status: "pass",
      evidence: {
        summary: "Owner approved this plan",
        source: "current user turn",
        observedAt: approvedAt,
      },
    },
    { recordedAt: approvedAt },
  );
  const result = await dispatchReadyBatch(plan, options);
  assert.equal(result.dispatched[0].state, "succeeded");
  assert.equal(workerCalls, 1);
  assert.equal(assessPlanCompletion(plan).complete, false);

  const testedAt = new Date().toISOString();
  recordGateOutcome(
    plan.gates,
    "tests",
    {
      status: "pass",
      evidence: { summary: "All tests passed", source: "CI run", observedAt: testedAt },
    },
    { recordedAt: testedAt },
  );
  assert.equal(assessPlanCompletion(plan).complete, true);
});

test("gate definitions and outcomes reject invalid, duplicate, future, and stale evidence", () => {
  assert.throws(() => createPlan([task], { gates: "tests" }), /gates must be an array/);
  assert.throws(() => planWithGate("unsupported"), /supported gate type/);
  assert.throws(
    () =>
      createPlan([task], {
        gates: [
          {
            id: "x",
            type: "approval",
            phase: "middle",
            description: "x",
            maxEvidenceAgeMs: 100,
          },
        ],
      }),
    /phase must be preflight or completion/,
  );
  assert.throws(
    () =>
      createPlan([task], {
        gates: [
          { id: "x", type: "tests", description: "x", maxEvidenceAgeMs: 100 },
          { id: "x", type: "lint", description: "y", maxEvidenceAgeMs: 100 },
        ],
      }),
    /duplicate gate ID/,
  );
  const plan = planWithGate();
  assert.equal(plan.gates.gates, undefined);
  assert.throws(() => recordGateOutcome(plan.gates, "quality", null), /outcome must be an object/);
  assert.throws(
    () => recordGateOutcome(plan.gates, "quality", { status: "skipped" }),
    /status must be pass, fail, blocked, or waived/,
  );
  assert.throws(
    () => recordGateOutcome(plan.gates, "quality", { status: "pass" }),
    /passing gate requires evidence/,
  );
  assert.throws(
    () =>
      recordGateOutcome(
        plan.gates,
        "quality",
        {
          status: "pass",
          evidence: { summary: "pass", source: "ci", observedAt: "2026-10-09T07:59:00.000Z" },
        },
        { recordedAt: observedAt },
      ),
    /between gate declaration and outcome recording/,
  );
  assert.throws(
    () => recordGateOutcome(plan.gates, "missing", { status: "pass" }),
    /unknown gate ID/,
  );
  assert.throws(
    () => assessPlanCompletion(plan, { now: "not-a-timestamp" }),
    /parseable timestamp/,
  );
});

test("a preflight waiver is visible and opens execution readiness", async () => {
  const { assessPlanExecutionReadiness } = await import("../src/index.js");
  const plan = createPlan([task], {
    declaredAt,
    gates: [
      {
        id: "approval",
        type: "approval",
        description: "Owner approval for an external action",
        maxEvidenceAgeMs: 60_000,
      },
    ],
  });
  recordGateOutcome(
    plan.gates,
    "approval",
    { status: "waived", rationale: "This plan performs no external action." },
    { recordedAt: observedAt },
  );
  const readiness = assessPlanExecutionReadiness(plan, { now: observedAt });
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.gates, [{ id: "approval", status: "waived", ready: true }]);
  assert.equal(
    assessPlanExecutionReadiness(plan, { now: "2026-10-09T08:06:01.000Z" }).ready,
    false,
  );
});
