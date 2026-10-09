import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistTaskHandoff } from "../src/index.js";

const input = {
  title: "Paused integration work",
  objective: "Implement the approved adapter integration",
  status: "blocked",
  scope: { tenantId: "tenant-a", channel: "webchat", conversationId: "chat-7" },
  decisions: [{ text: "Use only the public receipt contract" }],
  openQuestions: ["Runtime call path still needs proof"],
  steps: [{ status: "done", task: "Confirm API shape", evidence: "contract tests" }],
  nextAction: "Verify the supported runtime call path",
  owner: "main agent",
  approvalsNeeded: ["Review before merge"],
  modelsAndBudgets: ["standard route; usage data unavailable"],
  sources: ["proposal §8"],
  writtenAt: "2026-10-09T10:00:00.000Z",
};

async function workspaceWithHandoffDirectory() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "handoff-store-"));
  await mkdir(path.join(workspaceRoot, "memory", "handoffs"), { recursive: true });
  return workspaceRoot;
}

test("persists a scoped paused handoff as a private, unique file in the existing directory", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  try {
    const saved = await persistTaskHandoff(input, { workspaceRoot });
    assert.match(
      saved.relativePath,
      /^memory\/handoffs\/handoff-2026-10-09-paused-integration-work-[0-9a-f-]+\.md$/,
    );
    assert.equal(saved.status, "blocked");
    const absolutePath = path.join(workspaceRoot, saved.relativePath);
    const content = await readFile(absolutePath, "utf8");
    assert.match(content, /tenant=tenant-a; channel=webchat; conversation=chat-7/);
    assert.match(content, /Verify the supported runtime call path/);
    assert.equal((await stat(absolutePath)).mode & 0o777, 0o600);
    const second = await persistTaskHandoff(input, { workspaceRoot });
    assert.notEqual(saved.relativePath, second.relativePath);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("requires an existing handoff directory and refuses unsafe roots and symlinked paths", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "handoff-store-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "handoff-outside-"));
  try {
    await assert.rejects(
      persistTaskHandoff(input, { workspaceRoot }),
      /existing non-symlink directory/,
    );
    await mkdir(path.join(workspaceRoot, "memory"));
    await symlink(outside, path.join(workspaceRoot, "memory", "handoffs"));
    await assert.rejects(persistTaskHandoff(input, { workspaceRoot }), /non-symlink directory/);
    await assert.rejects(persistTaskHandoff(input, { workspaceRoot: "relative" }), /absolute path/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("only persists paused tasks with conversation scope", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  try {
    await assert.rejects(
      persistTaskHandoff({ ...input, status: "completed" }, { workspaceRoot }),
      /only in_progress or blocked/,
    );
    await assert.rejects(
      persistTaskHandoff({ ...input, scope: undefined }, { workspaceRoot }),
      /requires tenant, channel, and conversation scope/,
    );
    await assert.rejects(
      persistTaskHandoff({ ...input, scope: { tenantId: "tenant-a" } }, { workspaceRoot }),
      /scope\.channel/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects non-object handoff input before touching the workspace", async () => {
  for (const malformed of [null, "handoff", []]) {
    await assert.rejects(persistTaskHandoff(malformed), /handoff must be an object/);
  }
});

test(
  "surfaces unexpected filesystem errors while resolving the handoff directory",
  { skip: typeof process.getuid === "function" && process.getuid() === 0 },
  async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "handoff-store-"));
    const memory = path.join(workspaceRoot, "memory");
    try {
      await mkdir(path.join(memory, "handoffs"), { recursive: true });
      await chmod(memory, 0o000);
      await assert.rejects(
        persistTaskHandoff(input, { workspaceRoot }),
        (error) => error.code === "EACCES",
      );
    } finally {
      await chmod(memory, 0o700);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);
