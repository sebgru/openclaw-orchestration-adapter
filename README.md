# OpenClaw Orchestration Adapter

[![CI](https://github.com/sebgru/openclaw-orchestration-adapter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sebgru/openclaw-orchestration-adapter/actions/workflows/ci.yml)
[![Lint](https://github.com/sebgru/openclaw-orchestration-adapter/actions/workflows/lint.yml/badge.svg?branch=main)](https://github.com/sebgru/openclaw-orchestration-adapter/actions/workflows/lint.yml)
[![codecov](https://codecov.io/gh/sebgru/openclaw-orchestration-adapter/branch/main/graph/badge.svg)](https://codecov.io/gh/sebgru/openclaw-orchestration-adapter)
[![License: MIT](https://img.shields.io/github/license/sebgru/openclaw-orchestration-adapter.svg?branch=main)](LICENSE)

Least-privilege orchestration for OpenClaw agents: bounded plans and task dispatch,
policy-aware model selection, cancellation, verification, and handoffs—without a
persistent workflow database.

## Current implementation

The initial Phase 2 foundation provides a versioned task contract, in-memory plan
state machine, and an injected dispatch boundary. It validates task scope, success
criteria, explicit tool grants, prohibited actions, routing tier, budgets, output
schema, dependencies, and DAG acyclicity. Dispatch batches are concurrency-capped,
tasks receive only declared grants, timeouts/cancellation are bounded, and successful
worker output remains pending until an independent verifier accepts it. A strict
consumer for memory-adapter receipt schema v2 fails closed on missing/unknown
receipts and labels all forwarded retrieval as untrusted evidence. Plan state is
transient and has no file, database, session, cron, or Gateway integration.

### Opt-in lifecycle diagnostics

`lifecycleDiagnostics` is an operator-owned plugin setting and defaults to
`false`. When enabled, the adapter emits at most 4,096 worker lifecycle events
per process through
the host plugin logger. Events use a per-dispatch correlation ID and
per-process-salted fingerprints for session/run identifiers; they exclude task
content, prompt text, tool arguments/results, and raw identifiers. Diagnostic
logging is fail-neutral and never changes guard decisions. This telemetry helps
correlate binding/admission/release with blocked hook calls, but does not create
host identities or substitute for a host-supported integration fixture.

### Token-budget hint

`budget.maxTokens` is optional and defaults to 150,000 tokens per worker attempt;
`null` explicitly means no finite token ceiling. The resolved value is included
in the worker grant and brief. This is a requested budget hint, not a security
boundary or an enforced accounting guarantee: the current runtime adapter does
not meter token usage or send a provider-enforced token cap. Timeouts and tool-call
limits remain separate enforced controls. Each retry is a new attempt with the
same ceiling; this package does not aggregate token use across retries or convert
tokens into dollar cost. A host integration must enforce this hint if it needs a
hard limit; workers cannot establish their own compliance by acknowledging it.

The package includes the OpenClaw plugin manifest and guarded runtime hook; plugin
activation remains off by default. Worker dispatch, model resolution, and verification
use bounded caller-supplied adapters. This package does not change owner-chat model
routing, and cross-channel identity/resume remains deferred in v1.

### Agent-callable dispatch tool

When the plugin config contains a `dispatch` block, the plugin registers one optional agent tool, `orchestration_dispatch`, with `api.registerTool(factory, { name, optional: true })`. It is hidden unless an operator opts in to it with `tools.alsoAllow: ["orchestration_dispatch"]`, the requester is the verified owner (`senderIsOwner`), the run is not sandboxed, and the host context supplies `requesterSenderId`, `agentId`, `sessionKey`, and `deliveryContext.channel`. Any missing field hides the tool and makes `execute` fail closed; no placeholder identity is substituted.

Use `tools.alsoAllow`, not `tools.allow`: `tools.allow` is a restrictive allowlist, so `"allow": ["orchestration_dispatch"]` removes every other tool (including `read`, `exec`, and `sessions_spawn`) from the active profile. The tool is offered only in owner-originated turns that carry all of the fields above; delegated worker runs without a trusted requester identity do not see it.

```json
{
  "tools": {
    "alsoAllow": ["orchestration_dispatch"]
  }
}
```

Plugin config (`plugins.entries.openclaw-orchestration-adapter.config`); without `"enabled": true` the plugin registers nothing:

```json
{
  "enabled": true,
  "dispatch": {
    "allowedTools": ["mcp__openclaw__gateway_exec"],
    "allowedCalls": [
      {
        "toolName": "mcp__openclaw__gateway_exec",
        "params": {
          "command": "git -C /workspace/project status --short",
          "title": "Read-only status check"
        }
      }
    ],
    "maxCalls": 10,
    "maxTimeoutMs": 120000,
    "maxTokens": 100000
  }
}
```

- `dispatch` is an operator-owned ceiling; the calling agent can only narrow it. Delegation tools are never grantable, completion mode (default) grants no tools, and budgets above the ceiling are rejected.
- For a strict command/tool-argument allowlist, configure `dispatch.allowedCalls`. Every `allowedTools` entry must then have at least one entry; the worker receives those operator-owned exact parameters, and its complete argument object must match one configured `params` object. Extra fields, changed commands, or missing arguments are blocked by the adapter's `before_tool_call` hook before the host tool runs. This can constrain `gateway_exec` to fixed command and option values. Do not put credentials or secrets in allowlisted parameters. Omitting `allowedCalls` preserves the prior name-only grant behavior.
- Task scope (`agentId`, `deliveryContext.channel`, `sessionKey`) is taken from host tool context, not model input; unknown parameters are rejected. The caller may supply an optional `model` exact pin, but cannot choose retries or dependencies. The pin must be in the selected tier's deployment-configured `workerRoutes` pool; an out-of-pool or unavailable pin fails closed without substitution. An unconfigured tier also fails closed.
- A single dispatch has no independent verifier, so results are returned with `verified: false` and must be checked by the caller.

### Multi-task plan runner tool

Adding `dispatch.plan` (e.g. `{ "maxTasks": 8, "maxParallel": 2, "verifierTier": "strong" }`) also registers the optional `orchestration_run_plan` tool, exposed under the same conditions as `orchestration_dispatch` (add it to `tools.alsoAllow`). It accepts up to `maxTasks` (hard cap 16) tasks with local `id`s and `dependencies`, validates the whole plan (unknown parameters, duplicate/unknown/cyclic dependencies, per-task grants and budgets against the `dispatch` ceiling) before dispatching anything, then runs dependency waves of at most `maxParallel` tasks.

To grant `orchestration_run_plan` to one agent, add it to that agent's `agents.entries.<id>.tools.alsoAllow`. In the current OpenClaw runtime, an agent-specific `alsoAllow` list takes precedence over the global `tools.alsoAllow` list for that agent, so include every optional plugin tool that agent needs. The list extends the active tool profile; other applicable restrictions, including `deny`, sandbox, and runtime policy, still apply. `allow` and `alsoAllow` cannot both be set in the same scope: merge the tool into that scope's `allow` list, or use a profile with `alsoAllow` instead. For example:

```json
{
  "agents": {
    "entries": {
      "worker": {
        "tools": {
          "alsoAllow": ["orchestration_run_plan"]
        }
      }
    }
  }
}
```

- Each task gets its own grant and budget; there is no aggregate plan budget, so total calls/time can reach the sum of each task's worker and verifier ceilings. Delegation tools, Gateway-related tools, shell/terminal/execution tools, and names containing `restart` are rejected even if allowlisted; scope comes from host context.
- Each task's output is judged by a separate tool-free completion context (tier `verifierTier`, default the task's tier) that must return `{"ok":true}`; anything else fails the task (fail closed). This is context-separated model judgment, not model-independent or ground-truth verification: the verifier may use the same underlying model as the worker and it checks no side effects. It judges at most the first 20,000 characters of worker output; long results can be rejected because relevant evidence was truncated. Each task reports `verifierAccepted`, plus `verification.verifierModel`, `workerModel`, `sameModelAsWorker`, `method` and `sideEffectsChecked: false`. Review results yourself. Execution is fail-fast: after a failed wave, remaining tasks are cancelled. Result output is capped at 8,000 serialized characters per task (up to 128,000 characters across 16 tasks).
- `gates` are required, and each gate must declare its `phase`. A plan needs at least one `completion` gate (an owner review) or it is rejected before dispatch. Plans are ephemeral and this tool cannot record gate outcomes: a `preflight` gate blocks all dispatch, and the runner always stops at the completion gate with `complete: false`, even when `allTasksSucceeded` is true. Continuing requires a fresh, explicit, owner-directed call; there is no resume.

### Worker-only model routing

`createWorkerModelResolver()` selects a model for dispatched execution workers only. It registers no model-resolution hook and never changes the owner/main-session chain. The package contains no provider-specific model names or default routes: deployments configure `workerRoutes` in the plugin config.

`workerRoutes` is a set of deployment-owned ordered candidate pools and the allow-list for automatic worker use. Tiers express task intent, not fixed models or owner-specific defaults. Only `review` is the review-specific intent; `strong` remains a general execution tier:

| Tier       | Intended use                             |
| ---------- | ---------------------------------------- |
| `priority` | latency- or priority-sensitive work      |
| `cheap`    | bounded lookups, summaries, simple edits |
| `standard` | normal coding and execution              |
| `strong`   | debugging, complex or high-stakes work   |
| `review`   | dedicated code or artifact review        |

Example (replace the placeholders with models actually configured on your host):

```json
{
  "workerRoutes": {
    "cheap": ["provider/model-cheap"],
    "standard": ["preferred-provider/model-standard", "alternate-provider/model-standard"],
    "strong": ["preferred-provider/model-strong", "alternate-provider/model-strong"],
    "review": ["preferred-provider/model-review", "alternate-provider/model-review"]
  }
}
```

- Candidate order is the deployment's preference order. When an availability callback is supplied, the resolver picks the first available candidate before dispatch. The selected worker model is not replaced after execution starts; normal task retry policy remains separate and is not provider/model failover.
- A pool is also the allow-list: caller-supplied model resolutions and `task.model` (including the public `orchestration_dispatch` tool's optional `model` parameter and the equivalent field on each plan task) must be present in the configured pool for that task's tier. An exact pin selects only that model, even when another candidate ranks higher; an unavailable or out-of-pool pin fails closed without trying another candidate. With no configured candidate, resolution fails closed rather than using a package default.
- Model references are opaque strings; this package does not enforce provider, subscription, or authentication policy. Deployments should include only models allowed by their own auth and budget policy.

`renderTaskHandoff()` builds a bounded Markdown handoff draft from explicit status,
decisions, evidence, next action, approvals, budget notes, and sources. It does not
write files or register outputs: callers must redact sensitive content and persist
the result only through the existing `memory/handoffs/` or registered-output workflow.

Plans may declare quality gates before dispatch. Approval gates default to the
preflight phase and block dispatch until a fresh evidence-backed pass or a fresh,
rationale-bearing waiver is recorded. Other gates default to the completion phase. A passing
gate must include a source, summary, observation time, and an explicit maximum evidence
age; completion is false while tasks or gates are incomplete, evidence is stale, or
no gates were declared. Gate state stays in memory with the plan.

`persistTaskHandoff()` can save an explicitly paused (`in_progress` or `blocked`)
handoff under an existing workspace `memory/handoffs/` directory. It requires
tenant, channel, and conversation scope, refuses symlinked directories, creates a
new mode-0600 file without overwriting, and never creates directories or resumes
the task. Callers remain responsible for redacting sensitive content. This is an
opt-in library API; the plugin does not invoke it automatically.
`loadTaskHandoff()` reads one exact handoff only when tenant, channel, and
conversation scope all match; it returns bounded content as untrusted evidence
and marks records older than 24 hours for confirmation. Scope is a lookup filter,
not authentication: callers must derive it from trusted host identity. Loading
never resumes work.

## Skills and attribution

`skills/` holds 15 adapted orchestration skills (SKILL.md only; no scripts, state
files, or cron). They are rewritten for native OpenClaw sessions, not copied
verbatim. Sources, pinned SHA, and license notices are in [NOTICE](NOTICE). v1 skill
rules: workers use isolated briefs (`context: "fork"` is forbidden without explicit
owner approval), parallelism defaults to 1 (maximum 4 when approved), prompt-only
restrictions are advisory unless the host enforces them, and cross-channel resume is
deferred.

## Development

Requires Node.js 22 or later.

```sh
npm install
npm run lint          # ESLint
npm run format        # Prettier (rewrites files)
npm run format:check  # Prettier (check only; used by CI)
npm run check         # Node syntax checks
npm test              # Node test suite
npm run test:coverage # Tests plus c8 coverage (fails below 90%)
```

Tests are a dependency-free Node test suite. Coverage is enforced at 90% for
statements, branches, functions, and lines via `c8`; the current suite reports
100% statements/lines and ~97% branches.

## CI

- **Lint** (`.github/workflows/lint.yml`): Prettier format check, ESLint, and Node
  syntax checks.
- **CI** (`.github/workflows/ci.yml`): test suite with c8 coverage (>= 90% enforced)
  and a Codecov upload. Set a `CODECOV_TOKEN` repository secret to enable the upload.
- **Release** (`.github/workflows/release.yml`): triggered only on version tags
  (`v*.*.*`); verifies the tag matches `package.json`, re-runs format/lint/syntax/tests,
  builds the npm package tarball, and attaches it to a GitHub Release.

To publish a release:

```sh
npm version patch   # or minor/major: bumps package.json and creates a vX.Y.Z tag
git push origin main --follow-tags
```

The release tarball is published as
`openclaw-orchestration-adapter-<version>.tgz` on the GitHub Release page.

## Worker canary tool (opt-in)

Set `canary: true` in plugin config to register `orchestration_canary`, a plugin-owned tool that takes no arguments, has no side effects, and always returns `{"ok":true,"canary":"orchestration-canary-v1"}`. It lets you prove an end-to-end worker tool grant without exposing any host tool. It is off by default and still requires listing it in `dispatch.allowedTools` and the operator tool allowlist. Only plugin-owned granted tools are passed to the host as `toolsAlsoAllow`; the `before_tool_call` guard remains the ceiling.
