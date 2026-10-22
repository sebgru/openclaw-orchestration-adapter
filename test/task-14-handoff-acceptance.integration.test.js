import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ToolGuard,
  createBoundWorker,
  createPlan,
  dispatchReadyBatch,
  loadTaskHandoff,
  persistTaskHandoff,
  transitionTask,
} from "../src/index.js";

// Local, fake-host acceptance tests for tracker Tasks 14.3-14.5. Nothing here
// proves live Gateway behavior; the subagent runtime is an in-memory fake.

const SCOPE = { tenantId: "tenant-a", channel: "webchat", conversationId: "chat-7" };
const WRITTEN_AT = "2026-10-09T10:00:00.000Z";
const handoff = {
  title: "Paused acceptance work",
  objective: "Resume the approved adapter task",
  status: "in_progress",
  scope: SCOPE,
  nextAction: "Re-verify current state before continuing",
  owner: "main agent",
  writtenAt: WRITTEN_AT,
};

async function tempWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-14-acceptance-"));
  await mkdir(path.join(root, "memory", "handoffs"), { recursive: true });
  return root;
}

function contract(id, maxRetries) {
  return {
    contractVersion: 1,
    id,
    goal: `Complete ${id}`,
    successCriteria: ["verified"],
    allowedTools: ["read"],
    prohibitedActions: ["write", "external-send"],
    routeTier: "standard",
    budget: { maxCalls: 2, maxTokens: 1000, timeoutMs: 20, maxRetries },
    scope: SCOPE,
    outputSchema: { type: "object" },
  };
}

// ---- 14.3: retry classification and caps -------------------------------

test("14.3 only dispatch-enforced infrastructure timeouts are retryable, and only up to maxRetries", async () => {
  const plan = createPlan([contract("t", 1)]);
  const hang = () => new Promise(() => {});
  const opts = {
    worker: hang,
    resolveModel: () => "example/m",
    verify: async () => ({ ok: true }),
  };

  const first = await dispatchReadyBatch(plan, opts);
  assert.equal(first.dispatched[0].error.name, "TimeoutError");
  assert.equal(plan.tasks.get("t").state, "failed");
  assert.equal(plan.tasks.get("t").retryable, true);

  transitionTask(plan, "t", "ready"); // retry 1 of 1
  assert.equal(plan.tasks.get("t").retries, 1);
  transitionTask(plan, "t", "running");
  transitionTask(plan, "t", "failed", { reason: "TimeoutError", retryable: true });
  assert.throws(() => transitionTask(plan, "t", "ready"), /exhausted its retry budget \(1\)/);
});

test("14.3 worker errors and verifier rejections are never retryable, even with budget left", async () => {
  const boom = createPlan([contract("w", 1)]);
  await dispatchReadyBatch(boom, {
    worker: async () => {
      throw Object.assign(new Error("worker said so"), { retryable: true }); // self-declared, unclassified
    },
    resolveModel: () => "example/m",
    verify: async () => ({ ok: true }),
  });
  assert.equal(boom.tasks.get("w").state, "failed");
  assert.equal(boom.tasks.get("w").retryable, false);
  assert.throws(() => transitionTask(boom, "w", "ready"), /cannot be retried/);

  const rejected = createPlan([contract("v", 1)]);
  await dispatchReadyBatch(rejected, {
    worker: async () => ({}),
    resolveModel: () => "example/m",
    verify: async () => ({ ok: false }),
  });
  assert.equal(rejected.tasks.get("v").retryable, false);
  assert.throws(() => transitionTask(rejected, "v", "ready"), /cannot be retried/);
});

test("14.3 maxRetries 0 allows no retry after an infrastructure timeout", async () => {
  const plan = createPlan([contract("z", 0)]);
  await dispatchReadyBatch(plan, {
    worker: () => new Promise(() => {}),
    resolveModel: () => "example/m",
    verify: async () => ({ ok: true }),
  });
  assert.equal(plan.tasks.get("z").retryable, true);
  assert.throws(() => transitionTask(plan, "z", "ready"), /exhausted its retry budget \(0\)/);
});

// ---- 14.5: persistence, permissions, no-overwrite, scope, staleness ----

