---
name: subagent-driven-development
description: "Use when implementing a multi-task code change from an approved plan by delegating each task to a fresh implementer subagent followed by an independent review. Native sessions only."
---

# Subagent-Driven Development

Per task: one fresh implementer, then one independent reviewer, then your own verification. The main session never silently becomes the implementer.

1. Prepare each task.
   - From the plan, take one task with its files, acceptance criteria, and test command. Check the repo/devcontainer rules (use a Codespace when a `.devcontainer` exists; do not install dependencies in OpenClaw).
   - **Done when:** the task fits one write scope and states how success is tested.

2. Implement.
   - Spawn an isolated worker (`context: "isolated"`, never `fork`; set `runTimeoutSeconds`) with the brief from `multi-agent-coordinator`: tests for behavior changes, no commits/push/PR unless the owner approved them (advisory unless host-enforced), report changed files and test output.
   - Tier: standard for normal coding, strong for hard debugging or high-stakes work, using the deployment's approved worker-tier policy.
   - **Done when:** the report lists changed paths and results of the task's tests.

3. Review.
   - Run `requesting-code-review` on that task's diff with a different worker than the implementer.
   - Send blocking findings back to a fresh implementer (one fix round); non-blocking ones go in the final report.
   - **Done when:** the reviewer reports no blocking issues, or the task is marked `blocked` after one fix round.

4. Verify.
   - Re-run the task's tests/lint yourself or via a verifier per `verification-before-completion`; check the diff touches only the declared scope.
   - **Done when:** fresh passing evidence exists for the task; only then start the next dependent task.

5. Close out.
   - After the last task run the plan's gates (`quality-gate-orchestrator`) and report. If you commit, tell the owner; pushing and merging need approval.
   - **Done when:** the report lists tasks, evidence, models used, and what awaits approval.
