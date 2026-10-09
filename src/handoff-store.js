import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renderTaskHandoff } from "./handoff.js";

const HANDOFF_DIRECTORY = path.join("memory", "handoffs");
const HANDOFF_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_STORED_HANDOFF_BYTES = 28_000;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError("scope must include tenantId, channel, and conversationId");
  }
  const normalized = {};
  for (const field of ["tenantId", "channel", "conversationId"]) {
    if (typeof scope[field] !== "string" || !scope[field].trim()) {
      throw new TypeError(`scope.${field} must be a non-empty string`);
    }
    normalized[field] = scope[field]
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2_000);
  }
  return normalized;
}

function metadataLine(metadata) {
  return `<!-- openclaw-handoff:v1:${Buffer.from(JSON.stringify(metadata)).toString("base64url")} -->`;
}

function slug(value) {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return result || "paused-task";
}

function readMetadata(markdown) {
  const newline = markdown.indexOf("\n");
  if (newline < 0) throw new TypeError("handoff metadata is missing");
  const line = markdown.slice(0, newline).trimEnd();
  const match = /^<!-- openclaw-handoff:v1:([A-Za-z0-9_-]+) -->$/.exec(line);
  if (!match) throw new TypeError("handoff metadata is invalid or unsupported");
  let metadata;
  try {
    metadata = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    throw new TypeError("handoff metadata is invalid");
  }
  if (
    !metadata ||
    metadata.version !== 1 ||
    !HANDOFF_ID.test(metadata.id) ||
    !["in_progress", "blocked"].includes(metadata.status) ||
    typeof metadata.writtenAt !== "string"
  ) {
    throw new TypeError("handoff metadata is invalid");
  }
  return { metadata, body: markdown.slice(newline + 1).replace(/^\s+/, "") };
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

  const normalizedScope = normalizeScope(scope);
  const body = renderTaskHandoff({ ...input, scope: normalizedScope }, { maxChars });
  const directory = await requireDirectoryWithoutSymlinks(workspaceRoot);
  const id = randomUUID();
  const filename = `handoff-${date}-${slug(input.title)}-${id}.md`;
  const relativePath = path.posix.join("memory", "handoffs", filename);
  const absolutePath = path.join(directory, filename);
  const metadata = { version: 1, id, status: input.status, writtenAt, scope: normalizedScope };
  const markdown = `${metadataLine(metadata)}\n\n${body}`;
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

/**
 * Load one bounded handoff only when all supplied scope keys match. Scope is a
 * lookup filter, not authentication; callers must derive it from trusted host
 * identity. Stale records are returned with a confirmation flag, never resumed.
 */
export async function loadTaskHandoff(
  { id, scope } = {},
  {
    workspaceRoot,
    now = new Date().toISOString(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    maxBytes = MAX_STORED_HANDOFF_BYTES,
  } = {},
) {
  if (typeof id !== "string" || !HANDOFF_ID.test(id)) {
    throw new TypeError("id must be a handoff UUID");
  }
  const expectedScope = normalizeScope(scope);
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new RangeError("staleAfterMs must be a positive integer");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STORED_HANDOFF_BYTES) {
    throw new RangeError(`maxBytes must be an integer from 1 to ${MAX_STORED_HANDOFF_BYTES}`);
  }
  if (typeof now !== "string" || Number.isNaN(Date.parse(now))) {
    throw new TypeError("now must be a parseable timestamp");
  }

  const directory = await requireDirectoryWithoutSymlinks(workspaceRoot);
  const candidates = (await readdir(directory)).filter(
    (name) => name === `handoff-${id}.md` || name.endsWith(`-${id}.md`),
  );
  if (candidates.length !== 1) throw new Error("handoff not found for this scope");
  const filename = candidates[0];
  if (!/^handoff-[a-z0-9-]+\.md$/.test(filename)) {
    throw new Error("handoff not found for this scope");
  }
  const absolutePath = path.join(directory, filename);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let file;
  try {
    const pathInfo = await lstat(absolutePath);
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new Error("handoff not found for this scope");
    }
    if (pathInfo.size > maxBytes) throw new RangeError("handoff exceeds the read limit");
    file = await open(absolutePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ELOOP") {
      throw new Error("handoff not found for this scope");
    }
    throw error;
  }
  let markdown;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new RangeError("handoff exceeds the read limit");
    markdown = await file.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(markdown, "utf8") > maxBytes) {
      throw new RangeError("handoff exceeds the read limit");
    }
  } finally {
    await file.close();
  }
  let metadata;
  let body;
  if (markdown.startsWith("<!-- openclaw-handoff:")) {
    ({ metadata, body } = readMetadata(markdown));
  } else {
    // Compatibility with the v1.4 writer, which stored scope in readable lines.
    const lines = markdown.split(/\r?\n/);
    const writtenAt = lines.find((line) => line.startsWith("Written: "))?.slice(9);
    const status = lines.find((line) => line.startsWith("Status: "))?.slice(8);
    metadata = { id, status, writtenAt, scope: expectedScope };
    body = markdown;
  }
  if (
    metadata.id !== id ||
    metadata.scope?.tenantId !== expectedScope.tenantId ||
    metadata.scope?.channel !== expectedScope.channel ||
    metadata.scope?.conversationId !== expectedScope.conversationId
  ) {
    throw new Error("handoff not found for this scope");
  }
  const bodyLines = body.split(/\r?\n/);
  const scopeLine = `Scope: tenant=${expectedScope.tenantId}; channel=${expectedScope.channel}; conversation=${expectedScope.conversationId}`;
  if (
    !bodyLines.includes(`Written: ${metadata.writtenAt}`) ||
    !bodyLines.includes(`Status: ${metadata.status}`) ||
    !bodyLines.includes(scopeLine)
  ) {
    throw new TypeError("handoff body does not match its scope metadata");
  }
  const nowMs = Date.parse(now);
  const writtenAtMs = Date.parse(metadata.writtenAt);
  if (Number.isNaN(writtenAtMs) || writtenAtMs > nowMs) {
    throw new TypeError("handoff timestamp is invalid or in the future");
  }
  const ageMs = nowMs - writtenAtMs;
  return {
    id,
    status: metadata.status,
    writtenAt: metadata.writtenAt,
    ageMs,
    requiresConfirmation: ageMs > staleAfterMs,
    scope: expectedScope,
    markdown: body,
    contentIsUntrusted: true,
  };
}
