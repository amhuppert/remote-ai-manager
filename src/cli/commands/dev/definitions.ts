import { defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";
const serverName = {
  name: "server-name",
  description: "Configured dev server name",
  value: { kind: "string", minLength: 1 },
} as const;
export const devSpecs = {
  list: {
    path: "dev list",
    summary: "Read development server status",
    description:
      "Read current session or workflow-context servers, local URLs, errors, and log paths. Explicit project/session flags select the session target.",
    requires: "cc",
    effects: "read",
    args: [],
    flags: {},
  },
  ensure: {
    path: "dev ensure",
    summary: "Start a development server and await readiness",
    description:
      "Choose the sole configured server or supply its name. Wait up to 60 seconds for running status and retain log/error evidence after an accepted start.",
    requires: "cc",
    effects: "write",
    args: [{ ...serverName, required: false }],
    flags: {},
  },
  stop: {
    path: "dev stop",
    summary: "Stop an addressed development server",
    description:
      "Stop the named server in the current session or workflow context.",
    requires: "cc",
    effects: "write",
    args: [serverName],
    flags: {},
  },
  doctor: {
    path: "dev doctor",
    summary: "Compare managing and development CC instances",
    description:
      "Resolve the running worktree server and authenticate with its own token. Report build, CLI path, and config directory for both instances so verification targets the correct database.",
    requires: "cc",
    effects: "read",
    args: [{ ...serverName, required: false }],
    flags: {},
  },
} as const;
export const devListCommand = ccCommands.defineCommand(devSpecs.list, {
  examples: [{ why: "Read liveness, URLs, and logs" }],
  handler: async () => ({ default: (await import("./handlers")).listHandler }),
});
export const devEnsureCommand = ccCommands.defineCommand(devSpecs.ensure, {
  examples: [
    { why: "Start the sole configured server and wait for readiness" },
  ],
  handler: async () => ({
    default: (await import("./handlers")).ensureHandler,
  }),
});
export const devStopCommand = ccCommands.defineCommand(devSpecs.stop, {
  examples: [
    { args: { "server-name": "web" }, why: "Stop the addressed server" },
  ],
  handler: async () => ({ default: (await import("./handlers")).stopHandler }),
});
export const devDoctorCommand = ccCommands.defineCommand(devSpecs.doctor, {
  examples: [{ why: "Identify both CC instances before live verification" }],
  handler: async () => ({
    default: (await import("./handlers")).doctorHandler,
  }),
});
export const devCommands = [
  devListCommand,
  devEnsureCommand,
  devStopCommand,
  devDoctorCommand,
] as const;
export const devGroups = [
  defineGroup({
    path: "dev",
    summary: "Manage development servers",
    description:
      "Development servers serve the invoking session or workflow context's worktree. A CC development instance owns separate state; use dev doctor to identify it.",
  }),
] as const;
