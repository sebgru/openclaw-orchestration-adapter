---
name: orchestration-2.0
description: "Use when the main session runs a multi-task project with dependent tasks: plans, dispatches workers via standard sessions_spawn, verifies, updates canonical state and dashboard, and stops at owner gates. Prototype."
---

# Orchestration 2.0 (prototype coordinator procedure)

The main session is the coordinator and stays accountable for the plan, routing, task lifecycle, verification, owner summaries, and dashboard. Workers execute one bounded task and return evidence. This skill is self-contained; it adds no tools, config, or ceilings.

## Rules (acceptance cues in brackets)

1. **Standard spawning only.** Create every ordinary worker with OpenClaw `sessions_spawn`. Do not use `orchestration_dispatch`, `orchestration_run_plan`, or adapter `api.runtime.subagent.run` for ordinary work. Workers keep the full ordinary tool set and normal OpenClaw policy; never add or imply a hidden tool/model ceiling. [CUE:STANDARD_SPAWN]
2. **Bounded adapter dispatch is an explicit exception.** Use it only when the owner asks for a least-privilege, grant-limited worker, or a task needs enforced per-run tool/budget limits. Record the exception and reason in the task record. It is never the default. [CUE:ADAPTER_EXCEPTION]
3. **Canonical task state.** Keep one plan file (e.g. `projects/<name>/README.md`) with per-task: id, goal, deps, status (`pending|ready|running|verifying|done|blocked|gated`), requested route, actual route, run id, timeout, evidence, next action. Only the coordinator edits it. [CUE:TASK_STATE]
4. **Self-contained brief before dispatch.** Include: goal and concrete deliverable; observable pass/fail criteria; evidence to return and where; dependencies; exact write scope; selected model; timeout; optional budget (state which parts are advisory vs host-enforced; only the run timeout is host-enforced); stop/escalation conditions; "do not delegate; report blockers instead of inventing criteria." Resolve any ambiguous criterion before dispatch. Scope text is intent, not a security boundary. [CUE:BRIEF]
5. **Choose and record the route.** Pick a registered, callable, policy-permitted model per the deployment routing policy, preferring eligible Claude models when they fit. Record requested model and reason. After spawn, read the receipt and record the actual model/provider. If the exact requested route is unavailable or the actual differs from the approved choice, halt that task, mark `blocked`, report; never substitute silently. [CUE:ROUTE_RECORD]
6. **Observe, steer, cancel.** Confirm the dispatch with the receipt; use `sessions_yield` to wait for completion events (no busy polling); use `subagents` list/`sessions_history` only for status/debugging; clarify with a steer message when needed; cancel via `subagents` cancel on timeout, wrong direction, or owner stop. Detect failure, timeout, and missing evidence. Retries are bounded, justified, and never repeat side effects blindly (check the worktree/outputs first). [CUE:LIFECYCLE]
7. **Verify independently.** A completion claim is not evidence. Re-run the checks or read the artifacts yourself against each criterion. A task is `done` only after that. Review tasks go to a fresh worker with a filtered brief (no author reasoning). Rejected review: record findings, create a fix task, re-review. [CUE:VERIFY]
8. **Progress automatically.** After verification, update the canonical state, compute the next `ready` task (all deps `done`, not gated), and dispatch it without asking the owner. Stop only for a gate, blocker, or completion. [CUE:AUTO_PROGRESS]
9. **Dashboard before completion.** After recording a verified result, synchronize the hosted dashboard from canonical state and confirm it shows the new status; only then report the task complete. If the dashboard update fails, the task is not complete. [CUE:DASHBOARD_SYNC]
10. **Owner summaries with evidence.** At milestones, blockers, gates, and completion: what completed (with evidence refs), what is running/remaining/blocked, next action, decision needed. Concise. [CUE:OWNER_SUMMARY]
11. **Human gates.** Stop and present the reviewable artifact for: PR review/merge, push where approval is required, OpenClaw config or model-routing changes, Gateway restart/activation. Continue independent authorized work meanwhile. Approval for one gate does not authorize another. [CUE:HUMAN_GATE]
12. **Worker tree.** Only the coordinator spawns; workers may propose splits but do not spawn by default. [CUE:CENTRAL_DISPATCH]
13. **Denials are reported accurately.** Surface actual tool denials as such; do not describe them as task failure or a worker error. [CUE:DENIAL_VISIBLE]

## Three-dependent-task trial shape

T1 implement -> T2 verify/test (deps T1) -> T3 independent review (deps T2), then gate G1 human PR review. Pass when the log shows: three standard `sessions_spawn` receipts with recorded actual models, zero owner nudges between T1-T3, each task `done` only after coordinator verification and a dashboard sync, and the run halted at G1 with no adapter dispatch.

## Done when

Every task is `done`, `blocked`, or `gated` in canonical state; the dashboard matches; and the owner has the final summary with evidence and the next gate.
