export const CANARY_TOOL_NAME = "orchestration_canary";
export const CANARY_RESULT = Object.freeze({ ok: true, canary: "orchestration-canary-v1" });

/**
 * Opt-in, plugin-owned worker canary. It takes no input, reads nothing, writes
 * nothing, and always returns the same constant, so a worker can prove that a
 * plugin-owned tool grant works end to end without any host side effect.
 */
export function createCanaryToolFactory() {
  return function canaryToolFactory() {
    return {
      name: CANARY_TOOL_NAME,
      label: "Orchestration canary",
      description:
        "Deterministic no-op canary. Takes no arguments and returns a fixed constant; use only to prove tool grants.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const details = { ...CANARY_RESULT };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    };
  };
}