test("14.5 persists with 0600 mode, unique names, no overwrite, and no stray writes", async () => {
  const root = await tempWorkspace();
  try {
    const a = await persistTaskHandoff(handoff, { workspaceRoot: root });
    const b = await persistTaskHandoff(handoff, { workspaceRoot: root });
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.relativePath, b.relativePath);

    const files = await readdir(path.join(root, "memory", "handoffs"));
    assert.equal(files.length, 2);
    for (const rel of [a.relativePath, b.relativePath]) {
      assert.equal((await stat(path.join(root, rel))).mode & 0o777, 0o600);
    }
    assert.deepEqual((await readdir(root)).sort(), ["memory"]);
    assert.deepEqual(await readdir(path.join(root, "memory")), ["handoffs"]);

    // The contents of an existing handoff are untouched by later writes.
    const before = await readFile(path.join(root, a.relativePath), "utf8");
    await persistTaskHandoff({ ...handoff, objective: "Different" }, { workspaceRoot: root });
    assert.equal(await readFile(path.join(root, a.relativePath), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("14.5 never creates memory/handoffs and refuses to write when it is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-14-acceptance-"));
  try {
    await assert.rejects(
      persistTaskHandoff(handoff, { workspaceRoot: root }),
      /existing non-symlink/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("14.5 survives a simulated restart and enforces scope and staleness on load", async () => {
  const root = await tempWorkspace();
  try {
    const saved = await persistTaskHandoff(handoff, { workspaceRoot: root });

    // Simulated restart: a freshly evaluated copy of the modules shares no
    // in-memory state with the writer; only the file on disk carries over.
    const restarted = await import(`../src/handoff-store.js?restart=${Date.now()}`);
    assert.notEqual(restarted.loadTaskHandoff, loadTaskHandoff);

    const fresh = await restarted.loadTaskHandoff(
      { id: saved.id, scope: SCOPE },
      { workspaceRoot: root, now: "2026-10-09T12:00:00.000Z" },
    );
    assert.equal(fresh.status, "in_progress");
    assert.equal(fresh.requiresConfirmation, false);
    assert.equal(fresh.contentIsUntrusted, true);
    assert.match(fresh.markdown, /Re-verify current state/);

    const stale = await restarted.loadTaskHandoff(
      { id: saved.id, scope: SCOPE },
      { workspaceRoot: root, now: "2026-10-11T10:00:00.000Z" },
    );
    assert.equal(stale.requiresConfirmation, true);
    assert.equal(stale.ageMs, 48 * 60 * 60 * 1000);

    for (const field of ["tenantId", "channel", "conversationId"]) {
      await assert.rejects(
        loadTaskHandoff(
          { id: saved.id, scope: { ...SCOPE, [field]: "other" } },
          { workspaceRoot: root, now: "2026-10-09T12:00:00.000Z" },
        ),
        /not found for this scope/,
      );
    }
    await assert.rejects(
      loadTaskHandoff(
        { id: saved.id, scope: SCOPE },
        { workspaceRoot: root, now: "2026-10-08T10:00:00.000Z" },
      ),
      /in the future/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("14.5 rejects tampered bodies and oversize files", async () => {
  const root = await tempWorkspace();
  try {
    const saved = await persistTaskHandoff(handoff, { workspaceRoot: root });
    const file = path.join(root, saved.relativePath);
    const original = await readFile(file, "utf8");
    const now = "2026-10-09T12:00:00.000Z";

    await chmod(file, 0o600);
    await writeFile(file, original.replace("Status: in_progress", "Status: blocked"));
    await assert.rejects(
      loadTaskHandoff({ id: saved.id, scope: SCOPE }, { workspaceRoot: root, now }),
      /does not match its scope metadata/,
    );

    await writeFile(file, original);
    await assert.rejects(
      loadTaskHandoff({ id: saved.id, scope: SCOPE }, { workspaceRoot: root, now, maxBytes: 50 }),
      /read limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- 14.4 (read-only assessment): revocation vs. host-run cancellation --

test("14.4 abort revokes authority (fail closed) but the fake host run is never cancelled", async () => {
  const guard = new ToolGuard();
  const methods = [];
  let sessionKey;
  const subagent = {
    async run(a) {
      methods.push("run");
      sessionKey = a.sessionKey;
      return { runId: "run-1", sessionKey };
    },
    waitForRun: () => new Promise(() => {}), // run "keeps going"
    async getSessionMessages() {
      return { messages: [] };
    },
    async deleteSession() {
      methods.push("deleteSession");
    },
  };
  for (const name of Object.keys(subagent)) {
    const original = subagent[name];
    if (name !== "run") {
      subagent[name] = (...args) => (methods.push(name), original(...args));
    }
  }
  const ac = new AbortController();
  const worker = createBoundWorker({ subagent, guard, agentId: "main" });
  const task = {
    ...contract("c", 0),
    budget: { maxCalls: 2, maxTokens: 1000, timeoutMs: 5000, maxRetries: 0 },
  };
  const grant = { mode: "tools", allowedTools: ["read"], budget: task.budget };
  const running = worker({ task, grant, model: "example/m", signal: ac.signal });
  running.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(guard.check({ sessionKey, runId: "run-1", toolName: "read" }), {});
  ac.abort("stop");
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(guard.size, 0, "binding revoked");
  assert.equal(guard.check({ sessionKey, runId: "run-1", toolName: "read" }).block, true);
  // The public subagent surface used has no cancel/abort call; none was invoked.
  assert.ok(!methods.some((m) => /cancel|abort|stop/i.test(m)), `methods: ${methods}`);
  assert.ok(methods.includes("waitForRun"), "host wait was still outstanding");
});

test("14.4b abort deletes the worker session once even if waitForRun never settles; delete failure is swallowed", async () => {
  for (const failDelete of [false, true]) {
    const guard = new ToolGuard();
    const deleted = [];
    let sessionKey;
    const subagent = {
      async run(a) {
        sessionKey = a.sessionKey;
        return { runId: "run-1", sessionKey };
      },
      waitForRun: () => new Promise(() => {}),
      async getSessionMessages() {
        return { messages: [] };
      },
      async deleteSession(a) {
        deleted.push(a.sessionKey);
        if (failDelete) throw new Error("host refused");
      },
    };
    const ac = new AbortController();
    const worker = createBoundWorker({ subagent, guard, agentId: "main" });
    const task = {
      ...contract("c", 0),
      budget: { maxCalls: 2, maxTokens: 1000, timeoutMs: 5000, maxRetries: 0 },
    };
    const grant = { mode: "tools", allowedTools: ["read"], budget: task.budget };
    worker({ task, grant, model: "example/m", signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    ac.abort("stop");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(guard.size, 0);
    assert.deepEqual(deleted, [sessionKey]);
  }
});

test("14.4c abort during run() admission defers deleteSession until admission completes, exactly once", async () => {
  const guard = new ToolGuard();
  const events = [];
  let sessionKey;
  let admit;
  let runStarted;
  const started = new Promise((r) => (runStarted = r));
  let deleteCalled;
  const deleteSeen = new Promise((r) => (deleteCalled = r));
  const subagent = {
    run(a) {
      sessionKey = a.sessionKey;
      events.push("run_called");
      runStarted();
      return new Promise((resolve) => {
        admit = () => {
          events.push("run_resolved");
          resolve({ runId: "run-1", sessionKey });
        };
      });
    },
    waitForRun: () => new Promise(() => {}),
    async getSessionMessages() {
      return { messages: [] };
    },
    async deleteSession(a) {
      events.push(`delete:${a.sessionKey}`);
      deleteCalled();
    },
  };
  const ac = new AbortController();
  const worker = createBoundWorker({ subagent, guard, agentId: "main" });
  const task = {
    ...contract("c", 0),
    budget: { maxCalls: 2, maxTokens: 1000, timeoutMs: 5000, maxRetries: 0 },
  };
  const grant = { mode: "tools", allowedTools: ["read"], budget: task.budget };
  worker({ task, grant, model: "example/m", signal: ac.signal }).catch(() => {});
  await started;
  ac.abort("stop");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["run_called"], "no delete while admission is pending");
  assert.equal(guard.size, 0, "binding already revoked (fail closed)");

  admit();
  await deleteSeen;
  assert.deepEqual(events, ["run_called", "run_resolved", `delete:${sessionKey}`]);
  // Flush the finally block (if any) and confirm no second delete is issued.
  await new Promise((r) => setImmediate(r));
  assert.equal(events.filter((e) => e.startsWith("delete:")).length, 1);
});
