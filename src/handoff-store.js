import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renderTaskHandoff } from "./handoff.js";

const HANDOFF_DIRECTORY = path.join("memory", "handoffs");

function slug(value) {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return result || "paused-task";
}

async function requireDirectoryWithoutSymlinks(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw new TypeError("workspaceRoot must be an absolute path");
  }
  const root = await realpath(workspaceRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new TypeError("workspaceRoot must be a directory");

  let current = root;
  for (const segment of HANDOFF_DIRECTORY.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new TypeError("memory/handoffs must be an existing non-symlink directory");
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TypeError("memory/handoffs must be an existing non-symlink directory");
    }
    /* c8 ignore next 3 -- realpath can only diverge on case-insensitive filesystems or a TOCTOU race */
    if ((await realpath(current)) !== current) {
      throw new TypeError("memory/handoffs must resolve within workspaceRoot");
    }
  }
  return current;
}

/**
 * Persist an explicitly paused handoff in the existing memory/handoffs folder.
 * This function never creates folders, overwrites files, indexes outputs, or
 * resumes a task. Callers must redact sensitive content before invoking it.
 */
export async function persistTaskHandoff(input, { workspaceRoot, maxChars = 12_000 } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("handoff must be an object");
  }
  if (input.status !== "in_progress" && input.status !== "blocked") {
    throw new TypeError("only in_progress or blocked task handoffs may be persisted");
  }
  const scope = input.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError("persisted handoff requires tenant, channel, and conversation scope");
  }

  const writtenAt = input.writtenAt ?? new Date().toISOString();
  const date = typeof writtenAt === "string" ? writtenAt.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new TypeError("writtenAt must begin with a valid ISO date");
  }

  const markdown = renderTaskHandoff(input, { maxChars });
  const directory = await requireDirectoryWithoutSymlinks(workspaceRoot);
  const id = randomUUID();
  const filename = `handoff-${date}-${slug(input.title)}-${id}.md`;
  const relativePath = path.posix.join("memory", "handoffs", filename);
  const absolutePath = path.join(directory, filename);
  // O_NOFOLLOW is unavailable on some platforms; fall back to no flag there.
  /* c8 ignore next */
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
  const file = await open(absolutePath, flags, 0o600);
  try {
    await file.writeFile(markdown, { encoding: "utf8" });
    await file.sync();
    /* c8 ignore start -- only reached on write/sync I/O failures such as a full disk */
  } catch (error) {
    await file.close();
    await unlink(absolutePath).catch(() => {});
    throw error;
  }
  /* c8 ignore stop */
  await file.close();
  return { id, relativePath, status: input.status, writtenAt };
}
