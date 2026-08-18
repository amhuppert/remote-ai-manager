import { z } from "zod";
import { dispatchGroup } from "../dispatch";
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
 * `cctl decisions propose --file decisions.json` — propose an asynchronous bulk
 * batch of decisions for the user's review (docs/design/cc-cli/02 §3.2).
 * Payload is structured (statement + optional rationale/context per decision),
 * so it is file-input only. The batch lands in the existing decision-review UI;
 * the proposing turn ends while approval stays human-driven.
 */

const decisionsResponseSchema = z.object({
  batchId: z.string(),
  count: z.number(),
});

const DECISION_REVIEW_INSTRUCTION =
  "Decision review is pending. Write a brief handoff note, then end your turn now; do not start new work. The complete decision review result will arrive as the next user message.";

export async function runDecisions(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["decisions"],
    rest,
    json: flags.json,
    handlers: {
      propose: (r) => runDecisionsPropose(r, flags, values, env, host),
    },
  });
}

async function runDecisionsPropose(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "decisions propose", json);
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
  const proposedLine =
    count !== null
      ? `proposed ${count} decision${count === 1 ? "" : "s"} for the user's review`
      : "decisions proposed for the user's review";
  const humanLine = `${proposedLine}\n${DECISION_REVIEW_INSTRUCTION}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanLine, {
      ok: true,
      ...(parsed.success ? { batchId: parsed.data.batchId, count } : {}),
      instruction: DECISION_REVIEW_INSTRUCTION,
    }),
    stderr: "",
  };
}

function alignmentPath(context: ConversationContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/alignment`;
}
