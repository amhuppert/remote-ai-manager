import {
  invocation,
  recoveryFacts,
  runner,
  writeRunner,
  type Failure,
  type JsonData,
  type JsonValue,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import { compactionEnvelopeSchema } from "@/lib/context-artifacts/schemas";
import { compactionEnvelopeToMarkdown } from "@/lib/context-artifacts/render-markdown";
import {
  renderedTranscriptSchema,
  type RenderedTranscript,
} from "@/lib/conversations/transcript-render";
import { cliRequest, cliRequestText, encodePathSegment } from "../../transport";
import { ccErrors } from "../../framework/family";
import type { CcErrorCode } from "../../framework/context";
import { ccRequestFailure } from "../../framework/request";
import { observeJob } from "../../framework/observe-job";
import {
  compactCommand,
  compactionGetCommand,
  type readSpec,
  type compactSpec,
  type compactionGetSpec,
  type compactionListSpec,
} from "./definitions";
import {
  basePath,
  invalidResponse,
  mutationFailure,
  quoteEvidence,
  readInScope,
  requestParams,
  resolveTarget,
  scopeFlags,
  type Input,
  type Read,
  type Write,
  type NativeTarget,
} from "./native-target";

const artifactSchema = z.object({
  id: z.string().min(1),
  kind: z.string(),
  status: z.enum(["pending", "complete", "failed"]),
  messageIndex: z.number().int().nullable(),
  coveredStartSeq: z.number().int(),
  coveredEndSeq: z.number().int(),
  error: z.string().nullable().optional(),
  stale: z.boolean(),
  staleBehindMessages: z.number().int(),
  outdated: z.boolean(),
  updatedAt: z.string(),
  payload: z
    .json()
    .transform((value): JsonValue => value)
    .nullable()
    .optional(),
});
type Artifact = z.infer<typeof artifactSchema>;
const artifactListSchema = z.array(artifactSchema);
const pendingSchema = z.object({
  artifactId: z.string().min(1),
  status: z.literal("pending"),
});
const freshSchema = z.object({ artifact: artifactSchema });
const artifactsPath = (target: NativeTarget) =>
  `${basePath(target)}/context-artifacts`;
function getHint(
  target: NativeTarget,
  message: number | undefined,
  description = "Inspect compaction status and content",
) {
  return hint(
    invocation(compactionGetCommand, {
      args: { "conversation-id": target.target.conversationId },
      flags: {
        ...scopeFlags(target),
        ...(message === undefined ? {} : { message }),
      },
    }),
    description,
  );
}
function createHint(target: NativeTarget, message: number | undefined) {
  return hint(
    invocation(compactCommand, {
      args: { "conversation-id": target.target.conversationId },
      flags: {
        ...scopeFlags(target),
        ...(message === undefined ? {} : { message }),
      },
    }),
    "Generate or refresh this compaction (background LLM work)",
  );
}
function artifactText(artifact: JsonData<Artifact>): string {
  return `artifact ${artifact.id} ${artifact.kind} status=${artifact.status} covered=${artifact.coveredStartSeq}..${artifact.coveredEndSeq} ${artifact.outdated ? "outdated" : artifact.stale ? `stale (behind ${artifact.staleBehindMessages})` : "fresh"}${artifact.error ? `\n${quoteEvidence(artifact.error)}` : ""}`;
}
function transcriptText(
  data: JsonData<{ transcript?: RenderedTranscript; markdown?: string }>,
): string {
  if (data.markdown !== undefined) return `${quoteEvidence(data.markdown)}\n`;
  const transcript = data.transcript;
  if (!transcript) return "no transcript\n";
  const lines = transcript.units.flatMap((unit) => [
    `#${unit.ref.messageIndex} [seq ${unit.ref.seqStart}-${unit.ref.seqEnd}] ${unit.role} ${unit.timestamp}`,
    quoteEvidence(unit.lines.join("\n")),
    "",
  ]);
  if (lines.length === 0)
    lines.push(
      `${transcript.truncated ? "Transcript window truncated before a whole unit could be shown" : "no matching transcript units"} (${transcript.totalMessages} messages (#0..#${Math.max(0, transcript.totalMessages - 1)}); seqs 0..${transcript.maxSeq}); use --seq-range to choose another window${transcript.truncated ? " or --max-bytes to increase its budget" : ""}`,
    );
  const omitted = transcript.truncation.omittedAfter;
  if (omitted)
    lines.push(
      `Omitted ${omitted.unitCount} messages from seq ${omitted.nextSeq} through ${omitted.lastSeq} — ${omitted.command}`,
    );
  const partial = transcript.truncation.partialEntry;
  if (partial)
    lines.push(
      `Partial entry seq ${partial.seq}: ${partial.elidedBytes} bytes elided — ${partial.command}`,
    );
  for (const entry of transcript.truncation.excerptedEntries)
    lines.push(
      `Excerpted entry seq ${entry.seq}: ${entry.elidedBytes} bytes elided — ${entry.command}`,
    );
  if (transcript.truncation.excerptedEntriesNext)
    lines.push(
      `${transcript.truncation.excerptedEntriesOmitted} excerpted entries omitted — ${transcript.truncation.excerptedEntriesNext.command}`,
    );
  for (const boundary of transcript.boundaries.entries)
    lines.push(
      `Checkpoint ${boundary.operationId}: raw seq ${boundary.capturedThroughSeq} ${JSON.stringify(boundary)}`,
    );
  if (transcript.boundaries.indexCommand)
    lines.push(
      `${transcript.boundaries.totalInRange - transcript.boundaries.entries.length} checkpoint boundaries omitted — ${transcript.boundaries.indexCommand}`,
    );
  return `${lines.join("\n")}\n`;
}

export const readHandler: Read<typeof readSpec> = {
  run: runner<
    Input<typeof readSpec>,
    { transcript?: RenderedTranscript; markdown?: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const query = new URLSearchParams();
      const flags = ctx.flags;
      if (flags.outline) query.set("outline", "true");
      if (flags.message !== undefined)
        query.set("message", String(flags.message));
      if (flags["message-range"] !== undefined)
        query.set("messageRange", flags["message-range"]);
      if (flags["seq-range"] !== undefined)
        query.set("seqRange", flags["seq-range"]);
      if (flags["include-tools"] !== undefined)
        query.set("includeTools", flags["include-tools"]);
      if (flags["include-thinking"]) query.set("includeThinking", "true");
      if (flags.search !== undefined) query.set("search", flags.search);
      if (flags["max-bytes"] !== undefined)
        query.set("maxBytes", String(flags["max-bytes"]));
      if (flags.format === "markdown") query.set("format", "markdown");
      const path = (target: NativeTarget) =>
        `${basePath(target)}/read${query.size ? `?${query}` : ""}`;
      const result =
        flags.format === "markdown"
          ? await readInScope(app, ctx.args["conversation-id"], (target) =>
              cliRequestText(app.host, {
                ...requestParams(target),
                method: "GET",
                path: path(target),
              }),
            )
          : await readInScope(app, ctx.args["conversation-id"], (target) =>
              cliRequest(app.host, {
                ...requestParams(target),
                method: "GET",
                path: path(target),
              }),
            );
      if (!result.ok) return result;
      const value = result.value;
      const parsed =
        "body" in value ? renderedTranscriptSchema.safeParse(value.body) : null;
      if (parsed && !parsed.success) return invalidResponse("transcript");
      const data =
        "text" in value
          ? { markdown: value.text }
          : parsed?.success
            ? { transcript: parsed.data }
            : {};
      if (!flags.outline) return { ok: true, data };
      const listed = await cliRequest(app.host, {
        ...requestParams(result.target),
        method: "GET",
        path: artifactsPath(result.target),
      });
      const rows =
        listed.kind === "ok" ? artifactListSchema.safeParse(listed.body) : null;
      const exists =
        !rows?.success ||
        rows.data.some(
          (row) =>
            row.kind === "conversation_compaction" &&
            ["complete", "pending"].includes(row.status),
        );
      return {
        ok: true,
        data,
        hint: exists
          ? getHint(
              result.target,
              undefined,
              rows?.success && rows.data.some((row) => row.status === "pending")
                ? "A compaction is generating; inspect its status"
                : undefined,
            )
          : createHint(result.target, undefined),
      };
    },
    text: transcriptText,
  }),
};

