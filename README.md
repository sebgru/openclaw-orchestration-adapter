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

This package is not yet an OpenClaw plugin; its worker, model resolver, and verifier
are caller-supplied functions. The cross-channel identity tuple and runtime
retrieval/receipt interface remain open design dependencies for later phases. Model
tiers are abstract contract values and must be resolved against the owner's current
routing policy by a future runtime integration; this package does not change
owner-chat model routing.

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
