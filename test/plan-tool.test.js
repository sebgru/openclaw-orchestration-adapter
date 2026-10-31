import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_TOOL_NAME,
  buildPlanFromParams,
  createModelVerifier,
  createPlanToolFactory,
  normalizeDispatchConfig,
  normalizePlanConfig,
  plugin,
  transitionTask,
} from "../src/index.js";

function fakeApi(pluginConfig, { verdict = '{"ok":true,"evidence":"met"}' } = {}) {
  const tools = [];
  const runs = [];
  const subagent = {
    async complete(a) {
      runs.push(["complete", a]);
      const isVerifier = a.message.includes("Judge whether the worker result");
      return { text: isVerifier ? verdict : "worker-answer" };
    },
    async run(a) {
      runs.push(["run", a]);
      return { runId: `r${runs.length}`, sessionKey: a.sessionKey };
    },
    async waitForRun() {
      return { status: "ok" };
    },
    async getSessionMessages() {
      return { messages: [{ role: "assistant", content: "tool-done" }] };
    },
    async deleteSession() {},
  };
  const api = {
    on() {},
    registerTool: (...a) => tools.push(a),
    runtime: { subagent },
    pluginConfig,
  };
  return { api, tools, runs };
}

const config = {
  enabled: true,
  agentId: "main",
  workerRoutes: { standard: ["example/m1"], cheap: ["example/m2"], strong: ["example/m3"] },
  dispatch: {
    allowedTools: ["read"],
    maxCalls: 5,
    maxTimeoutMs: 2000,
    maxTokens: 1000,
    plan: { maxTasks: 4, maxParallel: 2 },
  },
};
const owner = {
  senderIsOwner: true,
  requesterSenderId: "user-1",
  agentId: "main",
  sessionKey: "agent:main:main",
  deliveryContext: { channel: "webchat" },
};
const reviewGate = {
  id: "owner-review",
  type: "custom",
  description: "Owner reviews results",
  phase: "completion",
  maxEvidenceAgeMs: 1000,
};
const t = (id, extra = {}) => ({
  id,
  goal: `goal ${id}`,
  successCriteria: ["ok"],
  routeTier: "cheap",
  ...extra,
});

function setup(cfg = config, opts) {
  const f = fakeApi(cfg, opts);
  plugin.register(f.api);
  const planTool = f.tools.find((x) => x[1].name === PLAN_TOOL_NAME);
  return { ...f, planTool, tool: planTool?.[0](owner) };
}

test("plan tool is registered only with dispatch.plan and hidden without trusted owner scope", () => {
  const off = setup({ ...config, dispatch: { ...config.dispatch, plan: undefined } });
  assert.equal(off.planTool, undefined);
  const { planTool, tool } = setup();
  assert.deepEqual(planTool[1], { name: PLAN_TOOL_NAME, optional: true });
  assert.equal(tool.name, PLAN_TOOL_NAME);
  assert.equal(tool.parameters.additionalProperties, false);
  for (const bad of [{}, { ...owner, senderIsOwner: false }, { ...owner, sandboxed: true }, null]) {
    assert.equal(planTool[0](bad), null);
  }
});

test("dependency waves run in order with context-separated verification and an owner-review stop", async () => {
  const { tool, runs } = setup();
  const res = await tool.execute("c", {
    tasks: [t("a"), t("b"), t("c", { dependencies: ["a", "b"] })],
    gates: [reviewGate],
  });
  const d = res.details;
  assert.deepEqual(d.waves, [["a", "b"], ["c"]]);
  assert.equal(d.allTasksSucceeded, true);
  assert.equal(d.complete, false, "owner-review completion gate is never satisfied by this tool");
  assert.equal(d.ownerReviewRequired, true);
  assert.deepEqual(d.incompleteGates, ["owner-review"]);
  assert.match(d.continuation, /fresh explicit owner-directed call/);
  assert.doesNotMatch(JSON.stringify(d), /resum(e|es) |record(ed)? (a |the )?gate/i);
  assert.ok(d.tasks.every((x) => x.state === "succeeded" && x.verifierAccepted === true));
  assert.equal(d.tasks[0].output.text, "worker-answer");
  const verifierRuns = runs.filter((r) => r[1].message.includes("Judge whether the worker result"));
  assert.equal(verifierRuns.length, 3);
  assert.match(verifierRuns[0][1].message, /untrusted data/);
});

