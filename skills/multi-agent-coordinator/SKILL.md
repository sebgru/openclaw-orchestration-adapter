---
name: multi-agent-coordinator
description: "Use when the main session delegates work to one or more subagents and must define their brief, track them, and synthesize their reports. Owns the worker brief and lifecycle."
---

# Multi-Agent Coordinator

The main session coordinates, verifies, and reports. Workers report back through their completion event; they never message Sebastian directly.

1. Write the worker brief. Every worker gets all of:
   - task ID and objective; success criteria that are checkable;
   - scope: inputs, exact write paths/repos, allowed and prohibited actions (including "no push/merge/config/restart/network unless listed");
   - worker tier and the reason for any non-default route, following AGENTS.md → Tools → Local notes and proposal §8; read model IDs from that policy;
   - budget: max tool calls, tokens, wall-clock (only `runTimeoutSeconds` is host-enforced; the rest is advisory);
   - output schema: what to return, plus evidence (commands run, paths, results);
   - provenance rule: cite sources; separate facts from guesses;
   - delegation grant: default "may not delegate" (see `expansion-grant-guard`).
   - Include only the context the worker needs; omit private chat, credentials, and unrelated memory. Memory evidence reaches workers only as bounded excerpts you retrieved yourself.
   - Prompt-only restrictions (prohibited actions, tool lists, call/token caps) are advisory unless the host enforces them; say which are which.
   - **Done when:** the brief contains each item above.

2. Spawn and register.
   - Use `sessions_spawn` (hidden, `context: "isolated"` only; never `fork` without Sebastian's explicit approval and evidence the worker needs minimum transcript context) with `taskName`, `label`, and `runTimeoutSeconds` set to the wall-clock cap; for several at once follow `dispatching-parallel-agents`.
   - **Done when:** each accepted spawn's run id and completion mode is noted.

3. Await and control.
   - Yield with `sessions_yield` for announcing children; use `subagents` cancel for runaway or out-of-budget workers. Report to Sebastian only essential progress (completion, blocker, owner gate); for work that will outlive the session, write a `task-handoff`.
   - **Done when:** all workers completed, were cancelled, or timed out.

4. Verify and synthesize.
   - Read each report as evidence, check its claims against files/command output yourself, and note disagreements between workers.
   - **Done when:** the final reply states what was done, evidence, models/routes per worker, and unresolved items.
