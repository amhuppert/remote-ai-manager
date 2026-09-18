import { commandsFor, defineErrors } from "cli-for-agents";
import type { ParsedFlags } from "cli-for-agents";
import type { CliEnv, CliHost } from "../transport";

export const ccErrors = defineErrors({
  CC_OPERATION_FAILED: {
    exitClass: "failed",
    description: "Command Center refused the operation.",
  },
  CC_USAGE: {
    exitClass: "usage",
    description: "The request needs corrected input or identity.",
  },
  CC_CONNECTION: {
    exitClass: "connection",
    description: "Command Center could not acknowledge the request.",
  },
  CC_BUILD_MISMATCH: {
    exitClass: "version",
    description: "The CLI and server belong to different builds.",
  },
  CC_INVALID_RESPONSE: {
    exitClass: "failed",
    description: "Command Center returned an invalid response.",
  },
});

export const ccGlobalFlags = {
  server: { description: "Command Center server URL", value: { kind: "url" } },
  token: {
    description: "API credential (otherwise CC_API_TOKEN or the token file)",
    value: { kind: "string" },
    secret: true,
  },
  project: { description: "Target project", value: { kind: "string" } },
  session: { description: "Target session", value: { kind: "string" } },
  conversation: {
    description: "Target conversation",
    value: { kind: "string" },
  },
} as const;

export interface CcApplication {
  readonly host: CliHost;
  readonly env: CliEnv;
  readonly laneReminderState?: unknown;
  readonly globals: ParsedFlags<typeof ccGlobalFlags>;
}

export interface CcContexts {
  cc: CcApplication;
}

export const ccCommands = commandsFor<CcContexts>()({
  errors: ccErrors,
  globalFlags: ccGlobalFlags,
});
