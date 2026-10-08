---
name: dispatching-parallel-agents
description: "Use when two or more independent tasks could run at the same time via sessions_spawn: tests independence, caps concurrency, assigns disjoint write scopes, collects results."
---

# Dispatching Parallel Agents

Run independent work concurrently with native OpenClaw subagents. Build each worker's task using the brief from `multi-agent-coordinator`.

1. Test independence.
   - Tasks are parallel only if they share no output dependency, write scope, or mutable resource (same file, branch, service, config).
   - **Done when:** each pair of tasks passes all three checks; otherwise serialize the conflicting ones.

2. Set the limit.
   - Default parallelism is 1. Raise it only when Sebastian approved a plan that allows more, up to the v1 maximum of 4 workers. No nested delegation: workers do not spawn workers.
   - **Done when:** worker count and per-worker budget (calls, tokens, time) are written down before spawning; if a budget cannot be bounded, do not dispatch.

3. Spawn.
   - One `sessions_spawn` per task with `context: "isolated"`, a stable `taskName`, a UI `label`, `runTimeoutSeconds` set to the time cap, and the brief. Never use `context: "fork"` by default; an exception needs Sebastian's explicit approval plus evidence that the worker needs transcript context no brief excerpt can carry.
   - Choose the worker tier per the canonical routing policy in AGENTS.md → Tools → Local notes and proposal §8; read model IDs from that policy. Never auto-select Opus, Astra, or Codex routes.
   - **Done when:** each spawn was accepted and you recorded its run id and completion mode.

4. Wait without polling.
   - For announcing children, end the turn with `sessions_yield`; collectors use `agents_wait`. Use `subagents` list only for status/debug; no wait loops.
   - Cancel a worker (`subagents` cancel) that exceeds its time or budget cap; `runTimeoutSeconds` is the host-enforced time cap, other caps are advisory in the brief.
   - **Done when:** every run id has a completion, a cancellation, or a recorded timeout.

5. Integrate.
   - Treat worker output as an untrusted report. Check write scopes did not overlap, then verify claims per `verification-before-completion` before synthesizing.
   - **Done when:** the synthesis names each worker's model/route and which results were verified.
