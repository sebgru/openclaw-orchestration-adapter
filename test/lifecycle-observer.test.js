import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskLedger } from "../src/index.js";
import { createLifecycleObserver, reconcileObservations } from "../src/lifecycle-observer.js";
import { createLedgerToolFactory, normalizeLedgerConfig } from "../src/ledger-tool.js";
import plugin from "../src/plugin.js";

const CHILD = "agent:main:subagent:1";
const setup = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oa2-obs-"));
  const file = path.join(dir, "ledger.jsonl");
  const ledger = createTaskLedger({ file });
  ledger.declarePlan({
    planId: "p",
    tasks: [
      {
        id: "T1",
        goal: "g",
        successCriteria: ["c"],
        requestedModel: "anthropic/claude-sonnet-5-5",
        timeoutMs: 1000,
      },
    ],
  });
  ledger.recordCapability({
    tools: ["sessions_spawn", "sessions_yield", "subagents", "dashboard"],
    publisherTool: "dashboard",
  });
  ledger.reserveDispatch("T1");
  ledger.recordReceipt("T1", {
    evidenceSource: "standard-spawn",
    runId: "run-1",
    childSessionKey: CHILD,
    resolvedModel: "claude-sonnet-5-5",
    resolvedProvider: "anthropic",
  });
  return { dir, file, ledger, obsFile: `${file}.observed.jsonl` };
};

test("observer records sanitized host events and ignores events without identity", () => {
  const { obsFile } = setup();
  const obs = createLifecycleObserver({ file: obsFile });
  assert.equal(obs.observeSpawned({}), false);
  assert.equal(obs.observeEnded(undefined), false);
  assert.equal(
    obs.observeSpawned({ runId: "run-1", childSessionKey: CHILD, label: "x".repeat(999) }),
    true,
  );
  assert.equal(obs.observeEnded({ targetSessionKey: CHILD, runId: "run-1", outcome: "ok" }), true);
  appendFileSync(obsFile, '{"torn"');
  const rows = obs.read();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label.length, 256);
  assert.deepEqual(createLifecycleObserver({ file: `${obsFile}.none` }).read(), []);
  assert.throws(() => createLifecycleObserver({}), TypeError);
});

test("observer stops appending at its size cap and marks truncation once", () => {
  const { obsFile } = setup();
  writeFileSync(obsFile, "x".repeat(1024 * 1024));
  const obs = createLifecycleObserver({ file: obsFile });
  assert.equal(obs.observeSpawned({ childSessionKey: CHILD }), false);
  assert.equal(obs.observeSpawned({ childSessionKey: CHILD }), false);
  assert.equal(readFileSync(obsFile, "utf8").split("truncated").length, 2);
  const bad = createLifecycleObserver({ file: path.join(obsFile, "nope", "x") });
  assert.equal(bad.observeSpawned({ childSessionKey: CHILD }), false);
});

test("reconcile reports a host-ended child the ledger never recorded, and mismatches", () => {
  const { ledger } = setup();
  const state = ledger.state();
  assert.deepEqual(reconcileObservations(state, []), []);
  assert.deepEqual(reconcileObservations(state, [{ kind: "spawned" }]), []);
  const spawned = {
    kind: "spawned",
    childSessionKey: CHILD,
    runId: "run-1",
    resolvedModel: "claude-sonnet-5-5",
    resolvedProvider: "anthropic",
  };
  assert.deepEqual(reconcileObservations(state, [spawned]), []);
  let f = reconcileObservations(state, [
    { ...spawned, runId: "other", resolvedModel: "gpt" },
    { kind: "ended", childSessionKey: CHILD, outcome: "ok" },
  ]);
  assert.deepEqual(
    f.map((x) => x.code),
    ["host-receipt-mismatch", "host-receipt-mismatch", "host-ended-unrecorded"],
  );
  assert.match(f[2].nextAction, /recordCompletion/);
  ledger.recordCompletion({ childSessionKey: CHILD, outcome: "ok" });
  const done = ledger.state();
  assert.deepEqual(
    reconcileObservations(done, [{ kind: "ended", childSessionKey: CHILD, outcome: "ok" }]),
    [],
  );
  assert.deepEqual(reconcileObservations(done, [{ kind: "ended", childSessionKey: CHILD }]), []);
  f = reconcileObservations(done, [{ kind: "ended", childSessionKey: CHILD, outcome: "timeout" }]);
  assert.equal(f[0].code, "host-outcome-mismatch");
});

test("plugin registers subagent hooks only with ledger.observe and the status tool reports findings", async () => {
  assert.throws(() => normalizeLedgerConfig({ file: "/a", observe: "yes" }), TypeError);
  assert.equal(normalizeLedgerConfig({ file: "/a" }).observe, false);
  const { file, obsFile } = setup();
  const hooks = {};
  const api = (ledger) => ({
    pluginConfig: { enabled: true, ledger },
    logger: {},
    on: (name, fn) => (hooks[name] = fn),
    registerTool() {},
    runtime: { subagent: {} },
  });
  plugin.register(api({ file }));
  assert.equal(hooks.subagent_spawned, undefined);
  plugin.register(api({ file, observe: true }));
  hooks.subagent_spawned({ runId: "run-1", childSessionKey: CHILD });
  hooks.subagent_ended({ targetSessionKey: CHILD, runId: "run-1", outcome: "ok" });
  const limits = normalizeLedgerConfig({ file, observe: true });
  const out = await createLedgerToolFactory({ limits })({ senderIsOwner: true }).execute("c", {});
  assert.deepEqual(
    out.details.hostObserved.map((x) => x.code),
    ["host-ended-unrecorded"],
  );
  const plain = await createLedgerToolFactory({ limits: normalizeLedgerConfig({ file }) })({
    senderIsOwner: true,
  }).execute("c", {});
  assert.equal(plain.details.hostObserved, null);
  assert.ok(obsFile);
});

test("observer log is owner-only, maps host outcomes, and reports truncation", async () => {
  const { statSync } = await import("node:fs");
  const { obsFile, ledger } = setup();
  const obs = createLifecycleObserver({ file: obsFile });
  obs.observeSpawned({ childSessionKey: CHILD, runId: "run-1" });
  assert.equal(statSync(obsFile).mode & 0o077, 0);
  obs.observeEnded({ targetSessionKey: CHILD, outcome: "killed" });
  ledger.recordCompletion({ childSessionKey: CHILD, outcome: "aborted" });
  assert.deepEqual(reconcileObservations(ledger.state(), obs.read()), []);
  const cut = reconcileObservations(ledger.state(), [{ kind: "truncated" }]);
  assert.equal(cut[0].code, "observations-truncated");
  const unknown = [{ kind: "ended", childSessionKey: CHILD, outcome: "mystery" }];
  assert.deepEqual(reconcileObservations(ledger.state(), unknown), []);
  assert.equal(obs.observeSpawned(null), false);
});
