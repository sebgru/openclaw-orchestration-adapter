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

The package includes the OpenClaw plugin manifest and guarded runtime hook; plugin
activation remains off by default. Worker dispatch, model resolution, and verification
use bounded caller-supplied adapters. This package does not change owner-chat model
routing, and cross-channel identity/resume remains deferred in v1.

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