export const compactionListHandler: Read<typeof compactionListSpec> = {
  run: runner<
    Input<typeof compactionListSpec>,
    { artifacts: Artifact[] },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const result = await readInScope(
        app,
        ctx.args["conversation-id"],
        (target) =>
          cliRequest(app.host, {
            ...requestParams(target),
            method: "GET",
            path: artifactsPath(target),
          }),
      );
      if (!result.ok) return result;
      const parsed = artifactListSchema.safeParse(result.value.body);
      return parsed.success
        ? {
            ok: true,
            data: { artifacts: parsed.data },
            hint: parsed.data.length
              ? getHint(
                  result.target,
                  parsed.data[0]?.messageIndex ?? undefined,
                )
              : createHint(result.target, undefined),
          }
        : invalidResponse("compaction list");
    },
    text: ({ artifacts }) =>
      artifacts.length
        ? `${artifacts.map(artifactText).join("\n")}\n`
        : "no compaction artifacts\n",
  }),
};

export const compactionGetHandler: Read<typeof compactionGetSpec> = {
  run: runner<
    Input<typeof compactionGetSpec>,
    { artifact: Artifact; markdown?: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const listed = await readInScope(
        app,
        ctx.args["conversation-id"],
        (target) =>
          cliRequest(app.host, {
            ...requestParams(target),
            method: "GET",
            path: artifactsPath(target),
          }),
      );
      if (!listed.ok) return listed;
      const parsedList = artifactListSchema.safeParse(listed.value.body);
      if (!parsedList.success) return invalidResponse("compaction list");
      const message = ctx.flags.message;
      const chosen = parsedList.data
        .filter(
          (row) =>
            row.kind ===
              (message === undefined
                ? "conversation_compaction"
                : "message_compaction") &&
            (message === undefined || row.messageIndex === message),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!chosen)
        return {
          ok: false,
          error: ccErrors.error("CC_OPERATION_FAILED", {
            message: "No matching compaction exists for this conversation.",
          }),
          hint: createHint(listed.target, message),
        };
      const response = await cliRequest(app.host, {
        ...requestParams(listed.target),
        method: "GET",
        path: `${artifactsPath(listed.target)}/${encodePathSegment(chosen.id)}`,
      });
      if (response.kind !== "ok") {
        if (
          response.kind === "error" &&
          response.code === "artifact_not_found"
        ) {
          const failure = ccRequestFailure(response, {
            errorCode: "CC_OPERATION_FAILED",
          });
          return failure.instruction
            ? failure
            : {
                ok: false,
                error: failure.error,
                hint: createHint(listed.target, message),
              };
        }
        return ccRequestFailure(response);
      }
      const parsed = artifactSchema.safeParse(response.body);
      if (!parsed.success) return invalidResponse("compaction artifact");
      const artifact = parsed.data;
      const payload = compactionEnvelopeSchema.safeParse(artifact.payload);
      const markdown =
        ctx.flags.format === "markdown"
          ? payload.success
            ? compactionEnvelopeToMarkdown(payload.data, artifact)
            : `${artifactText(artifact)}\nno renderable payload`
          : undefined;
      return {
        ok: true,
        data: { artifact, ...(markdown === undefined ? {} : { markdown }) },
        ...(artifact.status === "failed" || artifact.stale || artifact.outdated
          ? { hint: createHint(listed.target, message) }
          : {}),
      };
    },
    text: ({ artifact, markdown }) =>
      `${artifactText(artifact)}\n${markdown === undefined ? (artifact.payload === undefined ? "" : `${quoteEvidence(JSON.stringify(artifact.payload, null, 2))}\n`) : `${quoteEvidence(markdown)}\n`}`,
  }),
};

