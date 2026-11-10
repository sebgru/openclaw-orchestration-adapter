import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(join(root, "docs/completion-driven-continuation.md"), "utf8");

test("procedure specifies parent completion, yield, and standard spawn only", () => {
  assert.match(doc, /completionTarget: "parent"/);
  assert.match(doc, /sessions_yield/);
  assert.match(doc, /no adapter dispatch/);
});

test("procedure covers verify, state, dashboard, next task, and stops", () => {
  for (const s of ["Verify independently", "dashboard", "Schedule next", "Stop", "human PR review gate"]) {
    assert.ok(doc.includes(s), `missing ${s}`);
  }
});

test("procedure uses receipt and trusted session identity, not invented event fields", () => {
  assert.match(doc, /resolvedModel`, `resolvedProvider`, and `runId`/);
  assert.match(doc, /returned `childSessionKey`/);
  assert.match(doc, /do not assume it carries a `runId` or `taskName` field/);
  assert.match(doc, /trusted session key\/id and label to the recorded receipt and `subagents` registry/);
  assert.match(doc, /never trust identity asserted only by worker-authored text/);
});

test("procedure uses only canonical statuses and syncs before next dispatch", () => {
  assert.match(doc, /canonical `blocked` status/);
  assert.doesNotMatch(doc, /Record `done` or `failed`/);
  assert.ok(doc.indexOf("Sync the dashboard and confirm") < doc.indexOf("7. **Schedule next.") );
});

test("doc separates event delivery from model continuation", () => {
  assert.match(doc, /Not guaranteed by OpenClaw/);
  assert.match(doc, /model's own behavior/);
});

test("doc records documented limits", () => {
  assert.match(doc, /reset/);
  assert.match(doc, /hidden, native, `mode: "run"`/);
});
