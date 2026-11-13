#!/usr/bin/env node
// Local coordinator bridge: JSON request on stdin, JSON response on stdout.
// This bridge does not authenticate owner decisions or interact with host tools.
import { readFileSync } from "node:fs";
import { createTaskLedger } from "../src/task-ledger.js";

const methods = new Set([
  "declarePlan",
  "addTask",
  "recordCapability",
  "reserveDispatch",
  "recordReceipt",
  "recordQueued",
  "recordCompletion",
  "recordVerification",
  "recordDashboardSync",
  "recordPublisherFailure",
  "recordOwnerNudge",
  "resolveBlocker",
  "recover",
  "view",
  "integrity",
  "inspectLock",
]);
try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  if (!methods.has(request.method) || !Array.isArray(request.args))
    throw new TypeError("allowlisted method and args array required");
  if (Object.hasOwn(request, "providerAliases"))
    throw new TypeError("providerAliases cannot be supplied through the bridge");
  const ledger = createTaskLedger({ file: request.file });
  const result = ledger[request.method](...request.args);
  // State contains Maps; present the status view after mutations instead of serializing them.
  process.stdout.write(
    `${JSON.stringify({ ok: true, result: ["reserveDispatch", "recover", "view", "integrity", "inspectLock"].includes(request.method) ? (request.method === "recover" ? { flagged: result.flagged, view: ledger.view() } : result) : ledger.view() })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, code: error.code ?? "invalid-request", error: error.message })}\n`,
  );
  process.exitCode = 1;
}
