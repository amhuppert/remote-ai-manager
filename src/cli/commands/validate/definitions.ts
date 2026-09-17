import { defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";
const runId = {
  name: "run-id",
  description: "Full validation run id from its receipt",
  value: { kind: "string", minLength: 1 },
} as const;
export const validateListSpec = {
  path: "validate list",
  summary: "List registered validation commands",
  description:
    "Read command scope support, costs, caller policy, and global capacity. Run registered checks through validate run.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
} as const;
export const validateStatusSpec = {
  path: "validate status",
  summary: "Read validation runs and results",
  description:
    "Without a run id, show active runs and capacity. With a run id, read its durable result without renewing the submitting command's lease.",
  requires: "cc",
  effects: "read",
  args: [{ ...runId, required: false }],
  flags: {},
} as const;
export const validateCancelSpec = {
  path: "validate cancel",
  summary: "Cancel a validation run you submitted",
  description:
    "Cancellation requires the private submitter lease saved on this machine. Reading another submitter's run does not grant cancellation authority.",
  requires: "cc",
  effects: "write",
  args: [runId],
  flags: {},
} as const;
export const validateRunSpec = {
  path: "validate run",
  summary: "Run a registered validation and await its verdict",
  description:
    "Submit a registered command and observe its durable run. Scoped file paths follow --. The command renews its private lease while waiting; interruption requests owned cancellation. A client timeout stops observation without a cancellation request; recover with validate status.",
  requires: "cc",
  effects: "write",
  args: [
    {
      name: "name",
      description: "Registered validation command",
      value: { kind: "string", minLength: 1 },
    },
  ],
  passthrough: true,
  flags: {
    scope: {
      description: "Changed files or the full registered check",
      value: { kind: "enum", values: ["changed", "full"] },
      default: "changed",
    },
    "queue-if-busy": {
      description: "Queue when capacity is occupied",
      value: { kind: "boolean" },
    },
    "require-match": {
      description: "Fail if a scoped pass matched zero files",
      value: { kind: "boolean" },
    },
    timeout: {
      description: "Client observation budget (default 2h)",
      value: {
        kind: "pattern",
        pattern: "^\\d+(ms|s|m|h)?$",
        description: "Duration such as 2h, 90s, or 500ms",
      },
      default: "2h",
    },
  },
} as const;
export const validateListCommand = ccCommands.defineCommand(validateListSpec, {
  examples: [{ why: "List registered checks" }],
  handler: async () => ({ default: (await import("./handlers")).listHandler }),
});
export const validateStatusCommand = ccCommands.defineCommand(
  validateStatusSpec,
  {
    examples: [
      {
        why: "Read or update the addressed resource",
        args: { "run-id": "run-one" },
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).statusHandler,
    }),
  },
);
export const validateCancelCommand = ccCommands.defineCommand(
  validateCancelSpec,
  {
    examples: [
      {
        why: "Read or update the addressed resource",
        args: { "run-id": "run-one" },
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).cancelHandler,
    }),
  },
);
export const validateRunCommand = ccCommands.defineCommand(validateRunSpec, {
  examples: [
    {
      args: { name: "test" },
      flags: { "queue-if-busy": true, "require-match": true },
      passthrough: ["src/example.test.ts"],
      why: "Run one registered scoped test and require a match",
    },
  ],
  handler: async () => ({ default: (await import("./handlers")).runHandler }),
});
export const validateCommands = [
  validateListCommand,
  validateStatusCommand,
  validateCancelCommand,
  validateRunCommand,
] as const;
export const validateGroups = [
  defineGroup({
    path: "validate",
    summary: "Run registered project checks",
    description:
      "Validation shares a global capacity budget. Scope and command policy are server-owned; queued work reports its durable run id.",
  }),
] as const;
