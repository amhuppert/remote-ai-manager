import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";
const project = {
  name: "project",
  description: "Project registered on the target dev instance",
  value: { kind: "string", minLength: 1 },
} as const;
const session = {
  name: "session-name",
  description: "Fixture session on the target instance",
  value: { kind: "string", minLength: 1 },
} as const;
const target = {
  target: {
    description: "Explicit dev instance URL; managing server is refused",
    value: { kind: "url" },
  },
  dev: {
    description: "Running dev server name when several are available",
    value: { kind: "string", minLength: 1 },
  },
} as const;
export const fixtureSpecs = {
  create: {
    path: "fixture session create",
    summary: "Create a session on the development instance",
    description:
      "Resolve the worktree dev instance and create actual test state there. Both lookup and target requests allow build skew and validate response schemas.",
    requires: "cc",
    effects: "write",
    args: [project],
    flags: {
      ...target,
      name: {
        description: "Fixture session name; defaults to a timestamp name",
        value: { kind: "string", minLength: 1 },
      },
      "skip-warm": {
        description: "Skip best-effort destination prewarming",
        value: { kind: "boolean" },
      },
    },
  },
  delete: {
    path: "fixture session delete",
    summary: "Delete a development fixture session",
    description:
      "Delete the addressed session on the resolved dev instance and report whether its worktree was removed.",
    requires: "cc",
    effects: "write",
    args: [project, session],
    flags: target,
  },
  prompt: {
    path: "fixture prompt",
    summary: "Run a prompt in a development fixture",
    description:
      "Use an explicitly named target conversation or the sole unarchived target conversation. The managing conversation is never inferred as the fixture target. Wait observes SSE completion and preserves forensic paths on failure.",
    requires: "cc",
    effects: "write",
    args: [project, session],
    flags: {
      ...target,
      text: {
        description: "Prompt prose",
        value: { kind: "string" },
        required: true,
        fileSource: { maxBytes: bytes(1_048_576) },
      },
      wait: {
        description: "Wait for the stream's terminal outcome",
        value: { kind: "boolean" },
      },
      timeout: {
        description:
          "Observation timeout in seconds; the server turn continues",
        value: {
          kind: "pattern",
          pattern: "^(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$",
          description: "Nonnegative seconds",
        },
      },
    },
  },
  status: {
    path: "fixture status",
    summary: "Read fixture conversation state",
    description:
      "Read statuses from the target dev instance and reject incompatible response shapes.",
    requires: "cc",
    effects: "read",
    args: [project, session],
    flags: target,
  },
} as const;
export const fixtureCreateCommand = ccCommands.defineCommand(
  fixtureSpecs.create,
  {
    examples: [
      {
        args: { project: "scratch" },
        flags: { name: "fx-check" },
        why: "Create isolated verification state",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).createHandler,
    }),
  },
);
export const fixtureDeleteCommand = ccCommands.defineCommand(
  fixtureSpecs.delete,
  {
    examples: [
      {
        args: { project: "scratch", "session-name": "fx-check" },
        why: "Remove verification state",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).deleteHandler,
    }),
  },
);
export const fixturePromptCommand = ccCommands.defineCommand(
  fixtureSpecs.prompt,
  {
    examples: [
      {
        args: { project: "scratch", "session-name": "fx-check" },
        flags: { "text-file": ".cc/temp/prompt.md", wait: true },
        why: "Run a literal verification prompt",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).promptHandler,
    }),
  },
);
export const fixtureStatusCommand = ccCommands.defineCommand(
  fixtureSpecs.status,
  {
    examples: [
      {
        args: { project: "scratch", "session-name": "fx-check" },
        why: "Read fixture state",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).statusHandler,
    }),
  },
);
export const fixtureCommands = [
  fixtureCreateCommand,
  fixtureDeleteCommand,
  fixturePromptCommand,
  fixtureStatusCommand,
] as const;
export const fixtureGroups = [
  defineGroup({
    path: "fixture",
    summary: "Create test state on the dev instance",
    description:
      "Fixtures resolve the worktree development server, which has its own database and transcripts. The managing CC instance is refused as an explicit target.",
  }),
  defineGroup({
    path: "fixture session",
    summary: "Create and delete fixture sessions",
    description:
      "Session lifecycle operations target only the selected development instance.",
  }),
] as const;