test("plan tasks honor exact model pins only within their configured tier pool", async () => {
  const cfg = {
    ...config,
    workerRoutes: {
      ...config.workerRoutes,
      review: ["example/reviewer", "example/reviewer-alt"],
    },
  };
  const { tool, runs } = setup(cfg);
  const result = await tool.execute("c", {
    tasks: [t("review", { routeTier: "review", model: "example/reviewer-alt" })],
    gates: [reviewGate],
  });
  assert.equal(result.details.tasks[0].model, "example/reviewer-alt");
  const workerRun = runs.find(
    ([kind, args]) => kind === "complete" && !args.message.includes("Judge whether"),
  );
  assert.equal(workerRun[1].model, "example/reviewer-alt");
  const rejected = await tool.execute("bad", {
    tasks: [t("review", { routeTier: "review", model: "example/m1" })],
    gates: [reviewGate],
  });
  assert.equal(rejected.details.tasks[0].state, "failed");
  assert.equal(runs.filter(([kind]) => kind === "complete").length, 2);
});

test("verifier is a separate tool-free completion context with transparent model and no side-effect claim", async () => {
  const { tool, runs } = setup();
  const res = await tool.execute("c", { tasks: [t("a")], gates: [reviewGate] });
  const d = res.details;
  const completions = runs.filter((r) => r[0] === "complete");
  assert.equal(completions.length, 2, "worker and verifier are distinct completion calls");
  const verifierCall = completions.find((r) =>
    r[1].message.includes("Judge whether the worker result"),
  )[1];
  const workerCall = completions.find(
    (r) => !r[1].message.includes("Judge whether the worker result"),
  )[1];
  assert.notEqual(verifierCall.message, workerCall.message);
  assert.ok(!("sessionKey" in verifierCall), "verifier gets no worker session or tools");
  assert.equal(runs.filter((r) => r[0] === "run").length, 0, "no tool-capable session is run");
  const v = d.tasks[0].verification;
  assert.equal(v.method, "context-separated-model-judgment");
  assert.equal(v.sideEffectsChecked, false);
  assert.equal(typeof v.sameModelAsWorker, "boolean");
  assert.equal(v.workerModel, d.tasks[0].model);
  assert.equal(v.sameModelAsWorker, v.verifierModel === v.workerModel);
  assert.match(d.verificationNote, /not model-independent or ground-truth/);
  assert.ok(!("verified" in d.tasks[0]), "ambiguous verified field is gone");
});

test("verifier on a different tier reports a different model than the worker", async () => {
  const cfg = {
    ...config,
    dispatch: { ...config.dispatch, plan: { maxTasks: 4, verifierTier: "strong" } },
  };
  const { tool } = setup(cfg);
  const res = await tool.execute("c", { tasks: [t("a")], gates: [reviewGate] });
  const v = res.details.tasks[0].verification;
  assert.equal(v.sameModelAsWorker, false);
  assert.notEqual(v.verifierModel, v.workerModel);
});

test("task grants stay task-specific and tools-mode workers are bound", async () => {
  const { tool, runs } = setup();
  const res = await tool.execute("c", {
    tasks: [t("a", { mode: "tools", allowedTools: ["read"], routeTier: "standard" }), t("b")],
    gates: [reviewGate],
  });
  assert.equal(res.details.allTasksSucceeded, true);
  const toolRun = runs.find((r) => r[0] === "run")[1];
  assert.equal(toolRun.toolsAlsoAllow, undefined);
  const completions = runs.filter((r) => r[0] === "complete");
  assert.ok(completions.every((r) => !("sessionKey" in r[1])));
});

