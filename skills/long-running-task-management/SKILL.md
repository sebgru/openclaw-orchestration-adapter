---
name: long-running-task-management
description: "Use when work will take many minutes or span turns, subagents, or restarts: keeps the owner informed, tracks workers natively, and avoids cron wakeups or polling loops."
---

# Long-Running Task Management

Use existing sessions, subagents, handoffs, and outputs. Do not schedule cron wakeups or poll in a loop.

1. Start with a bounded definition.
   - State objective, expected phases, budget (`spend-circuit-breaker`), and what counts as done.
   - **Done when:** these four items are written in the reply or plan.

2. Delegate and yield.
   - Run tool-heavy phases through subagents (`multi-agent-coordinator`). For announcing children, end the turn with `sessions_yield`; collectors use `agents_wait`. The completion event resumes you; do not busy-wait or run sleep loops.
   - **Done when:** every phase has a run id or is queued behind a dependency.

3. Keep the owner informed.
   - Send updates only when essential: a phase completes, a blocker or owner gate appears, or the plan changes. No fixed cadence and no timer-driven updates. Before the session may end, write a durable handoff (`task-handoff`).
   - **Done when:** every essential event was reported and unfinished work has a handoff.

4. Watch for stalls.
   - A worker normally ends at its `runTimeoutSeconds` cap; one with no completion past it is checked once with `subagents` list, then cancelled if stalled (`loop-circuit-breaker`).
   - **Done when:** every worker is completed, cancelled, or explicitly waiting on an owner gate.

5. Persist progress at pause points.
   - If the task will outlive this session, write a handoff with `task-handoff`. Register generated artifacts in `outputs/INDEX.md`.
   - **Done when:** a handoff path exists for anything unfinished, and the final report lists it.
