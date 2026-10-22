// LOCAL FAKE-HOST EVIDENCE ONLY. This composes the adapter's real plan state
// machine, dispatchReadyBatch, and registered orchestration_dispatch tool over a
// fake `api.runtime.subagent`. It is NOT live Gateway acceptance and does NOT
// prove host-owned Gateway-tool blocking. All labels are synthetic; no network,
// credentials, config, or Gateway action is involved.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCH_TOOL_NAME,
  assessPlanCompletion,
  createPlan,
  dispatchReadyBatch,
  plugin,
  readyTaskIds,
  recordGateOutcome,
} from "../src/index.js";

const PROHIBITED = ["Gateway restart", "Gateway reload", "Gateway kill", "delegation"];
const SCOPE = { tenantId: "main", channel: "webchat", conversationId: "agent:main:main" };
const owner = {
  senderIsOwner: true,
  requesterSenderId: "synthetic-owner",
  agentId: "main",
  sessionKey: "agent:main:main",
  deliveryContext: { channel: "webchat" },
};

function fakeHost() {
  const completions = [];
  const api = {
    on() {},
    registerTool: (...a) => api.tools.push(a),
    tools: [],
    runtime: {
      subagent: {
        async complete(args) {
          completions.push(args);
          const label = /synthetic-[a-z]+/.exec(args.message)?.[0] ?? "unknown";
          return { text: `evidence:${label}` };
        },
        async run() {
          throw new Error("tools mode must never be used in this fixture");
        },
      },
    },
    pluginConfig: {
      enabled: true,
      agentId: "main",
      workerRoutes: { standard: ["example/fake-standard"], cheap: ["example/fake-cheap"] },
      dispatch: { allowedTools: [], maxCalls: 3, maxTimeoutMs: 2000, maxTokens: 1000 },
    },
  };
  return { api, completions };
}

function task(id, dependencies = []) {
  return {
    contractVersion: 1,
    id,
    goal: `synthetic goal ${id}`,
    successCriteria: [`evidence for ${id}`],
    allowedTools: [],
    prohibitedActions: PROHIBITED,
    mode: "completion",
    routeTier: "cheap",
    dependencies,
    budget: { maxCalls: 1, timeoutMs: 1000, maxRetries: 0 },
    scope: SCOPE,
    outputSchema: { type: "object" },
  };
}

function setup(gates) {
  const host = fakeHost();
  plugin.register(host.api);
  assert.equal(host.api.tools.length, 1);
  assert.deepEqual(host.api.tools[0][1], { name: DISPATCH_TOOL_NAME, optional: true });
  const tool = host.api.tools[0][0](owner);
  assert.equal(tool.name, DISPATCH_TOOL_NAME);
  const plan = createPlan(
    [task("synthetic-a"), task("synthetic-b", ["synthetic-a"]), task("synthetic-c", ["synthetic-b"])],
    { gates, declaredAt: "2026-10-22T00:00:00.000Z" },
  );
  const grants = [];
  const toolCalls = [];
  const verifierInputs = [];
  // The plan's worker is the real registered tool; its details carry the evidence.
  const worker = async ({ task: t, grant }) => {
    grants.push(grant);
    const res = await tool.execute(`call-${t.id}`, {
      goal: t.goal,
      successCriteria: t.successCriteria,
      routeTier: t.routeTier,
      prohibitedActions: t.prohibitedActions,
    });
    toolCalls.push(res.details);
    return res.details;
  };
  // Independent verifier: judges returned evidence, never the worker's own claim.
  const verify = async (contract, output) => {
    verifierInputs.push({ id: contract.id, output });
    return {
      ok: output.verified === false && output.output.text === `evidence:${contract.id}`,
    };
  };
  const resolveModel = async () => "example/fake-cheap";
  return { host, plan, grants, toolCalls, verifierInputs, worker, verify, resolveModel };
}