test("verifier rejection fails the task and cancels dependents (fail-fast)", async () => {
  const { tool, runs } = setup(config, { verdict: '{"ok":false,"evidence":"nope"}' });
  const res = await tool.execute("c", {
    tasks: [t("a"), t("b", { dependencies: ["a"] })],
    gates: [reviewGate],
  });
  const d = res.details;
  assert.equal(d.allTasksSucceeded, false);
  assert.equal(d.tasks[0].state, "failed");
  assert.equal(d.tasks[0].verifierAccepted, false);
  assert.equal(d.tasks[1].state, "cancelled");
  assert.equal(
    runs.filter((r) => !r[1].message.includes("Judge whether the worker result")).length,
    1,
  );
});

test("non-JSON and malformed verifier verdicts fail closed", async () => {
  for (const verdict of ["looks fine", "{not json}", '{"ok":"yes"}']) {
    const { tool } = setup(config, { verdict });
    const res = await tool.execute("c", { tasks: [t("a")], gates: [reviewGate] });
    assert.equal(res.details.tasks[0].state, "failed", verdict);
  }
});

test("preflight owner gate blocks every dispatch", async () => {
  const { tool, runs } = setup();
  const res = await tool.execute("c", {
    tasks: [t("a")],
    gates: [
      {
        id: "owner-ok",
        type: "approval",
        description: "Owner approves",
        phase: "preflight",
        maxEvidenceAgeMs: 1000,
      },
      reviewGate,
    ],
  });
  assert.deepEqual(res.details.blockedGates, ["owner-ok"]);
  assert.equal(res.details.tasks[0].state, "cancelled");
  assert.equal(res.details.complete, false);
  assert.equal(runs.length, 0);
});

test("completion gate always leaves complete=false even when all tasks succeed", async () => {
  const { tool } = setup();
  const res = await tool.execute("c", { tasks: [t("a"), t("b")], gates: [reviewGate] });
  assert.equal(res.details.allTasksSucceeded, true);
  assert.equal(res.details.complete, false);
  assert.equal(res.details.ownerReviewRequired, true);
  assert.deepEqual(res.details.incompleteGates, ["owner-review"]);
  assert.deepEqual(res.details.blockedGates, []);
});

test("a plan without a completion gate is rejected before any dispatch", async () => {
  const { tool, runs } = setup();
  const preflightOnly = { ...reviewGate, id: "p", type: "approval", phase: "preflight" };
  for (const gates of [undefined, [], [preflightOnly]]) {
    await assert.rejects(
      tool.execute("c", { tasks: [t("a")], ...(gates ? { gates } : {}) }),
      /completion-phase|at most|array/,
    );
  }
  await assert.rejects(
    tool.execute("c", { tasks: [t("a")], gates: [{ ...reviewGate, phase: undefined }] }),
    /declare phase/,
  );
  await assert.rejects(
    tool.execute("c", { tasks: [t("a")], gates: [{ ...reviewGate, phase: "later" }] }),
    /declare phase/,
  );
  assert.equal(runs.length, 0);
});

