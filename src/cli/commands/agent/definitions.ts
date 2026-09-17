import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

const runId = {
  name: "run-id",
  description: "Agent run id from its launch receipt",
  value: { kind: "string", minLength: 1 },
} as const;
export const agentRunSpec = {
  path: "agent run",
  summary: "Start a one-shot agent run",
  description:
    "Run a prompt in the session worktree. The file names backend and prompt. Optional waiting observes the durable run; a wait timeout leaves it running. Recover with agent status or cancel explicitly.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {
    wait: {
      description: "Wait for the terminal run result",
      value: { kind: "boolean" },
    },
    timeout: {
      description: "Client wait budget (default 30m); requires --wait",
      value: {
        kind: "pattern",
        pattern: "^\\d+(ms|s|m|h)?$",
        description: "Duration such as 30m, 90s, or 500ms",
      },
    },
  },
  payload: { maxBytes: bytes(262_144), validatePath: "agent run-check" },
} as const;
export const agentStatusSpec = {
  path: "agent status",
  summary: "Read a durable agent run",
  description:
    "Read status, summary, references, and any failure. A successfully read failed run is data and exits successfully.",
  requires: "cc",
  effects: "read",
  args: [runId],
  flags: {},
} as const;
export const agentCancelSpec = {
  path: "agent cancel",
  summary: "Cancel a session agent run",
  description:
    "Request cancellation of the addressed run. Read agent status for its durable terminal state.",
  requires: "cc",
  effects: "write",
  args: [runId],
  flags: {},
} as const;
export const agentListSpec = {
  path: "agent list",
  summary: "List available agent profiles",
  description:
    "List builtin, global, and project profile metadata with quarantine diagnostics. Use agent get for instructions.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
} as const;
export const agentGetSpec = {
  path: "agent get",
  summary: "Read an agent profile",
  description:
    "Read a qualified builtin:, global:, or project: profile, including instructions and provenance.",
  requires: "cc",
  effects: "read",
  args: [
    {
      name: "profile",
      description: "Qualified profile reference",
      value: { kind: "string", minLength: 1 },
    },
  ],
  flags: {},
} as const;
export const agentRunCommand = ccCommands.defineCommand(agentRunSpec, {
  examples: [
    {
      file: ".cc/temp/prompt.json",
      flags: { wait: true },
      why: "Run a prompt and wait for its result",
    },
  ],
  handler: async () => ({ default: (await import("./handlers")).runHandler }),
});
export const agentStatusCommand = ccCommands.defineCommand(agentStatusSpec, {
  examples: [
    {
      why: "Read or update the addressed resource",
      args: { "run-id": "run-one" },
    },
  ],
  handler: async () => ({
    default: (await import("./handlers")).statusHandler,
  }),
});
export const agentCancelCommand = ccCommands.defineCommand(agentCancelSpec, {
  examples: [
    {
      why: "Read or update the addressed resource",
      args: { "run-id": "run-one" },
    },
  ],
  handler: async () => ({
    default: (await import("./handlers")).cancelHandler,
  }),
});
export const agentListCommand = ccCommands.defineCommand(agentListSpec, {
  examples: [{ why: "List available profiles" }],
  handler: async () => ({ default: (await import("./handlers")).listHandler }),
});
export const agentGetCommand = ccCommands.defineCommand(agentGetSpec, {
  examples: [{ why: "Read a profile", args: { profile: "builtin:default" } }],
  handler: async () => ({ default: (await import("./handlers")).getHandler }),
});
export const agentCommands = [
  agentRunCommand,
  agentStatusCommand,
  agentCancelCommand,
  agentListCommand,
  agentGetCommand,
] as const;
export const agentGroups = [
  defineGroup({
    path: "agent",
    summary: "Run agents and inspect profiles",
    description:
      "Agent runs belong to a session. The profile library is available to project and session conversations.",
  }),
] as const;
