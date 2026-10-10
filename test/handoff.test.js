import test from "node:test";
import assert from "node:assert/strict";
import { renderTaskHandoff } from "../src/index.js";

const handoff = {
  title: "Search contract migration",
  writtenAt: "2026-10-08T21:00:00.000Z",
  status: "blocked",
  objective: "Complete the bounded migration and verify it independently.",
  decisions: [
    {
      text: "Keep dispatch disabled until the runtime gate passes.",
      approvedBy: "the owner",
      approvedAt: "2026-10-05",
    },
  ],
  openQuestions: ["Can the host expose provider usage for each run?"],
  steps: [
    { status: "done", task: "Add the versioned task contract", evidence: "src/contracts.js" },
    { status: "blocked", task: "Prove runtime usage accounting" },
    { status: "pending", task: "Prepare a bounded canary" },
  ],
  nextAction: "Verify the supported usage event API before implementing token enforcement.",
  owner: "Main agent",
  approvalsNeeded: ["the owner review before activation"],
  modelsAndBudgets: ["example/model-fast; maxTokens 8000; observed usage unavailable"],
  sources: ["memory/handoffs/superpowers-memory-adapter-orchestration-proposal.md §8"],
};

test("renders a complete, fixed-section handoff with evidence and provenance", () => {
  const markdown = renderTaskHandoff(handoff);
  assert.match(markdown, /^# Search contract migration/m);
  assert.match(markdown, /Written: 2026-10-08T21:00:00\.000Z/);
  assert.match(markdown, /Status: blocked/);
  assert.match(markdown, /approved by the owner, 2026-10-05/);
  assert.match(markdown, /done — Add the versioned task contract; evidence: src\/contracts\.js/);
  assert.match(markdown, /Approvals still needed[\s\S]*the owner review before activation/);
  assert.match(markdown, /Treat this handoff as evidence to re-verify/);
});

test("uses explicit empty markers and sanitizes controls and multiline field injection", () => {
  const markdown = renderTaskHandoff({
    ...handoff,
    decisions: [],
    openQuestions: [],
    steps: [],
    approvalsNeeded: [],
    modelsAndBudgets: [],
    sources: [],
    nextAction: "Continue\n## Forged section\u0000 later",
  });
  assert.equal((markdown.match(/^## Forged section$/gm) ?? []).length, 0);
  assert.match(markdown, /Decisions made\n- None recorded\./);
  assert.match(markdown, /Next action\nContinue ## Forged section later/);
});

test("rejects invalid states, missing fields, excessive lists, and oversize output", () => {
  assert.throws(() => renderTaskHandoff({ ...handoff, status: "unknown" }), /status must be/);
  assert.throws(() => renderTaskHandoff({ ...handoff, nextAction: " " }), /nextAction/);
  assert.throws(
    () =>
      renderTaskHandoff({
        ...handoff,
        steps: Array(41).fill({ status: "pending", task: "x" }),
      }),
    /exceeds 40/,
  );
  assert.throws(() => renderTaskHandoff(handoff, { maxChars: 100 }), /exceeds 100 characters/);
});

test("requires evidence-step status and a parseable write timestamp", () => {
  assert.throws(() => renderTaskHandoff({ ...handoff, writtenAt: "not-a-date" }), /ISO-compatible/);
  assert.throws(
    () => renderTaskHandoff({ ...handoff, steps: [{ status: "done-ish", task: "x" }] }),
    /status must be done/,
  );
});

test("rejects non-object input, invalid maxChars bounds, and malformed list items", () => {
  assert.throws(() => renderTaskHandoff(null), /handoff must be an object/);
  assert.throws(() => renderTaskHandoff("handoff"), /handoff must be an object/);
  assert.throws(() => renderTaskHandoff([]), /handoff must be an object/);

  for (const maxChars of [1.5, 0, -1, 24_001]) {
    assert.throws(() => renderTaskHandoff(handoff, { maxChars }), /maxChars must be an integer/);
  }

  for (const malformed of [null, "nope", []]) {
    assert.throws(
      () => renderTaskHandoff({ ...handoff, decisions: [malformed] }),
      /decisions\[0\] must be an object/,
    );
    assert.throws(
      () => renderTaskHandoff({ ...handoff, steps: [malformed] }),
      /steps\[0\] must be an object/,
    );
  }
});

test("formats minimal handoffs with a default timestamp and omitted lists", () => {
  const markdown = renderTaskHandoff({
    title: "Minimal handoff",
    status: "in_progress",
    objective: "Keep the door open for the next reader.",
    decisions: [{ text: "Proceed with the plan." }],
    nextAction: "Resume from the cited sources.",
    owner: "Main agent",
  });

  assert.match(markdown, /Written: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.match(markdown, /Decisions made\n- Proceed with the plan\.\n/);
  assert.doesNotMatch(markdown, /approved by/);
  assert.match(markdown, /Open questions\n- None recorded\./);
  assert.match(markdown, /Sources and evidence\n- None recorded\./);
});

test("rejects list fields that are present but not arrays", () => {
  assert.throws(
    () => renderTaskHandoff({ ...handoff, decisions: "not-an-array" }),
    /decisions must be an array/,
  );
  assert.throws(() => renderTaskHandoff({ ...handoff, sources: {} }), /sources must be an array/);
});

test("rejects malformed scope while allowing an omitted scope", () => {
  for (const scope of [null, "webchat", []]) {
    assert.throws(() => renderTaskHandoff({ ...handoff, scope }), /scope must be an object/);
  }
  const scoped = renderTaskHandoff({
    ...handoff,
    scope: { tenantId: "tenant-a", channel: "webchat", conversationId: "chat-7" },
  });
  assert.match(scoped, /Scope: tenant=tenant-a; channel=webchat; conversation=chat-7/);
});
