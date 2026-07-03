import { z } from "zod";
import {
  EXIT_OK,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failureFromRequestNotFoundAsUsage,
  readJsonObjectFile,
  render,
  resolveConversationContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type ConversationContext,
  type GlobalFlags,
} from "../shared";

/**
 * `cctl charter write --file charter.json` — submit the session's Alignment
 * charter (docs/design/cc-cli/02 §3.2). The charter is structured,
 * multi-paragraph markdown, so it is file-input only (no inline flags). The
 * submission lands as a draft in the existing Approve-Charter UI; approval stays
 * human-driven, so there is deliberately NO hint — this is terminal for the agent.
 */

const charterResponseSchema = z.object({
  status: z.enum(["draft_ready", "activated"]),
  version: z.number().nullable(),
});

export async function runCharter(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure("charter requires a subcommand: write", json);
  }
  if (sub === "write") {
    return runCharterWrite(rest.slice(1), flags, values, env, host);
  }
  return usageFailure(`unknown charter subcommand "${sub}"`, json);
}

async function runCharterWrite(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, ["file"], json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("charter write takes no positional arguments", json);
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure("charter write requires --file <charter.json>", json);
  }

  const file = await readJsonObjectFile(host, filePath, "charter", json);
  if (!file.ok) return file.result;

  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${alignmentPath(context)}/charter`,
    body: { ...file.value, conversationId: context.conversation },
  });
  if (result.kind !== "ok") {
    return failureFromRequestNotFoundAsUsage(result, json);
  }

  const parsed = charterResponseSchema.safeParse(result.body);
  const humanLine =
    parsed.success && parsed.data.status === "activated"
      ? `charter activated as version ${parsed.data.version}\n`
      : "charter draft submitted; pending the user's approval\n";

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanLine, {
      ok: true,
      ...(parsed.success ? { status: parsed.data.status } : {}),
    }),
    stderr: "",
  };
}

function alignmentPath(context: ConversationContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/alignment`;
}
