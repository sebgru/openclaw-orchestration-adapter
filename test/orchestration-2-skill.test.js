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
    "STANDARD_SPAWN",
    "ADAPTER_EXCEPTION",
    "TASK_STATE",
    "BRIEF",
    "ROUTE_RECORD",
    "LIFECYCLE",
    "VERIFY",
    "AUTO_PROGRESS",
    "DASHBOARD_SYNC",
    "OWNER_SUMMARY",
    "HUMAN_GATE",
    "CENTRAL_DISPATCH",
    "DENIAL_VISIBLE",
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

test("dependent chains use private parent completion turns for no-nudge continuation", () => {
  assert.ok(skill.includes("[CUE:PRIVATE_PARENT_CONTINUATION]"));
  assert.match(skill, /completionTarget: "parent"/);
  assert.match(skill, /call `sessions_yield`/);
  assert.match(skill, /does not itself perform verification or scheduling/);
  assert.match(skill, /docs\/completion-driven-continuation\.md/);
});

test("skill orders dashboard sync before completion and stops at human gates", () => {
  assert.match(skill, /only then report the task complete/);
  assert.match(skill, /PR review\/merge/);
  assert.match(skill, /Gateway restart/);
});

test("standard spawn claims normal policy and requires tool evidence in the brief", () => {
  assert.doesNotMatch(skill, /full ordinary tool set/);
  assert.match(skill, /standard host sub-agent tool restrictions/);
  assert.match(skill, /`required_tools` and `inherited_tool_evidence`/);
  assert.match(skill, /parent's tool catalog alone does not prove/);
  assert.ok(skill.includes("[CUE:TOOL_EVIDENCE]"));
});

test("restrictions are prompt-only and unexpected descendants are detected", () => {
  assert.ok(skill.includes("[CUE:PROMPT_ONLY]"));
  assert.match(skill, /no-recursion restrictions are prompt-only/);
  assert.match(skill, /only the run timeout and normal host policy are host-enforced/);
  assert.ok(skill.includes("[CUE:DESCENDANT_DETECT]"));
  assert.match(skill, /`subagents` list/);
  assert.match(skill, /`subagent_used`/);
  assert.match(skill, /Cancel any unapproved descendant/);
  assert.match(skill, /without independent verification/);
});

test("model/provider confirmation fails closed, while an omitted applied timeout stays unconfirmed", () => {
  assert.ok(skill.includes("[CUE:WORKER_MODEL_CONFIRM]"));
  assert.match(skill, /before any substantive analysis/);
  assert.match(skill, /runtime model identity matches the exact approved model/);
  assert.ok(skill.includes("[CUE:RECEIPT_FAIL_CLOSED]"));
  for (const f of ["resolvedModel", "resolvedProvider", "runId"]) {
    assert.ok(skill.includes(f), `receipt field ${f}`);
  }
  assert.match(skill, /missing, unconfirmable, or mismatched value blocks the attempt/);
  assert.match(skill, /cancel via `subagents` when possible/);
  assert.match(skill, /reject all output/);
  assert.match(skill, /partial side effects/);
  assert.ok(skill.includes("[CUE:TIMEOUT_UNCONFIRMED]"));
  assert.match(skill, /Preserve the requested timeout from the brief/);
  assert.match(
    skill,
    /If it does not echo an applied timeout, record `applied_timeout=unconfirmed`/,
  );
  assert.match(
    skill,
    /this gap alone does not invalidate an otherwise valid worker or model\/provider receipt/,
  );
  assert.match(skill, /a mismatch blocks the attempt/);
  assert.match(skill, /Never claim the requested timeout was receipt-confirmed as applied/);
  assert.ok(skill.includes("[CUE:GATE_DISCLOSURE]"));
  assert.match(skill, /starts the child immediately/);
  assert.match(skill, /not a host-held pre-analysis gate/);
});

test("owner decision gate requires exact ask, reviewable options, and continued independent work", () => {
  assert.ok(skill.includes("[CUE:OWNER_DECISION_GATE]"));
  assert.match(skill, /material unresolved owner choice or a protected action/);
  assert.match(skill, /exact decision or action/);
  assert.match(skill, /reviewable options or an artifact/);
  assert.match(skill, /continue independent authorized work/);
});

test("owner summaries include receipt-confirmed route, remaining state, next action, decision", () => {
  assert.ok(skill.includes("[CUE:SUMMARY_ROUTE]"));
  assert.match(skill, /receipt-confirmed actual worker model\/route/);
  assert.match(skill, /current remaining state/);
  assert.match(skill, /next action, and any owner decision/);
});
