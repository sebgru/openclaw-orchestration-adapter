import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrchestration, plugin, registerOrchestration } from "../src/index.js";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function task(over = {}) {
  return {
    contractVersion: 1,
    id: "t",
    goal: "do it",
    successCriteria: ["done"],
    allowedTools: ["read"],
    prohibitedActions: [],
    routeTier: "standard",
    budget: { maxCalls: 2, maxTokens: 100, timeoutMs: 1000, maxRetries: 0 },
    scope: { tenantId: "a", channel: "c", conversationId: "d" },
    outputSchema: { type: "object" },
    ...over,
  };
}

function fakeApi(pluginConfig, runtime = {}) {
  const hooks = [];
  const calls = [];
  const subagent = {
    async complete(a) {
      calls.push(["complete", a]);
      return { text: "ok" };
    },
    async run(a) {
      calls.push(["run", a]);
      return { runId: "run-1", sessionKey: a.sessionKey };
    },
    async waitForRun() {
      return { status: "ok" };
    },
    async getSessionMessages() {
      return { messages: [{ role: "assistant", content: "done" }] };
    },
    async deleteSession() {},
    ...runtime,
  };
  return {
    api: { on: (...a) => hooks.push(a), runtime: { subagent }, pluginConfig },
    hooks,
    calls,
  };
}

test("default export stays inactive without explicit enablement", () => {
  for (const config of [undefined, {}, { enabled: false }, { enabled: "true" }]) {
    const { api, hooks } = fakeApi(config);
    plugin.register(api);
    assert.equal(hooks.length, 0);
    assert.equal(getOrchestration(api), undefined);
  }
  assert.equal(manifest.activation.onStartup, false);
  assert.equal(manifest.configSchema.properties.enabled.default, false);
});

test("register() wires the hook and a handle whose dispatch uses the guard-bound worker", async () => {
  const { api, hooks, calls } = fakeApi({ enabled: true, agentId: "main" });
  plugin.register(api);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0][0], "before_tool_call");
  const handle = getOrchestration(api);
  assert.ok(handle);

  const out = await handle.dispatchTask(task(), { resolveModel: () => "openai/gpt-6-luna" });
  assert.equal(out.output.text, "done");
  const run = calls.find((c) => c[0] === "run")[1];
  assert.match(run.sessionKey, /^agent:main:subagent:oca-/);
  assert.equal(run.toolsAlsoAllow, undefined);
  assert.equal(handle.guard.size, 0);

  const done = await handle.dispatchTask(task({ mode: "completion", allowedTools: [] }), {
    resolveModel: () => "anthropic/claude-haiku-4-5",
  });
  assert.equal(done.output.text, "ok");
});

test("dispatchReadyBatch is wired through the handle and still requires a verifier", async () => {
  const { api } = fakeApi({ enabled: true, agentId: "main" });
  const handle = registerOrchestration(api, { agentId: "main" });
  await assert.rejects(handle.dispatchReadyBatch({ tasks: [] }, {}), /verifier/);
});

test("manifest declares only documented fields and an agentId pattern", () => {
  assert.equal(manifest.id, "openclaw-orchestration-adapter");
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.match("main", new RegExp(manifest.configSchema.properties.agentId.pattern));
  assert.doesNotMatch("a:b", new RegExp(manifest.configSchema.properties.agentId.pattern));
});

test("packaging metadata ships the manifest and any declared skill directory", () => {
  assert.ok(pkg.files.includes("openclaw.plugin.json"));
  assert.ok(pkg.files.includes("src"));
  assert.ok(pkg.files.includes("skills"));
  assert.ok(pkg.files.includes("NOTICE"));
  const expectedSkills = [
    "skills/requesting-code-review",
    "skills/channel-context-bridge",
    "skills/expansion-grant-guard",
    "skills/task-handoff",
    "skills/loop-circuit-breaker",
    "skills/writing-plans",
    "skills/workflow-orchestration",
    "skills/dispatching-parallel-agents",
    "skills/executing-plans",
    "skills/quality-gate-orchestrator",
    "skills/spend-circuit-breaker",
    "skills/long-running-task-management",
    "skills/verification-before-completion",
    "skills/multi-agent-coordinator",
    "skills/subagent-driven-development",
  ];
  assert.deepEqual(manifest.skills, expectedSkills);
  for (const dir of manifest.skills) {
    assert.ok(
      !isAbsolute(dir) && !normalize(dir).startsWith(".."),
      `skill dir ${dir} must stay in root`,
    );
    assert.ok(existsSync(join(root, dir)), `skill dir ${dir} must exist`);
    assert.ok(existsSync(join(root, dir, "SKILL.md")), `skill ${dir} must contain SKILL.md`);
    assert.ok(
      pkg.files.some(
        (f) => normalize(dir) === normalize(f) || normalize(dir).startsWith(`${normalize(f)}/`),
      ),
      `skill dir ${dir} must be in package files`,
    );
  }
});

test("cancellation revokes the binding so later tool calls fail closed; runtime cancel is not assumed", async () => {
  let release;
  const { api, hooks } = fakeApi(
    { enabled: true, agentId: "main" },
    { waitForRun: () => new Promise((r) => (release = r)) },
  );
  plugin.register(api);
  const { guard, dispatchTask } = getOrchestration(api);
  assert.equal(typeof api.runtime.subagent.cancelRun, "undefined");
  const ac = new AbortController();
  const p = dispatchTask(task(), { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(guard.size, 1);
  ac.abort("stop");
  await assert.rejects(p, { name: "AbortError" });
  assert.equal(guard.size, 0);
  release({ status: "ok" });
  // The still-running worker's tool calls are now terminal blocks.
  const late = await hooks[0][1](
    { toolName: "read", runId: "run-1" },
    { sessionKey: "agent:main:subagent:oca-late" },
  );
  assert.equal(late.block, true);
});
