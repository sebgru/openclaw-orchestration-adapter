import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTaskHandoff, persistTaskHandoff, renderTaskHandoff } from "../src/index.js";

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

function metadataHeader(metadata) {
  return `<!-- openclaw-handoff:v1:${Buffer.from(JSON.stringify(metadata)).toString("base64url")} -->`;
}

test("persists a scoped paused handoff as a private, unique file in the existing directory", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  try {
    const saved = await persistTaskHandoff(input, { workspaceRoot });
    assert.match(
      saved.relativePath,
      /^memory\/handoffs\/handoff-2026-10-09-paused-integration-work-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/,
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

test("loads only an exact-scope handoff and flags stale records for confirmation", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  try {
    const saved = await persistTaskHandoff(input, { workspaceRoot });
    const fresh = await loadTaskHandoff(
      { id: saved.id, scope: input.scope },
      { workspaceRoot, now: "2026-10-09T10:05:00.000Z" },
    );
    assert.equal(fresh.status, "blocked");
    assert.equal(fresh.ageMs, 5 * 60 * 1000);
    assert.equal(fresh.requiresConfirmation, false);
    assert.equal(fresh.contentIsUntrusted, true);
    assert.match(fresh.markdown, /Verify the supported runtime call path/);

    const stale = await loadTaskHandoff(
      { id: saved.id, scope: input.scope },
      { workspaceRoot, now: "2026-10-10T10:00:00.001Z" },
    );
    assert.equal(stale.requiresConfirmation, true);
    const boundary = await loadTaskHandoff(
      { id: saved.id, scope: input.scope },
      { workspaceRoot, now: "2026-10-10T10:00:00.000Z" },
    );
    assert.equal(boundary.requiresConfirmation, false);

    for (const scope of [
      { ...input.scope, tenantId: "other-tenant" },
      { ...input.scope, channel: "telegram" },
      { ...input.scope, conversationId: "other-chat" },
    ]) {
      await assert.rejects(
        loadTaskHandoff({ id: saved.id, scope }, { workspaceRoot }),
        /not found for this scope/,
      );
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects invalid IDs, stale-policy bounds, future records, and oversized files", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  try {
    await assert.rejects(
      loadTaskHandoff({ id: "../handoff.md", scope: input.scope }, { workspaceRoot }),
      /id must be a handoff UUID/,
    );
    const saved = await persistTaskHandoff(input, { workspaceRoot });
    await assert.rejects(
      loadTaskHandoff({ id: saved.id, scope: input.scope }, { workspaceRoot, staleAfterMs: 0 }),
      /staleAfterMs must be a positive integer/,
    );
    await assert.rejects(
      loadTaskHandoff({ id: saved.id, scope: input.scope }, { workspaceRoot, maxBytes: 28_001 }),
      /maxBytes must be an integer/,
    );
    await assert.rejects(
      loadTaskHandoff({ id: saved.id, scope: input.scope }, { workspaceRoot, now: "bad" }),
      /now must be a parseable timestamp/,
    );
    await assert.rejects(
      loadTaskHandoff({ id: saved.id, scope: input.scope }, { workspaceRoot, maxBytes: 5 }),
      /handoff exceeds the read limit/,
    );
    await assert.rejects(
      loadTaskHandoff(
        { id: saved.id, scope: input.scope },
        {
          workspaceRoot,
          now: "2026-10-08T10:00:00.000Z",
        },
      ),
      /invalid or in the future/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("refuses an exact-ID handoff symlink", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  const outside = await mkdtemp(path.join(os.tmpdir(), "handoff-outside-"));
  const id = "00000000-0000-4000-8000-000000000000";
  try {
    const outsideFile = path.join(outside, "outside.md");
    await writeFile(outsideFile, "private data");
    await symlink(outsideFile, path.join(workspaceRoot, "memory", "handoffs", `handoff-${id}.md`));
    await assert.rejects(
      loadTaskHandoff({ id, scope: input.scope }, { workspaceRoot }),
      /not found for this scope/,
    );
    assert.equal(await readFile(outsideFile, "utf8"), "private data");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("reads compatible v1.4 handoffs that predate the metadata header", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  const id = "00000000-0000-4000-8000-000000000000";
  const filename =
    "handoff-2026-10-09-paused-integration-work-00000000-0000-4000-8000-000000000000.md";
  try {
    await writeFile(
      path.join(workspaceRoot, "memory", "handoffs", filename),
      renderTaskHandoff(input),
      { mode: 0o600 },
    );
    const loaded = await loadTaskHandoff(
      { id, scope: input.scope },
      { workspaceRoot, now: "2026-10-09T10:05:00.000Z" },
    );
    assert.equal(loaded.id, id);
    assert.equal(loaded.requiresConfirmation, false);
    assert.match(loaded.markdown, /Verify the supported runtime call path/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects a non-object handoff scope before touching the workspace", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const scope of [undefined, null, "tenant-a", 42, ["tenant-a"]]) {
    await assert.rejects(
      loadTaskHandoff({ id, scope }),
      /scope must include tenantId, channel, and conversationId/,
    );
  }
});

test("rejects stored handoffs with malformed or unsupported metadata", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  const cases = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      header: `<!-- openclaw-handoff:v1:${Buffer.from("not json").toString("base64url")} -->`,
    },
    { id: "33333333-3333-4333-8333-333333333333", metadata: null },
    { id: "44444444-4444-4444-8444-444444444444", metadata: {} },
    {
      id: "55555555-5555-4555-8555-555555555555",
      metadata: {
        version: 2,
        id: "55555555-5555-4555-8555-555555555555",
        status: "blocked",
        writtenAt: "2026-10-09T10:00:00.000Z",
        scope: input.scope,
      },
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      metadata: {
        version: 1,
        id: "not-a-uuid",
        status: "blocked",
        writtenAt: "2026-10-09T10:00:00.000Z",
        scope: input.scope,
      },
    },
    {
      id: "77777777-7777-4777-8777-777777777777",
      metadata: {
        version: 1,
        id: "77777777-7777-4777-8777-777777777777",
        status: "done",
        writtenAt: "2026-10-09T10:00:00.000Z",
        scope: input.scope,
      },
    },
    {
      id: "88888888-8888-4888-8888-888888888888",
      metadata: {
        version: 1,
        id: "88888888-8888-4888-8888-888888888888",
        status: "blocked",
        writtenAt: 12_345,
        scope: input.scope,
      },
    },
  ];
  try {
    for (const { id, header, metadata } of cases) {
      await writeFile(
        path.join(workspaceRoot, "memory", "handoffs", `handoff-2026-10-09-x-${id}.md`),
        `${header ?? metadataHeader(metadata)}\n\nbody\n`,
        { mode: 0o600 },
      );
      await assert.rejects(
        loadTaskHandoff({ id, scope: input.scope }, { workspaceRoot }),
        /handoff metadata is invalid/,
      );
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects a handoff whose body omits its scope metadata", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  const id = "99999999-9999-4999-8999-999999999999";
  try {
    await writeFile(
      path.join(workspaceRoot, "memory", "handoffs", `handoff-2026-10-09-x-${id}.md`),
      `${metadataHeader({
        version: 1,
        id,
        status: "blocked",
        writtenAt: "2026-10-09T10:00:00.000Z",
        scope: input.scope,
      })}\n\nBody without any matching marker lines\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      loadTaskHandoff(
        { id, scope: input.scope },
        { workspaceRoot, now: "2026-10-09T10:05:00.000Z" },
      ),
      /handoff body does not match its scope metadata/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ignores candidate filenames that fall outside the handoff charset", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  try {
    await writeFile(
      path.join(workspaceRoot, "memory", "handoffs", `handoff-EVIL-${id}.md`),
      "private data",
      { mode: 0o600 },
    );
    await assert.rejects(
      loadTaskHandoff({ id, scope: input.scope }, { workspaceRoot }),
      /handoff not found for this scope/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects a handoff whose decoded content exceeds the read limit", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  const id = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
  try {
    await writeFile(
      path.join(workspaceRoot, "memory", "handoffs", `handoff-2026-10-09-x-${id}.md`),
      Buffer.from([0xff, 0xff]),
      { mode: 0o600 },
    );
    await assert.rejects(
      loadTaskHandoff({ id, scope: input.scope }, { workspaceRoot, maxBytes: 5 }),
      /handoff exceeds the read limit/,
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

test("rejects a handoff whose writtenAt cannot produce a valid file date", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  try {
    for (const writtenAt of ["not-a-date", "2026-13-45T00:00:00.000Z", 20_261_009]) {
      await assert.rejects(
        persistTaskHandoff({ ...input, writtenAt }, { workspaceRoot }),
        /writtenAt must begin with a valid ISO date/,
      );
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("uses only a generated UUID in the persisted filename", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  try {
    const saved = await persistTaskHandoff({ ...input, title: "!!!" }, { workspaceRoot });
    assert.match(
      saved.relativePath,
      /^memory\/handoffs\/handoff-2026-10-09-paused-task-[0-9a-f-]{36}\.md$/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("stamps the current time when writtenAt is omitted", async () => {
  const workspaceRoot = await workspaceWithHandoffDirectory();
  try {
    const saved = await persistTaskHandoff({ ...input, writtenAt: undefined }, { workspaceRoot });
    assert.match(saved.writtenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(
      saved.relativePath,
      new RegExp(
        `^memory/handoffs/handoff-${saved.writtenAt.slice(0, 10)}-paused-integration-work-${saved.id}\\.md$`,
      ),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects a workspace root that is not a directory", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "handoff-store-"));
  const file = path.join(workspaceRoot, "not-a-directory");
  try {
    await writeFile(file, "not a directory");
    await assert.rejects(
      persistTaskHandoff(input, { workspaceRoot: file }),
      /workspaceRoot must be a directory/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
