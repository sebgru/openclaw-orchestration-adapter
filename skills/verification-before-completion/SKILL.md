---
name: verification-before-completion
description: "Use before saying work is done, fixed, passing, or ready, and before accepting a subagent's completion claim: requires fresh, observable evidence."
---

# Verification Before Completion

A claim of completion is only as good as evidence gathered after the last change.

1. State the claim in checkable terms.
   - Example: "the unit tests pass", "file X contains Y", "the service returns 200".
   - **Done when:** each claim maps to a command, file read, or observable state.

2. Gather fresh evidence.
   - Run the check now, after the final edit. Earlier output, a worker's statement, or "should work" does not count.
   - For code: run the relevant tests/lint/type check; read `git diff --stat` to confirm only intended files changed.
   - For a worker claim: re-run or re-read the evidence yourself (or have an independent verifier do it).
   - **Done when:** you have output newer than the last change.

3. Compare with the claim.
   - Passing output supports the claim; failures, skipped steps, or checks that could not run do not.
   - **Done when:** each claim is `verified`, `failed`, or `unverified (reason)`.

4. Report faithfully.
   - Lead with the verified result and the exact command/evidence; list failures with their output and unverified items with the blocker. Never describe unrun checks as passed, and never claim memory-backed verification if memory search was unavailable.
   - **Done when:** the report contains evidence for every "done" statement.
