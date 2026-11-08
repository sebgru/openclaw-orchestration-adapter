# Project Orchestration 2.0 — Requirements

Status: **All 21 requirements owner-approved on 2026-11-08; implementation verification pending.**
Last updated: 2026-11-08 UTC.

This document is the owner-approved testable product/behavior contract for the Orchestration 2.0 project. It is a planning/acceptance specification, not a claim that this repository or its current implementation satisfies these requirements. Project phases, owners, dependencies, and delivery gates remain in the owner-maintained project tracker. Owner acceptance approves the scope/behavior contract; it does not mean any requirement is implemented or verified. “Verified by” names evidence required when the relevant phase is built; until evidence is linked and reviewed, implementation state remains **pending**.

## Status key

- **pending** — not yet demonstrated by accepted evidence.
- **in progress** — implementation or verification is actively underway.
- **verified** — evidence exists, passes the stated acceptance, and has been reviewed by the coordinator.
- **deferred** — explicitly moved out of the 2.0 acceptance scope with owner agreement.

## Requirements

| ID | Requirement | Verified by (planned evidence) | Implementation state | Owner decision |
|---|---|---|---|
| ORCH-CORE-01 | The main agent remains accountable for the project: owns the canonical plan, task decomposition, dependency order, dispatch, monitoring, verification, continuation, owner-facing summaries, and the project dashboard. After every completed delegated task/milestone, it verifies the result, records status/evidence/next action in the canonical plan, and immediately synchronizes the dashboard before marking the work complete. It gives Sebastian concise visible summaries at meaningful milestones, blockers, owner gates, and completion. Each summary states what completed with evidence, what remains/in progress/blocked, the next action, and any decision needed. Workers execute bounded tasks and return evidence; they do not replace coordinator accountability or owner-facing reporting. | End-to-end run with dependent tasks verifies each result and shows canonical plan plus dashboard updated before task completion is reported; milestone/final summaries include evidence, current state, next action, and any explicit owner decision/gate. | pending | accepted (2026-11-08) |
| ORCH-CORE-02 | Normal worker creation uses OpenClaw's standard `sessions_spawn` path and its ordinary configured tool/security policy. The orchestration layer must not silently replace this with the adapter-specific worker runtime or add a hidden tool/model ceiling. | Source/API review and runtime trace of a disposable plan run | pending | accepted (2026-11-08) |
| ORCH-CORE-03 | Before dispatch, the coordinator gives every worker a self-contained brief naming: the task goal and concrete deliverable; explicit, observable pass/fail acceptance criteria; the evidence the worker must return and its location/format; dependencies; exact write scope; selected model/route; task-appropriate timeout and any explicit budget; and stop/escalation conditions. Criteria must be specific enough for the worker to know when to stop and for the coordinator to independently judge pass/fail without guessing. If a criterion is ambiguous or not observable, the coordinator resolves it before dispatch; the worker reports a blocker instead of inventing criteria. | Brief-schema review plus fresh-worker fixtures: a valid task meets each stated criterion and returns the named evidence; a missing/ambiguous criterion is caught before dispatch or returned as a blocker, never silently guessed. | pending | accepted (2026-11-08) |
| ORCH-CORE-04 | The coordinator uses the configured model-routing policy to choose a task-appropriate, registered, callable, policy-permitted worker model, favoring eligible Claude models when they fit the task. Another permitted model may be used only when the routing policy allows it and the choice is explicit—never as a silent substitution. For every dispatched task/subagent, the canonical task record captures the requested model/route and the actually selected model ID/route, confirmed from the spawn receipt; completion reports identify the model used. If an exact requested route is unavailable or the selected route does not match the approved choice, dispatch halts and reports the blocker rather than guessing. | Routing fixtures verify eligible Claude preference and justified policy-permitted alternatives; spawn-receipt fixture confirms requested/actual model IDs are recorded per task; unavailable-route and mismatch fixtures halt without silent substitution. | pending | accepted (2026-11-08) |
| ORCH-CORE-05 | Worker permissions are inherited from normal OpenClaw policy. Task instructions may scope intended work but are not misrepresented as a technical security boundary. Actual tool denials are surfaced accurately. | Policy/source review and visible-denial acceptance fixture | pending | accepted (2026-11-08) |
| ORCH-COORD-01 | By default, one coordinator creates and controls the worker tree. A worker may propose a useful split but does not recursively spawn by default; coordinator approval and dispatch are required. | Multi-task run trace proving central dispatch and no worker-created descendants | pending | accepted (2026-11-08) |
| ORCH-COORD-02 | The coordinator observes worker lifecycle using OpenClaw's internal session/subagent tools: confirms dispatch, checks progress/status, steers or clarifies when needed, collects completion, and detects failure, timeout, or missing evidence. | Lifecycle trace covering running, completed, failed, and timed-out workers | pending | accepted (2026-11-08) |
| ORCH-COORD-03 | The coordinator chooses a timeout appropriate to the task, long enough for expected work, and states it in the brief/dispatch. It does not use an arbitrary universal short timeout. Retries are bounded, justified, and do not duplicate side effects blindly. | Timeout/retry policy review and timeout/recovery fixture | pending | accepted (2026-11-08) |
| ORCH-COORD-04 | The coordinator verifies worker results against the stated acceptance criteria using fresh observable evidence before marking work complete or launching dependent tasks. A worker's completion claim alone is insufficient. | Independent verification fixture with a deliberately false/incomplete worker claim | pending | accepted (2026-11-08) |
| ORCH-STATE-01 | The project plan is the durable source of task status, dependencies, owner, evidence, next action, and owner gate. State distinguishes pending, running/in progress, blocked, review-ready, verified/done, and deferred. | State/lifecycle schema review and interruption/resume fixture | pending | accepted (2026-11-08) |
| ORCH-STATE-02 | When a worker completes, the coordinator automatically verifies the result, updates project state, and starts the next authorized dependency-ready task or reports a concrete blocker/gate. It does not wait for Sebastian to say “continue” after routine steps. | Multi-step plan-runner acceptance with no owner nudge between routine tasks | pending | accepted (2026-11-08) |
| ORCH-STATE-03 | An interruption, compaction, or session change resumes from durable project state and recorded evidence without losing owner gates or redoing verified work unnecessarily. | Pause/resume acceptance scenario with completed and in-flight tasks | pending | accepted (2026-11-08) |
| ORCH-OWNER-01 | The workflow stops and requests Sebastian's input when a material unresolved owner choice or protected action is reached; the request identifies the specific decision/action and presents the concrete reviewable artifact. Independent authorized work continues where possible. | Ambiguity and owner-gate fixtures; audit of approval matrix | pending | accepted (2026-11-08) |
| ORCH-OWNER-02 | Human review of a prepared PR is an explicit required checkpoint under the current 2.0 policy. After review, continuation may proceed only within authority already granted by the project and governing rules; approval does not implicitly authorize unrelated actions. | PR lifecycle fixture from ready-for-review through accepted/rejected review | pending | accepted (2026-11-08) |
| ORCH-OWNER-03 | Current hard rules remain authoritative, including explicit approval for OpenClaw config/model-routing changes, Gateway restart, and significant push/merge actions where required. 2.0 does not silently relax them; proposed future guardrail changes require separate owner review. | Requirement-to-policy traceability review and protected-action fixtures | pending | accepted (2026-11-08) |
| ORCH-VIS-01 | Sebastian receives concise visible progress at meaningful milestones and blockers, with no prolonged silent work interval; routine tool narration and repeated “continue?” prompts are avoided. | Session transcript review against reporting/cadence rules | pending | accepted (2026-11-08) |
| ORCH-VIS-02 | Reports distinguish running, blocked, failed, review-ready, and verified complete, and include evidence plus the next action/owner gate. | Status-report fixtures and project tracker review | pending | accepted (2026-11-08) |
| ORCH-DECISION-01 | The design evaluates OpenClaw Decision Model for typed worker-model selection judgments only. It cannot alter main-assistant routing; if adopted, it is explicitly selected/configured, disabled when unconfigured, and failures return control to the coordinator without chat-model fallback. | Architecture decision record, schema/failure fixtures; no configuration change in design phase | pending | accepted (2026-11-08) |
| ORCH-ACCEPT-01 | Before rollout, a disposable end-to-end run completes at least three dependent tasks, including an independent review, through standard OpenClaw spawning; it continues automatically between routine steps and halts at an explicit human-review/action gate. | Reproducible run log, task-state history, evidence bundle, and independent workflow review | pending | accepted (2026-11-08) |
| ORCH-ACCEPT-02 | Failure/recovery acceptance covers worker error, timeout, unavailable exact model, rejected/requested-changes review, and interruption; none may create false completion or unsafe duplicate execution. | Scenario-by-scenario evidence bundle linked from project tracker | pending | accepted (2026-11-08) |
| ORCH-ROLLOUT-01 | The exact implementation repository, branch, activation steps, rollback, and verification evidence are identified before implementation/rollout dispatch. No Gateway/config/plugin activation is implied by this specification. | Approved implementation brief and reviewable PR; rollout checklist | pending | accepted (2026-11-08) |

