# Completion-Driven Continuation (Phase 5.1)

Procedure for running T1 implement -> T2 verify/test -> T3 independent review and stopping at the human PR review gate with zero owner continuation prompts. Only standard `sessions_spawn` is used; there is no adapter dispatch.

## What OpenClaw guarantees vs. what the model does

Documented event delivery (`/app/docs/tools/subagents/announce.md#private-parent-completion`, `tool-reference.md` `completionTarget`):

- `completionTarget: "parent"` returns a child's result as a private turn of the spawning requester session, with no automatic channel delivery.
- If the parent called `sessions_yield`, the parent resumes when the yielded children settle.
- The resumed turn is bound to the spawning session. If that session is reset (e.g. `/new`) or replaced, results are dropped.
- Supported only for hidden, native, `mode: "run"` children. Not combinable with ACP, `collect`, `visible`, `thread`, session mode, or `expectsCompletionMessage: false`.

Not guaranteed by OpenClaw: that the parent verifies, updates state, or spawns the next task. OpenClaw delivers the event. The continuation is the model's own behavior in the resumed turn, driven by this procedure. If the parent is reset, the chain stops and canonical state is the only recovery source.

## Procedure (one cycle per task)

1. **Spawn.** `sessions_spawn` with `completionTarget: "parent"`, `context: "isolated"`, a stable `taskName`, a `label`, and a brief (objective, output, write scope, verification, limits). Omit `visible`, `collect`, `thread`, and `expectsCompletionMessage`.
2. **Gate and record dispatch.** Apply the skill's receipt gate: require matching, receipt-confirmed `resolvedModel`, `resolvedProvider`, and `runId`; block the attempt on missing/mismatched fields, inspect possible side effects, and never accept that output. Record the task as `running` with the receipt's `runId`, returned `childSessionKey`, `taskName`, and label before yielding. Preserve an unconfirmed applied timeout as unconfirmed.
3. **Stay pending.** Call `sessions_yield`. Do not poll, and do not ask the owner to continue.
4. **Resume and identify.** The documented completion envelope includes child session key/id, task label, outcome status, and result content; do not assume it carries a `runId` or `taskName` field. Match its trusted session key/id and label to the recorded receipt and `subagents` registry. Use `sessions_history` for the exact run transcript when needed. Ignore or flag any result that matches no running task (unknown run, duplicate); never trust identity asserted only by worker-authored text.
5. **Verify independently.** Treat the child report as a claim. Re-run checks or read artifacts against each acceptance criterion. Check `subagents` list for unexpected descendants.
6. **Update state and dashboard.** Record `done` only after verification passes. Map worker/runtime failures, missing evidence, or verification failures to the canonical `blocked` status with the reason/evidence; do not introduce an unsupported `failed` status. Sync the dashboard and confirm it shows the status. A failed sync means the task is not complete.
7. **Schedule next.** Compute the next ready task (all dependencies `done`, not gated) and repeat from step 1 without an owner prompt.
8. **Stop** on a blocker, an unverifiable claim, a budget or timeout breach, a rejected review (record findings, create a fix task, re-review within bounds), or an owner gate.

## Chain for Phase 5.1

| Task                  | Worker                                             | Gate to proceed                        |
| --------------------- | -------------------------------------------------- | -------------------------------------- |
| T1 implement          | one implementer                                    | parent verifies the diff and scope     |
| T2 verify/test        | fresh worker                                       | parent re-runs tests; passing evidence |
| T3 independent review | fresh worker, filtered brief (no author reasoning) | approved review                        |

After T3 is verified and the dashboard is synced, stop at the **human PR review gate** and present the artifact. Push, merge, config change, and Gateway restart remain owner-gated and are never implied. The resulting parent final follows the conversation's normal reply-delivery rules; private child input does not make the parent final private.

## Limits and audit

- Bounded retries (infra failures only); no loops on repeated failure (see loop-circuit-breaker).
- Each cycle leaves an auditable trail: task state transitions, run ids, verification evidence, dashboard confirmation.
- Parent reset between yield and resume breaks the chain; resume from canonical state with an explicit owner request.

## Durable task ledger (recovery and duplicate prevention)

`createTaskLedger` (`src/task-ledger.js`) is an optional coordinator-side record for the procedure above. It does not spawn, wait, or call any host API; the coordinator still uses standard `sessions_spawn`/`sessions_yield`. It stores an append-only, hash-chained JSONL file at an absolute path chosen by the caller and replays it to derive task state.

- **Reserve before spawn.** `reserveDispatch(taskId)` durably records the attempt before `sessions_spawn` is called, and refuses a second dispatch while an attempt is reserved, running, review-ready, or verified. A crash between reservation and receipt leaves `admission-unknown`; `recover()` marks it blocked and never re-dispatches. Check `subagents` for a matching run, then call `resolveBlocker` with `sideEffectsChecked: true` before any retry.
- **Receipt gate.** `recordReceipt` stores requested versus receipt-confirmed model and provider, `runId`, and `childSessionKey`; an applied timeout not echoed by the receipt stays `unconfirmed`. Missing fields, a mismatch, or an unavailable exact model block the attempt.
- **Completion needs a trusted envelope.** `recordCompletion` matches on the recorded `childSessionKey`. Unmatched and duplicate completions are recorded as notes and ignored. `recordQueued` shows a queued delivery but never advances the task.
- **No dashboard bypass.** A task becomes `done` only through `recordDashboardSync` after a passing verification with evidence references, and only when a publisher tool was evidenced by `recordCapability`. If publishing fails, `recordPublisherFailure` leaves it visibly blocked and dependents stay waiting.
- **Evidence provenance.** Each receipt carries `evidenceSource` (`standard-spawn` or `adapter-fake-host`). `assessAcceptance` counts only `standard-spawn` evidence for ORCH-ACCEPT-01/02 and lists fake-host tasks separately.
- **Visibility.** `deriveStatusView`/`renderStatusMarkdown` show per-task status, unmet dependencies, upstream blockers, blocker code with evidence source, requested versus actual model, and next action.

Limits: the ledger is advisory state kept by the coordinator. It cannot cancel a running worker, prove a host-side effect did or did not happen, make a queued message complete, or add a host capability. The lock file is not stale-recovered; a crashed writer's lock needs manual inspection.
