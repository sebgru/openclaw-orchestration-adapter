const GATE_TYPES = new Set([
  "tests",
  "lint",
  "build",
  "type",
  "security",
  "diff",
  "provenance",
  "approval",
  "custom",
]);
const OUTCOMES = new Set(["pass", "fail", "blocked", "waived"]);
const GATE_PHASES = new Set(["preflight", "completion"]);
const MAX_TEXT_LENGTH = 1_000;
const gateSets = new WeakMap();

function cleanText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT_LENGTH)
  );
}

function timestamp(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be a parseable timestamp`);
  }
  return { value, milliseconds: Date.parse(value) };
}

/** Declare required quality gates before execution; each pass sets its own evidence freshness bound. */
export function createGateSet(definitions, { declaredAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(definitions)) throw new TypeError("gates must be an array");
  const declared = timestamp(declaredAt, "declaredAt");
  const gates = new Map();
  for (const [index, definition] of definitions.entries()) {
    const field = `gates[${index}]`;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new TypeError(`${field} must be an object`);
    }
    const id = cleanText(definition.id, `${field}.id`);
    if (gates.has(id)) throw new TypeError(`duplicate gate ID: ${id}`);
    if (!GATE_TYPES.has(definition.type)) {
      throw new TypeError(`${field}.type must be a supported gate type`);
    }
    const phase = definition.phase ?? (definition.type === "approval" ? "preflight" : "completion");
    if (!GATE_PHASES.has(phase)) {
      throw new TypeError(`${field}.phase must be preflight or completion`);
    }
    if (!Number.isInteger(definition.maxEvidenceAgeMs) || definition.maxEvidenceAgeMs < 1) {
      throw new TypeError(`${field}.maxEvidenceAgeMs must be a positive integer`);
    }
    gates.set(id, {
      definition: Object.freeze({
        id,
        type: definition.type,
        phase,
        description: cleanText(definition.description, `${field}.description`),
        maxEvidenceAgeMs: definition.maxEvidenceAgeMs,
      }),
      status: "pending",
      outcome: null,
    });
  }
  const gateSet = Object.freeze({ declaredAt: declared.value });
  gateSets.set(gateSet, { declaredAtMs: declared.milliseconds, gates });
  return gateSet;
}

/** Record an observable pass, explicit failure/block, or rationale-bearing waiver. */
export function recordGateOutcome(
  gateSet,
  gateId,
  input,
  { recordedAt = new Date().toISOString() } = {},
) {
  const state = gateSets.get(gateSet);
  const entry = state?.gates.get(gateId);
  if (!entry) throw new TypeError(`unknown gate ID: ${gateId}`);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("gate outcome must be an object");
  }
  if (!OUTCOMES.has(input.status)) {
    throw new TypeError("gate status must be pass, fail, blocked, or waived");
  }
  const recorded = timestamp(recordedAt, "recordedAt");
  let outcome;
  if (input.status === "pass") {
    if (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence)) {
      throw new TypeError("passing gate requires evidence");
    }
    const observed = timestamp(input.evidence.observedAt, "evidence.observedAt");
    if (
      observed.milliseconds < state.declaredAtMs ||
      observed.milliseconds > recorded.milliseconds
    ) {
      throw new TypeError(
        "evidence.observedAt must be between gate declaration and outcome recording",
      );
    }
    outcome = Object.freeze({
      status: input.status,
      recordedAt: recorded.value,
      evidence: Object.freeze({
        summary: cleanText(input.evidence.summary, "evidence.summary"),
        source: cleanText(input.evidence.source, "evidence.source"),
        observedAt: observed.value,
      }),
    });
  } else if (input.status === "waived") {
    outcome = Object.freeze({
      status: input.status,
      recordedAt: recorded.value,
      rationale: cleanText(input.rationale, "rationale"),
      ...(input.waivedBy === undefined ? {} : { waivedBy: cleanText(input.waivedBy, "waivedBy") }),
    });
  } else {
    outcome = Object.freeze({
      status: input.status,
      recordedAt: recorded.value,
      reason: cleanText(input.reason, "reason"),
    });
  }
  entry.status = input.status;
  entry.outcome = outcome;
  return { ...entry };
}

/** Read-only completion assessment; a passed gate is valid only while its evidence is fresh. */
export function assessPlanCompletion(plan, { now = new Date().toISOString() } = {}) {
  const gateState = gateSets.get(plan?.gates);
  if (!gateState) throw new TypeError("plan must contain a gate set created by createGateSet");
  const nowTime = timestamp(now, "now");
  const unfinishedTasks = [...plan.tasks]
    .filter(([, entry]) => entry.state !== "succeeded")
    .map(([id]) => id);
  const gates = [...gateState.gates].map(([id, entry]) => {
    const outcome = entry.outcome;
    let valid = false;
    if (outcome?.status === "pass") {
      const ageMs = nowTime.milliseconds - Date.parse(outcome.evidence.observedAt);
      valid = ageMs >= 0 && ageMs <= entry.definition.maxEvidenceAgeMs;
    } else if (outcome?.status === "waived") {
      const ageMs = nowTime.milliseconds - Date.parse(outcome.recordedAt);
      valid =
        Boolean(outcome.rationale) && ageMs >= 0 && ageMs <= entry.definition.maxEvidenceAgeMs;
    }
    return {
      id,
      type: entry.definition.type,
      phase: entry.definition.phase,
      status: entry.status,
      valid,
      ...(outcome?.status === "pass" ? { evidence: outcome.evidence } : {}),
      ...(outcome?.status === "waived" ? { rationale: outcome.rationale } : {}),
      ...(outcome?.reason ? { reason: outcome.reason } : {}),
    };
  });
  const incompleteGates = gates.filter((gate) => !gate.valid).map((gate) => gate.id);
  const noGatesDeclared = gates.length === 0;
  return {
    complete: unfinishedTasks.length === 0 && incompleteGates.length === 0 && !noGatesDeclared,
    noGatesDeclared,
    unfinishedTasks,
    incompleteGates,
    gates,
  };
}

/** Require all preflight gates to pass with fresh evidence or carry an explicit waiver. */
export function assessPlanExecutionReadiness(plan, { now = new Date().toISOString() } = {}) {
  const gateState = gateSets.get(plan?.gates);
  if (!gateState) throw new TypeError("plan must contain a gate set created by createGateSet");
  const nowTime = timestamp(now, "now");
  const gates = [...gateState.gates]
    .filter(([, entry]) => entry.definition.phase === "preflight")
    .map(([id, entry]) => {
      const outcome = entry.outcome;
      let ready = false;
      if (outcome?.status === "pass") {
        const ageMs = nowTime.milliseconds - Date.parse(outcome.evidence.observedAt);
        ready = ageMs >= 0 && ageMs <= entry.definition.maxEvidenceAgeMs;
      } else if (outcome?.status === "waived") {
        const ageMs = nowTime.milliseconds - Date.parse(outcome.recordedAt);
        ready =
          Boolean(outcome.rationale) && ageMs >= 0 && ageMs <= entry.definition.maxEvidenceAgeMs;
      }
      return { id, status: entry.status, ready };
    });
  const blockedGates = gates.filter((gate) => !gate.ready).map((gate) => gate.id);
  return { ready: blockedGates.length === 0, blockedGates, gates };
}
