import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

export const decisionsProposeSpec = {
  path: "decisions propose",
  summary: "Propose a decision batch for human review",
  description:
    "Submit a nonempty decisions array with statement and optional rationale/context. End the turn after submission; the full review arrives as the next user message.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
  payload: {
    maxBytes: bytes(256 * 1024),
    validatePath: "decisions propose-check",
  },
} as const;
export const charterWriteSpec = {
  path: "charter write",
  summary: "Submit the open Alignment charter draft",
  description:
    "Submit a JSON object with the full charter markdown in content. The server determines whether the draft awaits human approval or activates an approved decision update.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
  payload: { maxBytes: bytes(512 * 1024), validatePath: "charter write-check" },
} as const;

export const decisionsProposeCommand = ccCommands.defineCommand(
  decisionsProposeSpec,
  {
    examples: [
      {
        file: ".cc/temp/decisions.json",
        why: "Submit a proposed decision for review",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).decisionsHandler,
    }),
  },
);
export const charterWriteCommand = ccCommands.defineCommand(charterWriteSpec, {
  examples: [
    {
      file: ".cc/temp/charter.json",
      why: "Fill the authorized open charter draft",
    },
  ],
  handler: async () => ({
    default: (await import("./handlers")).charterHandler,
  }),
});
export const alignmentCommands = [
  decisionsProposeCommand,
  charterWriteCommand,
] as const;
export const alignmentGroups = [
  defineGroup({
    path: "decisions",
    summary: "Propose Alignment decisions",
    description: "Submit decisions for the user's asynchronous review.",
  }),
  defineGroup({
    path: "charter",
    summary: "Submit Alignment charter content",
    description: "Fill an open charter draft for this session.",
  }),
] as const;
