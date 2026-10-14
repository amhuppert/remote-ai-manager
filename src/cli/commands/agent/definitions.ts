import { defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";
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
export const agentListCommand = ccCommands.defineCommand(agentListSpec, {
  examples: [{ why: "List available profiles" }],
  handler: async () => ({ default: (await import("./handlers")).listHandler }),
});
export const agentGetCommand = ccCommands.defineCommand(agentGetSpec, {
  examples: [{ why: "Read a profile", args: { profile: "builtin:default" } }],
  handler: async () => ({ default: (await import("./handlers")).getHandler }),
});
export const agentCommands = [agentListCommand, agentGetCommand] as const;
export const agentGroups = [
  defineGroup({
    path: "agent",
    summary: "Inspect agent profiles",
    description:
      "The profile library is available to project and session conversations.",
  }),
] as const;
