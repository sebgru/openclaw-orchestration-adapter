// LOCAL FAKE-HOST EVIDENCE ONLY (Tasks 9.4 / 13.4). Public handle-level multi-task entry point:
// plugin.register(api) -> getOrchestration(api).dispatchReadyBatch(plan, ...).
// This fixture exercises the adapter's supported plan machinery through the handle.
// this runs tools mode through the real ToolGuard bind/confirm/hook path and the
// handle's worker-pool check. The fake host simulates workers issuing tool calls
// through the registered before_tool_call hook. NOT live Gateway acceptance; no
// network, credentials, config or Gateway action. All labels are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DENIAL_REASONS,
  assessPlanCompletion,
  createPlan,
  getOrchestration,
  plugin,
  readyTaskIds,
  recordGateOutcome,
} from "../src/index.js";

const SCOPE = { tenantId: "main", channel: "webchat", conversationId: "agent:main:main" };
const PROHIBITED = ["Gateway restart"];

function task(id, dependencies, over = {}) {
  return {
    contractVersion: 1,
    id,
    goal: `synthetic goal ${id}`,
    successCriteria: [`evidence for ${id}`],
    allowedTools: [],
    prohibitedActions: PROHIBITED,
    mode: "tools",
    routeTier: "standard",
    dependencies,
    budget: { maxCalls: 2, timeoutMs: 2000, maxTokens: 1000, maxRetries: 0 },
    scope: SCOPE,
    outputSchema: { type: "object" },
    ...over,
  };
}

// Bounded fake host. `script[taskLabel]` lists tool calls the "worker" attempts.
function fakeHost(script) {
  const hooks = [];
  const runs = [];
  const completions = [];
  const sessions = new Map();
  const toolOutcomes = [];
  let seq = 0;
  const subagent = {
    async run(args) {
      const runId = `fake-run-${(seq += 1)}`;
      const label = /synthetic-[a-z]+/.exec(args.message)[0];
      runs.push({ ...args, runId, label });
      sessions.set(args.sessionKey, { runId, label });
      return { runId, sessionKey: args.sessionKey };
    },
    async waitForRun({ runId }) {
      const [sessionKey, s] = [...sessions].find(([, v]) => v.runId === runId);
      for (const [i, call] of (script[s.label] ?? []).entries()) {
        const [hook] = hooks;
        const verdict = await hook(
          {
            toolName: call.toolName,
            params: call.params ?? {},
            runId,
            toolCallId: `${runId}-call-${i}`,
          },
          { sessionKey, runId },
        );
        toolOutcomes.push({
          label: s.label,
          toolName: call.toolName,
          blocked: verdict?.block === true,
        });
      }
      return { status: "ok" };
    },
    async getSessionMessages({ sessionKey }) {
      return {
        messages: [{ role: "assistant", content: `evidence:${sessions.get(sessionKey).label}` }],
      };
    },
    async deleteSession() {},
    async complete(args) {
      completions.push(args);
      return { text: "verdict" };
    },
  };
  const api = {
    on: (name, fn) => name === "before_tool_call" && hooks.push(fn),
    runtime: { subagent },
    pluginConfig: {
      enabled: true,
      agentId: "main",
      workerRoutes: { standard: ["example/fake-standard"], cheap: ["example/fake-cheap"] },
    },
  };
  return { api, runs, completions, toolOutcomes };
}

function setup({ gates = [], script = {}, tasks } = {}) {
  const host = fakeHost(script);
  plugin.register(host.api);
  const handle = getOrchestration(host.api);
  assert.ok(handle, "public entry point must expose the orchestration handle");
  const plan = createPlan(
    tasks ?? [
      task("synthetic-a", []),
      task("synthetic-b", ["synthetic-a"], { allowedTools: ["read"] }),
      task("synthetic-c", ["synthetic-b"]),
    ],
    { gates, declaredAt: "2026-10-22T00:00:00.000Z" },
  );
  // Evidence ledger: what the worker returned, then what the independent verifier decided.
  const ledger = [];
  const verifierContexts = [];
  const verify = async (contract, output, { model }) => {
    // Independent context: a fresh tool-free completion, never the worker's session.
    const res = await host.api.runtime.subagent.complete({
      message: `check ${contract.id} against ${contract.successCriteria[0]}: ${output.text}`,
    });
    verifierContexts.push({ id: contract.id, workerSession: output.sessionKey, model });
    const ok = output.text === `evidence:${contract.id}` && res.text === "verdict";
    ledger.push({ id: contract.id, runId: output.runId, evidence: output.text, ok });
    return { ok };
  };
  const run = (opts = {}) => handle.dispatchReadyBatch(plan, { verify, ...opts });
  return { host, handle, plan, ledger, verifierContexts, run };
}

