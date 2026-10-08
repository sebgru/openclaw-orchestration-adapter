---
name: executing-plans
description: "Use when Sebastian approves or asks to run an existing written plan in the current session: executes steps in order, checks each, stops on blockers, supports resume."
---

# Executing Plans

Run an approved plan faithfully. The plan is authority only for what Sebastian approved (this turn, or earlier within its stated scope when resuming); this skill never self-activates from a keyword or an old plan file.

1. Confirm the contract.
   - Re-read the plan and confirm Sebastian's go-ahead covers it. Note the steps flagged `needs-approval`.
   - Check the plan still matches reality (files, repo state, budgets); if not, stop and report the drift instead of improvising.
   - Resuming: restart only from a persisted plan or `task-handoff` file; re-verify its steps against current state and continue at the first non-`done` step. A prior authorization persists only within its stated scope and age; ask Sebastian only for `needs-approval` gates and for changed scope, not to re-confirm the whole plan.
   - **Done when:** you can state which steps you will run, which are gated, and (if resuming) which source you resumed from.

2. Execute one ready step at a time (or a parallel wave per `dispatching-parallel-agents`).
   - Delegate tool-heavy steps per `subagent-orchestrator-boundary`; the main session coordinates and verifies.
   - Record each step as `pending / running / done / blocked / skipped` in your running status.
   - **Done when:** the step's completion criterion is met by fresh evidence (see `verification-before-completion`), not by the worker's claim.

3. Handle failures.
   - One retry only for a classified infrastructure failure; otherwise mark `blocked`.
   - On repeated failure or no progress, apply `loop-circuit-breaker`.
   - **Done when:** every failed step is `blocked` with cause and evidence, never silently dropped.

4. Stop at owner gates.
   - Do not push, merge, open PRs, change config, restart, or use expert routes without Sebastian's explicit approval for that action.
   - **Done when:** gated steps are reported as awaiting approval.

5. Pause or finish.
   - To pause across sessions, hand off with `task-handoff`. To finish, run the plan's gates via `quality-gate-orchestrator`.
   - **Done when:** the final report lists step statuses, evidence, models/routes used, and open items.
