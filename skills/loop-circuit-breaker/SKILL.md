---
name: loop-circuit-breaker
description: "Use when a worker or step is repeating the same action, retrying without progress, or bouncing between models or reviewers. Stops the loop and reports instead of continuing."
---

# Loop Circuit Breaker

Counters live in your running status for the current task only; nothing is persisted.

1. Count while working.
   - Per step track: attempts, the last error/result, and whether the evidence changed.
   - **Done when:** each running step has an attempt count and last-result note.

2. Trip the breaker on any of:
   - the same failing action or identical error twice;
   - two attempts with no new evidence or progress;
   - more than one retry (the cap is one, and only for a classified infrastructure failure such as timeout or provider outage);
   - a model-escalation loop (escalate at most once after a quality failure);
   - a review/fix cycle exceeding one fix round;
   - a worker exceeding its time or call budget.
   - **Done when:** every trip condition is checked after each failed attempt.

3. When tripped.
   - Cancel the worker (`subagents` cancel) if still running; mark the step `blocked` and its dependents blocked.
   - Do not change the prompt and rerun hoping for a different result.
   - **Done when:** the step has status `blocked` and no process is still running on it.

4. Report.
   - State what was tried, the repeated evidence, the suspected cause, and the options (different approach, owner decision, more budget needing approval).
   - **Done when:** the block is in the report or handoff (`task-handoff`) with enough detail to resume.