test("validation rejects bad plans before any dispatch", async () => {
  const { tool, runs } = setup();
  const bad = [
    [{ tasks: [] }, /non-empty/],
    [{ tasks: [t("a"), t("b"), t("c"), t("d"), t("e")] }, /maxTasks/],
    [{ tasks: [t("a"), t("a")] }, /Duplicate/],
    [{ tasks: [t("a", { dependencies: ["zz"] })] }, /unknown dependency/],
    [{ tasks: [t("a", { dependencies: ["a"] })] }, /itself/],
    [{ tasks: [t("a", { dependencies: ["b"] }), t("b", { dependencies: ["a"] })] }, /cycle/],
    [{ tasks: [t("A!")] }, /id must match/],
    [{ tasks: [t("a", { scope: {} })] }, /unknown parameters/],
    [{ tasks: [t("a", { dependencies: [], extra: true })] }, /unknown parameters/],
    [{ tasks: [t("a", { mode: "tools", allowedTools: ["exec"] })] }, /cannot grant/],
    [{ tasks: [t("a", { mode: "tools", allowedTools: ["sessions_spawn"] })] }, /cannot grant/],
    [{ tasks: [t("a", { budget: { timeoutMs: 9999 } })] }, /ceiling/],
    [{ tasks: [t("a")], extra: 1 }, /unknown parameters/],
    [{ tasks: [t("a")], gates: [{ id: "g", bogus: 1 }] }, /unknown gate keys/],
    [{ tasks: [t("a")], gates: Array.from({ length: 9 }, () => reviewGate) }, /at most/],
    [{ tasks: [t("a")], gates: "x" }, /at most|array/],
    [{ tasks: [t("a")], gates: ["x"] }, /gate must be an object/],
    [{ tasks: [t("a", { dependencies: "a" })] }, /dependencies/],
    [{ tasks: ["x"] }, /must be an object/],
    [{ tasks: "x" }, /non-empty/],
    [null, /object/],
  ];
  for (const [raw, re] of bad) {
    const params =
      raw && typeof raw === "object" && !("gates" in raw) ? { gates: [reviewGate], ...raw } : raw;
    await assert.rejects(tool.execute("c", params), re, JSON.stringify(raw).slice(0, 60));
  }
  assert.equal(runs.length, 0);
});

test("Gateway, shell, and restart tools are denied even if the operator allowlisted them", () => {
  const limits = normalizeDispatchConfig({ allowedTools: ["gateway_exec", "exec", "read"] });
  const planLimits = normalizePlanConfig({});
  for (const forbiddenTool of ["gateway_exec", "exec", "gateway_restart"]) {
    assert.throws(
      () =>
        buildPlanFromParams(
          {
            tasks: [t("a", { mode: "tools", allowedTools: [forbiddenTool] })],
            gates: [reviewGate],
          },
          limits,
          planLimits,
          owner,
        ),
      new RegExp(`cannot grant ${forbiddenTool}`),
    );
  }
});

test("execute fails closed when trusted context disappears", async () => {
  const f = fakeApi(config);
  plugin.register(f.api);
  const ctx = { ...owner };
  const tool = f.tools.find((x) => x[1].name === PLAN_TOOL_NAME)[0](ctx);
  ctx.requesterSenderId = undefined;
  await assert.rejects(
    tool.execute("c", { tasks: [t("a")], gates: [reviewGate] }),
    /trusted requester/,
  );
  assert.equal(f.runs.length, 0);
});

test("abort signal stops further waves", async () => {
  const { tool, runs } = setup();
  const controller = new AbortController();
  controller.abort();
  const res = await tool.execute("c", { tasks: [t("a")], gates: [reviewGate] }, controller.signal);
  assert.equal(res.details.allTasksSucceeded, false);
  assert.equal(res.details.tasks[0].state, "cancelled");
  assert.equal(runs.length, 0);
});

test("large worker output is truncated in the result", async () => {
  const f = fakeApi(config);
  f.api.runtime.subagent.complete = async (a) => ({
    text: a.message.includes("Judge whether the worker result")
      ? '{"ok":true}'
      : "x".repeat(20_000),
  });
  plugin.register(f.api);
  const tool = f.tools.find((x) => x[1].name === PLAN_TOOL_NAME)[0](owner);
  const res = await tool.execute("c", { tasks: [t("a")], gates: [reviewGate] });
  assert.equal(res.details.tasks[0].output.truncated, true);
});

test("a verifier route failure (unconfigured tier) fails the task", async () => {
  const cfg = {
    ...config,
    dispatch: { ...config.dispatch, plan: { verifierTier: "priority" } },
  };
  const { tool } = setup(cfg);
  const res = await tool.execute("c", { tasks: [t("a")], gates: [reviewGate] });
  assert.equal(res.details.tasks[0].state, "failed");
  assert.equal(res.details.tasks[0].verifierAccepted, false);
});

