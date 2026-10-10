---
name: spend-circuit-breaker
description: "Use before dispatching paid or model-heavy workers and when a plan may exceed cost limits: sets explicit call/token/time caps per plan and stops dispatch when they cannot be bounded."
---

# Spend Circuit Breaker

Cost control is a per-plan budget declared up front. It does not parse session logs, keep a monthly ledger, or pause cron or automations.

1. Set the budget before dispatch.
   - Per plan and per worker: max tool calls, max tokens (or context size), max wall-clock, max workers (default 1; up to 4 only when the owner approved), retries (1).
   - Pick the cheapest capable worker tier under the deployment's worker-tier policy; use its configured candidate pools rather than hard-coding model IDs.
   - Set `runTimeoutSeconds` on each spawn for the host-enforced time cap; call/token caps are advisory brief instructions unless the host enforces them.
   - **Done when:** every worker has numeric caps written in its brief and a spawn timeout.

2. Refuse unbounded work.
   - If a task's cost cannot be bounded (open-ended research, unknown input size), narrow it, split it, or ask the owner for an explicit cap. Do not dispatch.
   - Approval-only models need explicit per-task owner approval. Apply the deployment's configured model and provider policy; do not dispatch candidates outside it.
   - **Done when:** no dispatched worker lacks caps or approval.

3. Enforce during the run.
   - Compare each worker's reported usage and elapsed time with its caps when it completes or on status checks; cancel a worker that exceeds a cap.
   - Do not escalate to a stronger tier more than once per step and only after a quality failure.
   - **Done when:** each worker ended within caps or was cancelled with the overrun noted.

4. Report.
   - Give per-worker model/route, caps versus observed, and any overrun; provider dashboards remain the authority for actual cost, so say when usage is unknown.
   - **Done when:** the report shows caps and observed usage or states usage unavailable.
