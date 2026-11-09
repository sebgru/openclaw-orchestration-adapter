import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(root, "skills/orchestration-2.0/SKILL.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));

test("manifest exposes the orchestration-2.0 skill", () => {
  assert.ok(manifest.skills.includes("skills/orchestration-2.0"));
});

test("skill frontmatter names the skill and has a description", () => {
  const m = /^---\nname: orchestration-2\.0\ndescription: "(.+)"\n---\n/.exec(skill);
  assert.ok(m, "frontmatter must match");
  assert.ok(m[1].length > 20);
});

test("skill carries every machine-testable acceptance cue", () => {
  for (const cue of [
    "STANDARD_SPAWN", "ADAPTER_EXCEPTION", "TASK_STATE", "BRIEF", "ROUTE_RECORD",
    "LIFECYCLE", "VERIFY", "AUTO_PROGRESS", "DASHBOARD_SYNC", "OWNER_SUMMARY",
    "HUMAN_GATE", "CENTRAL_DISPATCH", "DENIAL_VISIBLE",
  ]) {
    assert.ok(skill.includes(`[CUE:${cue}]`), `missing cue ${cue}`);
  }
});

test("skill uses sessions_spawn and treats adapter dispatch as an exception", () => {
  assert.match(skill, /sessions_spawn/);
  assert.match(skill, /explicit exception/);
  assert.match(skill, /never the default/);
  assert.match(skill, /Do not use `orchestration_dispatch`/);
});

test("skill orders dashboard sync before completion and stops at human gates", () => {
  assert.match(skill, /only then report the task complete/);
  assert.match(skill, /PR review\/merge/);
  assert.match(skill, /Gateway restart/);
});
