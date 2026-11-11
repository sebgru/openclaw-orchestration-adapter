import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/phase51-completion-chain.json", import.meta.url), "utf8"),
);

test("tasks are ordered T1 implement, T2 verify-test, T3 independent-review", () => {
  assert.deepEqual(
    fixture.tasks.map((t) => t.id),
    ["T1", "T2", "T3"],
  );
  assert.deepEqual(
    fixture.tasks.map((t) => t.role),
    ["implement", "verify-test", "independent-review"],
  );
});

test("dependencies form a linear chain", () => {
  const [t1, t2, t3] = fixture.tasks;
  assert.deepEqual(t1.dependsOn, []);
  assert.deepEqual(t2.dependsOn, ["T1"]);
  assert.deepEqual(t3.dependsOn, ["T2"]);
});

test("spawn uses standard sessions_spawn with completionTarget parent", () => {
  assert.equal(fixture.spawn.tool, "sessions_spawn");
  assert.equal(fixture.spawn.kind, "standard");
  assert.equal(fixture.spawn.completionTarget, "parent");
});

test("parent yields and sends zero owner nudges", () => {
  assert.equal(fixture.parent.yieldAfterSpawn, true);
  assert.equal(fixture.parent.yieldTool, "sessions_yield");
  assert.equal(fixture.parent.ownerNudges, 0);
});

test("advancement requires verified state; failure is canonical blocked", () => {
  assert.equal(fixture.parent.advanceOnlyWhenVerified, true);
  assert.equal(fixture.advance.requiredState, "verified");
  assert.equal(fixture.failure.status, "blocked");
});

test("chain stops at human PR review", () => {
  assert.equal(fixture.final.stopAt, "human-pr-review");
  assert.equal(fixture.final.autoMerge, false);
});
