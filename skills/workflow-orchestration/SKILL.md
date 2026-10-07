---
name: workflow-orchestration
description: "Use when a task has several steps with ordering constraints and you must decide what runs first, what waits, and what can overlap. Builds a transient dependency order inside the turn."
---

# Workflow Orchestration

Sequence dependent work. The dependency graph lives only in the current plan or reply; it is never written to a database, DAG file, or tasks folder.

1. List the steps and their inputs/outputs.
   - For each step note what it consumes and what it produces.
   - **Done when:** every step has named inputs and outputs.

2. Derive dependencies.
   - Step B depends on A if B consumes A's output, edits the same file/repo, or must follow A's verification.
   - Steps that only read the same material are independent.
   - **Done when:** each dependency is justified by one of those reasons and the graph has no cycle.

3. Group into waves.
   - Wave 1 = steps with no unmet dependency; the next wave = steps whose dependencies finished and were verified.
   - Cap each wave at the worker limit: default 1, maximum 4 and only when Sebastian approved parallelism; extra steps queue into the next wave.
   - **Done when:** the wave list covers every step exactly once.

4. Run wave by wave.
   - Dispatch a wave with `dispatching-parallel-agents`; advance only after each dependency's output passes its check.
   - If a step fails or is blocked, mark its dependents `blocked` and continue unrelated branches.
   - **Done when:** every step is `done`, `blocked`, or `skipped` with a reason.

5. Report the order actually run, including blocked branches and why.
