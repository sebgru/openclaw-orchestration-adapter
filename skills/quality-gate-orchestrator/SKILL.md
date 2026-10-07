---
name: quality-gate-orchestrator
description: "Use when a plan or handoff needs explicit completion gates (tests, lint, build, security, diff, provenance, approvals) evaluated as pass/fail/blocked/waived before work counts as ready."
---

# Quality Gate Orchestrator

Gates live in the active plan or handoff text; there is no gate database or state file.

1. Declare gates.
   - Pick the applicable ones: tests, lint, build/type, security review, diff scope, provenance (claims cite sources), owner approvals. Add the exact command or check for each.
   - **Done when:** every gate has an owner, an exact check, and a required/optional flag.

2. Evaluate each gate with fresh evidence (use `verification-before-completion`).
   - Result is one of `pass`, `fail`, `blocked` (cannot run; state why), or `waived`.
   - A waiver needs a visible rationale and Sebastian's approval; workers and the coordinator cannot waive required gates on their own.
   - **Done when:** every gate has a result with its evidence.

3. Decide readiness.
   - Ready only if all required gates are `pass` or approved `waived`. Any `fail` or `blocked` required gate means not ready.
   - **Done when:** the readiness verdict follows mechanically from the gate results.

4. Record.
   - Add the gate table to the final report, and to the handoff (`task-handoff`) if the work pauses.
   - **Done when:** the table with results and evidence is in the reply or handoff file.
