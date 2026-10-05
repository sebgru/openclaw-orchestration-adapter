# OpenClaw Orchestration Adapter

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

Requires Node.js 22 or later. Run `npm run check` for syntax checks and `npm test`
for the dependency-free Node test suite. CI is not yet configured.