type CompactData = {
  artifact?: Artifact;
  artifactId?: string;
  status?: string;
};
export const compactHandler: Write<typeof compactSpec> = {
  run: writeRunner<Input<typeof compactSpec>, CompactData, CcErrorCode>({
    async run({ app, ctx }) {
      const resolved = await resolveTarget(app, ctx.args["conversation-id"]);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const target = resolved.value;
      const message = ctx.flags.message;
      const response = await cliRequest(app.host, {
        ...requestParams(target),
        method: "POST",
        path: artifactsPath(target),
        body: {
          kind:
            message === undefined
              ? "conversation_compaction"
              : "message_compaction",
          mode: "create_or_refresh",
          ...(message === undefined ? {} : { messageIndex: message }),
          ...(ctx.flags.force ? { force: true } : {}),
          ...(target.callerConversationId === null
            ? {}
            : { callerConversationId: target.callerConversationId }),
        },
      });
      const targetRecovery = recoveryFacts([
        { kind: "conversation", id: target.target.conversationId },
      ]);
      if (response.kind !== "ok")
        return mutationFailure(app, target, response, targetRecovery, (owner) =>
          invocation(compactCommand, {
            args: { "conversation-id": owner.target.conversationId },
            flags: { ...scopeFlags(owner), ...ctx.flags },
          }),
        );
      const fresh = freshSchema.safeParse(response.body);
      if (fresh.success)
        return {
          effect: "applied",
          recovery: recoveryFacts([
            { kind: "context-artifact", id: fresh.data.artifact.id },
          ]),
          result: {
            ok: true,
            data: { artifact: fresh.data.artifact, status: "fresh" },
          },
        };
      const pending = pendingSchema.safeParse(response.body);
      if (!pending.success)
        return {
          effect: "unknown",
          recovery: targetRecovery,
          result: invalidResponse("compaction start"),
        };
      const recovery = recoveryFacts([
        { kind: "context-artifact", id: pending.data.artifactId },
      ]);
      if (!ctx.flags.wait)
        return {
          effect: "applied",
          recovery,
          result: {
            ok: true,
            data: pending.data,
            hint: getHint(target, message),
          },
        };
      const observed = await observeJob<Artifact>({
        clock: ctx.clock,
        signal: ctx.signal,
        timeoutMs: 300_000,
        intervalMs: 1_000,
        async poll({ remainingMs }) {
          const result = await cliRequest(app.host, {
            ...requestParams(target),
            method: "GET",
            path: `${artifactsPath(target)}/${encodePathSegment(pending.data.artifactId)}`,
            timeoutMs: remainingMs,
          });
          if (result.kind !== "ok")
            return { kind: "failure", failure: ccRequestFailure(result) };
          const parsed = artifactSchema.safeParse(result.body);
          if (!parsed.success) return { kind: "invalid" };
          return parsed.data.status === "pending"
            ? { kind: "pending" }
            : { kind: "done", value: parsed.data };
        },
      });
      if (observed.kind === "done")
        return {
          effect: "applied",
          recovery,
          result:
            observed.value.status === "failed"
              ? {
                  ok: false,
                  data: { artifact: observed.value },
                  error: ccErrors.error("CC_OPERATION_FAILED", {
                    message:
                      "Compaction failed; inspect the artifact error for details.",
                  }),
                  hint: createHint(target, message),
                }
              : { ok: true, data: { artifact: observed.value } },
        };
      const failure: Failure<never, CcErrorCode> =
        observed.kind === "failure"
          ? observed.failure
          : {
              ok: false,
              error: ccErrors.error("CC_OPERATION_FAILED", {
                message: `Compaction observation ${observed.kind}; the server job remains independent.`,
                continuation: invocation(compactionGetCommand, {
                  args: { "conversation-id": target.target.conversationId },
                  flags: {
                    ...scopeFlags(target),
                    ...(message === undefined ? {} : { message }),
                  },
                }),
              }),
            };
      return {
        effect: "applied",
        recovery,
        result: { ...failure, data: pending.data },
      };
    },
    text: (data) =>
      data.artifact
        ? `${data.status === "fresh" ? `compaction already fresh (artifact ${data.artifact.id})\n` : ""}${artifactText(data.artifact)}\n`
        : `compaction ${data.status} (artifact ${data.artifactId})\n`,
  }),
};