test("local fake-host fixture composes real registered dispatch tool with plan waves and independent verification", async () => {
  const s = setup([
    {
      id: "owner-signoff",
      type: "approval",
      phase: "completion",
      description: "synthetic owner sign-off",
      maxEvidenceAgeMs: 60_000,
    },
  ]);
  const run = (plan = s.plan) =>
    dispatchReadyBatch(plan, {
      worker: s.worker,
      verify: s.verify,
      resolveModel: s.resolveModel,
      maxParallel: 4,
    });

  assert.deepEqual(readyTaskIds(s.plan), ["synthetic-a"]);
  const wave1 = await run();
  assert.deepEqual(wave1.dispatched.map((d) => [d.taskId, d.state]), [["synthetic-a", "succeeded"]]);
  assert.equal(s.plan.tasks.get("synthetic-b").state, "pending");
  assert.deepEqual(readyTaskIds(s.plan), ["synthetic-b"]);

  const wave2 = await run();
  assert.deepEqual(wave2.dispatched.map((d) => d.taskId), ["synthetic-b"]);
  const wave3 = await run();
  assert.deepEqual(wave3.dispatched.map((d) => d.taskId), ["synthetic-c"]);
  assert.ok(wave3.dispatched.every((d) => d.state === "succeeded" && d.verification.ok));

  // Order of host calls matches dependency order; the tool built its own task IDs.
  assert.equal(s.host.completions.length, 3);
  assert.deepEqual(
    s.host.completions.map((c) => /synthetic-[a-z]+/.exec(c.message)[0]),
    ["synthetic-a", "synthetic-b", "synthetic-c"],
  );
  assert.ok(s.host.completions.every((c) => c.model === "example/fake-cheap"));

  // Returned evidence is flagged unverified by the tool and judged by the separate verifier.
  assert.equal(s.verifierInputs.length, 3);
  assert.ok(s.toolCalls.every((d) => d.verified === false));
  assert.deepEqual(
    s.verifierInputs.map((v) => v.output.output.text),
    ["evidence:synthetic-a", "evidence:synthetic-b", "evidence:synthetic-c"],
  );

  // Grants are empty and the contract carries the explicit Gateway prohibition.
  assert.equal(s.grants.length, 3);
  for (const grant of s.grants) {
    assert.deepEqual(grant.allowedTools, []);
    assert.equal(grant.mayDelegate, false);
    assert.ok(grant.prohibitedActions.includes("Gateway restart"));
  }
  for (const c of s.host.completions) {
    assert.match(c.message, /Gateway restart/);
    assert.doesNotMatch(c.message, /"allowedTools": \[\s*"/);
  }
});

test("plan stops at the owner gate: tasks done but plan is not complete without owner sign-off", async () => {
  const s = setup([
    {
      id: "owner-signoff",
      type: "approval",
      phase: "completion",
      description: "synthetic owner sign-off",
      maxEvidenceAgeMs: 60_000,
    },
  ]);
  for (let i = 0; i < 3; i += 1) {
    await dispatchReadyBatch(s.plan, {
      worker: s.worker,
      verify: s.verify,
      resolveModel: s.resolveModel,
    });
  }
  const before = assessPlanCompletion(s.plan, { now: "2026-10-22T00:00:30.000Z" });
  assert.equal(before.complete, false);
  assert.deepEqual(before.unfinishedTasks, []);
  assert.deepEqual(before.incompleteGates, ["owner-signoff"]);

  // Only an explicit owner outcome releases the gate; the fixture never self-approves.
  recordGateOutcome(
    s.plan.gates,
    "owner-signoff",
    {
      status: "pass",
      evidence: {
        summary: "synthetic owner approval",
        source: "fixture",
        observedAt: "2026-10-22T00:00:10.000Z",
      },
    },
    { recordedAt: "2026-10-22T00:00:20.000Z" },
  );
  assert.equal(assessPlanCompletion(s.plan, { now: "2026-10-22T00:00:30.000Z" }).complete, true);
});

test("a pending preflight owner gate blocks dispatch before any tool call or host run", async () => {
  const s = setup([
    {
      id: "owner-preflight",
      type: "approval",
      description: "synthetic owner approval before execution",
      maxEvidenceAgeMs: 60_000,
    },
  ]);
  const result = await dispatchReadyBatch(s.plan, {
    worker: s.worker,
    verify: s.verify,
    resolveModel: s.resolveModel,
  });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockedGates, ["owner-preflight"]);
  assert.deepEqual(result.dispatched, []);
  assert.equal(s.host.completions.length, 0);
  assert.equal(s.grants.length, 0);
  assert.equal(s.plan.tasks.get("synthetic-a").state, "pending");
});

test("verifier rejection fails the task and keeps dependents pending", async () => {
  const s = setup([]);
  const result = await dispatchReadyBatch(s.plan, {
    worker: s.worker,
    verify: async () => ({ ok: false }),
    resolveModel: s.resolveModel,
  });
  assert.equal(result.dispatched[0].state, "failed");
  assert.equal(s.plan.tasks.get("synthetic-a").retryable, false);
  assert.deepEqual(readyTaskIds(s.plan), []);
  assert.equal(s.plan.tasks.get("synthetic-b").state, "pending");
});