test("normalizePlanConfig validates bounds", () => {
  assert.equal(normalizePlanConfig(undefined), undefined);
  assert.equal(normalizePlanConfig({}).maxTasks, 8);
  assert.throws(() => normalizePlanConfig("x"), /object/);
  assert.throws(() => normalizePlanConfig({ bogus: 1 }), /not a known/);
  assert.throws(() => normalizePlanConfig({ maxTasks: 17 }), /1 to 16/);
  assert.throws(() => normalizePlanConfig({ maxParallel: 0 }), /1 to 8/);
  assert.throws(() => normalizePlanConfig({ verifierTier: "x" }), /route tier/);
  assert.equal(normalizePlanConfig({ verifierTier: "strong" }).verifierTier, "strong");
});

test("verifier handles missing verdict text, missing evidence, and absent models", async () => {
  const contract = {
    contractVersion: 1,
    id: "t",
    goal: "g",
    successCriteria: ["ok"],
    routeTier: "cheap",
    budget: { timeoutMs: 1000 },
    scope: owner,
  };
  const verifierFor = (output) => createModelVerifier({ dispatchTask: async () => ({ output }) });

  // Missing output text is rejected without throwing, and undefined models report null.
  const noText = await verifierFor(undefined)(contract, undefined);
  assert.deepEqual(noText, {
    ok: false,
    evidence: "verifier returned no JSON verdict",
    method: "context-separated-model-judgment",
    verifierModel: undefined,
    workerModel: undefined,
    sameModelAsWorker: null,
    sideEffectsChecked: false,
  });

  // An accepted verdict with no evidence field defaults to an empty evidence string.
  const noEvidence = await verifierFor({ text: '{"ok":true}' })(
    contract,
    { text: "w" },
    {
      model: "example/m1",
    },
  );
  assert.equal(noEvidence.ok, true);
  assert.equal(noEvidence.evidence, "");

  // Output that JSON cannot serialize still yields a bounded evidence string.
  const fnOutput = await verifierFor({ text: '{"ok":false,"evidence":"x"}' })(contract, () => {});
  assert.equal(fnOutput.ok, false);
  assert.equal(fnOutput.evidence, "x");
});

test("plan results safely bound missing and non-serializable worker output", async () => {
  const limits = normalizeDispatchConfig({ allowedTools: ["read"], maxCalls: 5, maxTokens: 1000 });
  const planLimits = normalizePlanConfig({});
  const outputs = [undefined, () => {}];
  let batches = 0;
  const factory = createPlanToolFactory({
    limits,
    planLimits,
    getHandle: () => ({
      dispatchTask: async () => ({ model: "example/m2", output: { text: "unused" } }),
      async dispatchReadyBatch(plan, { verify }) {
        batches += 1;
        const pending = [...plan.tasks].filter(([, entry]) => entry.state === "pending");
        if (pending.length === 0) return { dispatched: [] };
        const dispatched = [];
        for (const [index, [id, entry]] of pending.entries()) {
          transitionTask(plan, id, "ready");
          transitionTask(plan, id, "running");
          transitionTask(plan, id, "verifying");
          await verify(entry.contract, outputs[index], { model: "example/m2" });
          transitionTask(plan, id, "succeeded");
          dispatched.push({
            taskId: id,
            state: "succeeded",
            model: "example/m2",
            verification: { ok: true },
          });
        }
        return { dispatched };
      },
    }),
  });
  const res = await factory(owner).execute("c", {
    tasks: [t("a"), t("b")],
    gates: [reviewGate],
  });
  assert.equal(batches, 2, "the second wave finds nothing left to dispatch");
  assert.deepEqual(res.details.waves, [["a", "b"]]);
  assert.equal(res.details.tasks[0].output, undefined);
  assert.equal(typeof res.details.tasks[1].output, "function");
  assert.doesNotThrow(() => JSON.stringify(res.details));
});
