---
name: requesting-code-review
description: "Use when a code change is ready for independent review before it is called done or merged: dispatches an isolated reviewer with a filtered brief and triages findings."
---

# Requesting Code Review

Get a reviewer who has not seen the implementer's reasoning, so the review checks the code rather than the story.

1. Package the review.
   - Identify the exact change: `git diff` range or file list, plus the task's requirements and acceptance criteria.
   - Filter the context: include requirements, diff, and test commands. Exclude chat history, implementer rationale, credentials, and unrelated memory.
   - **Done when:** the package names the diff range and requirements and nothing private.

2. Dispatch the reviewer.
   - Spawn an isolated, read-only worker (`context: "isolated"`, never `fork`; `runTimeoutSeconds` set; prohibit edits/push/network in the brief — advisory unless the host enforces a read-only tool policy, so say which). Pick a model different from the implementer where available; use the strong tier for security-sensitive or cross-repo changes according to AGENTS.md → Tools → Local notes and proposal §8.
   - Ask for findings with severity (blocking / non-blocking), file:line, and a concrete failure scenario each; ask it to say explicitly what it did not check.
   - **Done when:** the spawn was accepted and its completion is awaited via `sessions_yield`.

3. Triage.
   - Verify each blocking finding against the code before acting; discard those you cannot reproduce or confirm, and say so.
   - Fix confirmed blockers through a new implementer task, then re-review once.
   - **Done when:** every finding is `confirmed`, `rejected (reason)`, or `deferred`.

4. Report review status with reviewer model, scope covered, and residual risk. A review does not replace the tests in `verification-before-completion`.
   - **Done when:** the report names reviewer model, scope covered, and residual risk.