## Owner acceptance

Sebastian explicitly accepted all 21 requirements listed above on 2026-11-08. This confirms the 2.0 behavior/acceptance scope. It does not mark implementation evidence as passed, authorize configuration/runtime changes, or close the separate Phase 0.3 autonomy/approval-matrix decision.

## Scope and change control

- This contract describes the intended **Orchestration Plugin 2.0** outcome, not a declaration that the current adapter provides it.
- The standard OpenClaw spawning path is the default coordinator-to-worker mechanism. The installed orchestration adapter's role remains an architecture decision; do not infer that it will be activated or used for ordinary work.
- The model policy in workspace `AGENTS.md`/`TOOLS.md`, `SOUL.md`, repo instructions, and Sebastian's approval gates remain controlling. Requirements here do not override them.
- New or changed requirements receive a stable ID, rationale, acceptance evidence, and owner decision where scope/authority changes. Marking a requirement verified requires linked evidence in the project tracker.
- Implementation and rollout remain gated by owner review of the autonomy/approval matrix and subsequent project gates in the owner-maintained project tracker.

## Traceability to project plan

| Requirement group | Plan coverage |
|---|---|
| CORE, COORD | Phases 1 and 5 |
| STATE | Phase 2 and Phase 5 |
| OWNER | Phases 0, 3, and 6 |
| VIS | Phase 4 |
| DECISION | Phase 1.5 |
| ACCEPT | Phase 5 |
| ROLLOUT | Phase 6 |
