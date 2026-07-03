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
 * `cctl decisions propose --file decisions.json` — propose a non-blocking bulk
 * batch of decisions for the user's review (docs/design/cc-cli/02 §3.2). Payload
 * is structured (statement + optional rationale/context per decision), so it is
 * file-input only. The batch lands in the existing decision-review UI; approval
 * stays human-driven — terminal for the agent, so NO hint.
 */

const decisionsResponseSchema = z.object({
  batchId: z.string(),
  count: z.number(),
});

export async function runDecisions(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure("decisions requires a subcommand: propose", json);
  }
  if (sub === "propose") {
    return runDecisionsPropose(rest.slice(1), flags, values, env, host);
  }
  return usageFailure(`unknown decisions subcommand "${sub}"`, json);
}

async function runDecisionsPropose(
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
    return usageFailure(
      "decisions propose takes no positional arguments",
      json,
    );
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "decisions propose requires --file <decisions.json>",
      json,
    );
  }

  const file = await readJsonObjectFile(host, filePath, "decisions", json);
  if (!file.ok) return file.result;

  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${alignmentPath(context)}/decisions`,
    body: { ...file.value, conversationId: context.conversation },
  });
  if (result.kind !== "ok") {
    return failureFromRequestNotFoundAsUsage(result, json);
  }

  const parsed = decisionsResponseSchema.safeParse(result.body);
  const count = parsed.success ? parsed.data.count : null;
  const humanLine =
    count !== null
      ? `proposed ${count} decision${count === 1 ? "" : "s"} for the user's review\n`
      : "decisions proposed for the user's review\n";

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanLine, {
      ok: true,
      ...(parsed.success ? { batchId: parsed.data.batchId, count } : {}),
    }),
    stderr: "",
  };
}

function alignmentPath(context: ConversationContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/alignment`;
}