test("public handle runs a multi-task plan through ToolGuard-bound workers with tracked, independently verified evidence", async () => {
  const s = setup({
    script: {
      "synthetic-a": [{ toolName: "gateway_exec", params: { command: "restart" } }],
      "synthetic-b": [
        { toolName: "read", params: { path: "x" } },
        { toolName: "sessions_spawn", params: {} },
      ],
    },
  });
  assert.deepEqual(readyTaskIds(s.plan), ["synthetic-a"]);
  for (const expected of ["synthetic-a", "synthetic-b", "synthetic-c"]) {
    const wave = await s.run({ resolveModel: async () => "example/fake-standard" });
    assert.deepEqual(
      wave.dispatched.map((d) => [d.taskId, d.state]),
      [[expected, "succeeded"]],
    );
  }
  // Workers actually ran in tools mode on bound, host-issued runs.
  assert.deepEqual(
    s.host.runs.map((r) => r.label),
    ["synthetic-a", "synthetic-b", "synthetic-c"],
  );
  for (const r of s.host.runs) {
    assert.match(r.sessionKey, /^agent:main:subagent:oca-/);
    assert.equal(r.toolsAlsoAllow, undefined);
    assert.equal(`${r.provider}/${r.model}`, "example/fake-standard");
  }
  // Guard decisions: restart attempt and delegation denied; the one granted read allowed.
  assert.deepEqual(s.host.toolOutcomes, [
    { label: "synthetic-a", toolName: "gateway_exec", blocked: true },
    { label: "synthetic-b", toolName: "read", blocked: false },
    { label: "synthetic-b", toolName: "sessions_spawn", blocked: true },
  ]);
  assert.deepEqual(
    s.handle.guard.denials.map((d) => d.reason),
    [DENIAL_REASONS.NOT_GRANTED, DENIAL_REASONS.DELEGATION],
  );
  assert.equal(s.handle.guard.size, 0, "all bindings released");

  // Evidence is tracked per task with the host runId, and judged by a separate context.
  assert.deepEqual(
    s.ledger.map((e) => [e.id, e.evidence, e.ok]),
    [
      ["synthetic-a", "evidence:synthetic-a", true],
      ["synthetic-b", "evidence:synthetic-b", true],
      ["synthetic-c", "evidence:synthetic-c", true],
    ],
  );
  assert.deepEqual(
    s.ledger.map((e) => e.runId),
    s.host.runs.map((r) => r.runId),
  );
  assert.equal(s.host.completions.length, 3);
  const workerSessions = new Set(s.host.runs.map((r) => r.sessionKey));
  for (const c of s.host.completions) assert.equal(c.sessionKey, undefined);
  for (const v of s.verifierContexts) {
    assert.ok(workerSessions.has(v.workerSession));
    assert.equal(
      s.host.completions.some((c) => c.sessionKey === v.workerSession),
      false,
    );
  }
});

test("worker pool is enforced on the handle path: a model outside the task's tier fails the task and starts no run", async () => {
  const s = setup();
  const result = await s.run({ resolveModel: async () => "example/fake-cheap" });
  assert.equal(result.dispatched[0].state, "failed");
  assert.equal(result.dispatched[0].error.name, "WorkerRouteError");
  assert.equal(s.host.runs.length, 0);
  assert.equal(s.ledger.length, 0);
  assert.deepEqual(readyTaskIds(s.plan), []);
});

test("verifier rejection stops the handle-run plan; dependents never start", async () => {
  const s = setup();
  const result = await s.handle.dispatchReadyBatch(s.plan, {
    verify: async () => ({ ok: false }),
  });
  assert.equal(result.dispatched[0].state, "failed");
  assert.equal(s.plan.tasks.get("synthetic-a").retryable, false);
  assert.deepEqual(readyTaskIds(s.plan), []);
  assert.equal((await s.run()).dispatched.length, 0);
  assert.equal(s.host.runs.length, 1);
});

test("handle run stops at the owner completion gate and a preflight gate blocks before any run", async () => {
  const completion = setup({
    gates: [
      {
        id: "owner-signoff",
        type: "approval",
        phase: "completion",
        description: "synthetic owner sign-off",
        maxEvidenceAgeMs: 60_000,
      },
    ],
  });
  for (let i = 0; i < 3; i += 1) await completion.run();
  const before = assessPlanCompletion(completion.plan, { now: "2026-10-22T00:00:30.000Z" });
  assert.equal(before.complete, false);
  assert.deepEqual(before.incompleteGates, ["owner-signoff"]);
  recordGateOutcome(
    completion.plan.gates,
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
  assert.equal(
    assessPlanCompletion(completion.plan, { now: "2026-10-22T00:00:30.000Z" }).complete,
    true,
  );

  const preflight = setup({
    gates: [
      {
        id: "owner-preflight",
        type: "approval",
        description: "synthetic approval before execution",
        maxEvidenceAgeMs: 60_000,
      },
    ],
  });
  const blocked = await preflight.run();
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.blockedGates, ["owner-preflight"]);
  assert.equal(preflight.host.runs.length, 0);
});

test("parallel independent tasks in one wave keep distinct sessions, runs and evidence", async () => {
  const s = setup({
    tasks: [
      task("synthetic-a", []),
      task("synthetic-b", []),
      task("synthetic-c", ["synthetic-a", "synthetic-b"]),
    ],
  });
  const wave = await s.run({ maxParallel: 4 });
  assert.deepEqual(wave.dispatched.map((d) => d.taskId).sort(), ["synthetic-a", "synthetic-b"]);
  assert.equal(new Set(s.host.runs.map((r) => r.sessionKey)).size, 2);
  assert.equal(new Set(s.host.runs.map((r) => r.runId)).size, 2);
  assert.deepEqual(s.ledger.map((e) => e.id).sort(), ["synthetic-a", "synthetic-b"]);
  assert.deepEqual(readyTaskIds(s.plan), ["synthetic-c"]);
});
