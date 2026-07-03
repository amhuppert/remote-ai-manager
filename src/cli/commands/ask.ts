import { z } from "zod";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequestNotFoundAsUsage,
  readJsonObjectFile,
  render,
  resolveConversationContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "../shared";

/**
 * `cctl ask` — register a question batch on this conversation and instruct the
 * agent to end its turn (docs/design/cc-cli/03 §2.1). The answer arrives as the
 * next user message, so the end-turn instruction is load-bearing protocol: it
 * is primary output in text mode and a dedicated `instruction` field with
 * --json — never a `hint` (doc 01 §6).
 *
 * Input is either `--file questions.json` (the askQuestionItemSchema batch
 * shape) or single-question sugar: `--question "…" --option a --option b
 * [--multi-select] [--header h] [--context c]`.
 */

const askResponseSchema = z.object({
  ok: z.literal(true),
  questionBatchId: z.string(),
});

const END_TURN_INSTRUCTION =
  "End your turn now with a brief handoff note (what you asked, what you'll do with the answer). " +
  "The answer will arrive as your next user message.";

export async function runAsk(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  lists: Record<string, string[]>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    ["file", "question", "option", "header", "context", "multi-select"],
    json,
  );
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("ask takes no positional arguments", json);
  }

  const filePath = values["file"];
  const questionText = values["question"];
  if (filePath !== undefined && questionText !== undefined) {
    return usageFailure("pass either --file or --question, not both", json);
  }

  let body: Record<string, unknown>;
  if (filePath !== undefined) {
    const file = await readJsonObjectFile(host, filePath, "questions", json);
    if (!file.ok) return file.result;
    body = file.value;
  } else if (questionText !== undefined) {
    const options = lists["option"] ?? [];
    if (options.length === 0) {
      return usageFailure("--question requires at least one --option", json);
    }
    body = {
      questions: [
        {
          question: questionText,
          ...(values["header"] !== undefined
            ? { header: values["header"] }
            : {}),
          ...(values["context"] !== undefined
            ? { context: values["context"] }
            : {}),
          options: options.map((label) => ({ label })),
          ...(values["multi-select"] !== undefined
            ? { multiSelect: true }
            : {}),
        },
      ],
    };
  } else {
    return usageFailure(
      "ask requires --file <questions.json> or --question with --option flags",
      json,
    );
  }

  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path:
      `/api/projects/${encodePathSegment(context.project)}` +
      `/sessions/${encodePathSegment(context.session)}` +
      `/conversations/${encodePathSegment(context.conversation)}/ask`,
    body,
  });
  if (result.kind !== "ok") {
    // A pending batch means the agent already asked this turn: surface the
    // pending id plus the same end-turn discipline as a success would.
    if (
      result.kind === "error" &&
      result.status === 409 &&
      result.error.includes("already pending")
    ) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: result.error,
        detail:
          "you already asked — end your turn; the answer will arrive as your next user message",
        json,
      });
    }
    return failureFromRequestNotFoundAsUsage(result, json);
  }

  const parsed = askResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected response from the ask endpoint",
      json,
    });
  }

  const { questionBatchId } = parsed.data;
  // Doc 03 §2.1: this text is printed exactly.
  const humanStdout =
    `Question batch ${questionBatchId} registered. The user has been notified.\n` +
    "End your turn now with a brief handoff note (what you asked, what you'll do with the answer).\n" +
    "The answer will arrive as your next user message.\n";

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanStdout, {
      ok: true,
      questionBatchId,
      instruction: END_TURN_INSTRUCTION,
    }),
    stderr: "",
  };
}
