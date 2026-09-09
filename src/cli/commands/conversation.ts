import { z } from "zod";
import { compactionEnvelopeSchema } from "@/lib/context-artifacts/schemas";
import { compactionEnvelopeToMarkdown } from "@/lib/context-artifacts/render-markdown";
import { transcriptTruncationSchema } from "@/lib/conversations/transcript-render";
import {
  checkpointBoundaryLines,
  transcriptBoundariesSchema,
} from "@/lib/conversations/history-recovery";
import { dispatchGroup } from "../dispatch";
import { omissionSummary, pagedOmission } from "../disclosure";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  cliRequestText,
  encodePathSegment,
  failure,
  failureFromRequestNotFoundAsUsage,
  render,
  structuredErrorFields,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type GlobalFlags,
} from "../shared";
import {
  callerHeaders,
  conversationBasePath,
  isWrongScope404,
  resolveConversationCommandTarget,
  scopeMiss,
  withScopeResolution,
  type ConversationCommandTarget,
  type ScopeMiss,
} from "./conversation/target";
import {
  runConversationCheckpoint,
  runConversationCompactContext,
} from "./conversation/checkpoint";
import {
  runConversationEntry,
  runConversationImage,
} from "./conversation/evidence";

/**
 * `cctl conversation read|compact|compaction get|list` — windowed transcript
 * reads and compaction artifacts (docs/design/conversation-compaction §5.2,
 * §10). The CLI never parses transcript files locally; everything goes
 * through the read/context-artifact endpoints. The checkpoint and evidence
 * leaves live beside this module under `conversation/`, sharing its addressing.
 */

const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_ATTEMPTS = 300;

const INTEGER_PATTERN = /^\d+$/;

const readUnitSchema = z.object({
  ref: z.object({
    messageIndex: z.number().int(),
    seqStart: z.number().int(),
    seqEnd: z.number().int(),
  }),
  role: z.string(),
  timestamp: z.string(),
  lines: z.array(z.string()),
});
const readResponseSchema = z.object({
  totalMessages: z.number().int(),
  maxSeq: z.number().int(),
  units: z.array(readUnitSchema),
  truncated: z.boolean(),
  /**
   * What the window left out, by KIND of loss. Parsed rather than dropped
   * because these are the only coordinates that recover the evidence: a
   * generic "truncated" footer tells a reader something is missing and gives it
   * no way to get it, and the entry-export and next-sequence commands live
   * nowhere else.
   */
  truncation: transcriptTruncationSchema,
  boundaries: transcriptBoundariesSchema,
});

const artifactSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  messageIndex: z.number().int().nullable(),
  coveredStartSeq: z.number().int(),
  coveredEndSeq: z.number().int(),
  error: z.string().nullable().optional(),
  stale: z.boolean(),
  staleBehindMessages: z.number().int(),
  outdated: z.boolean(),
  updatedAt: z.string(),
});
const artifactListSchema = z.array(artifactSchema);
const pendingResponseSchema = z.object({
  artifactId: z.string(),
  status: z.literal("pending"),
});
const artifactEnvelopeResponseSchema = z.object({
  artifact: artifactSchema,
  hint: z.string().optional(),
});

function artifactsPath(target: ConversationCommandTarget): string {
  return `${conversationBasePath(target)}/context-artifacts`;
}

function compactCommand(
  target: ConversationCommandTarget,
  messageIndex?: number,
): string {
  const message =
    messageIndex === undefined ? "" : ` --message ${messageIndex}`;
  return `cctl conversation compact ${target.target.conversationId}${message}`;
}

/**
 * Map a failed request per the conversation-group contract: 404s are
 * disambiguated by the body `code` (both flavors are HTTP 404) — an absent
 * artifact is a real "no" (exit 1) with a create hint, while an unknown
 * conversation/project/session is a caller mistake (exit 2).
 */
function artifactRequestFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
  absentHint: string,
): CliResult {
  if (
    result.kind === "error" &&
    result.status === 404 &&
    result.code === "artifact_not_found"
  ) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: result.error,
      hint: absentHint,
      ...structuredErrorFields(result),
      json,
    });
  }
  return failureFromRequestNotFoundAsUsage(result, json);
}

export async function runConversation(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["conversation"],
    rest,
    json: flags.json,
    handlers: {
      read: (r) => runConversationRead(r, flags, values, env, host),
      compact: (r) => runConversationCompact(r, flags, values, env, host),
      "compact-context": (r) =>
        runConversationCompactContext(r, flags, values, env, host),
      compaction: (r) =>
        dispatchGroup({
          group: ["conversation", "compaction"],
          rest: r,
          json: flags.json,
          noun: "verb",
          handlers: {
            get: (rr) => runCompactionGet(rr, flags, values, env, host),
            list: (rr) => runCompactionList(rr, flags, values, env, host),
          },
        }),
      checkpoint: (r) => runConversationCheckpoint(r, flags, values, env, host),
      entry: (r) => runConversationEntry(r, flags, values, env, host),
      image: (r) => runConversationImage(r, flags, values, env, host),
    },
  });
}

interface ParsedPositional {
  id: string | undefined;
  extra: boolean;
}

function takeConversationPositional(rest: string[]): ParsedPositional {
  return { id: rest[0], extra: rest.length > 1 };
}

async function runConversationRead(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation read", json);
  if (denied) return denied;

  const { id, extra } = takeConversationPositional(rest);
  if (extra) {
    return usageFailure(
      "conversation read takes a single <conversation-id> argument",
      json,
    );
  }

  const format = values["format"] ?? "json";
  if (format !== "json" && format !== "markdown") {
    return usageFailure("--format must be json or markdown", json);
  }

  const resolved = await resolveConversationCommandTarget(id, flags, env, host);
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    readBody(target, values, format, host, json),
  );
}

async function readBody(
  target: ConversationCommandTarget,
  values: Record<string, string>,
  format: "json" | "markdown",
  host: CliHost,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  // Kebab-case CLI flags map to the endpoint's camelCase query params; the
  // server owns validation (400 → exit 2 with per-issue lines).
  const query = new URLSearchParams();
  if (values["outline"] !== undefined) query.set("outline", "true");
  if (values["message"] !== undefined) query.set("message", values["message"]);
  if (values["message-range"] !== undefined)
    query.set("messageRange", values["message-range"]);
  if (values["seq-range"] !== undefined)
    query.set("seqRange", values["seq-range"]);
  if (values["include-tools"] !== undefined)
    query.set("includeTools", values["include-tools"]);
  if (values["include-thinking"] !== undefined)
    query.set("includeThinking", "true");
  if (values["search"] !== undefined) query.set("search", values["search"]);
  if (values["max-bytes"] !== undefined)
    query.set("maxBytes", values["max-bytes"]);
  if (format === "markdown") query.set("format", "markdown");

  const queryString = query.toString();
  const path = `${conversationBasePath(target)}/read${queryString === "" ? "" : `?${queryString}`}`;
  const requestParams = {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path,
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  };

  if (format === "markdown") {
    const result = await cliRequestText(host, requestParams);
    if (result.kind !== "ok") {
      const failed = failureFromRequestNotFoundAsUsage(result, json);
      return isWrongScope404(result) ? scopeMiss(failed) : failed;
    }
    const outlineHint =
      values["outline"] !== undefined
        ? await outlineEscalationHint(target, host)
        : undefined;
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        result.text.endsWith("\n") ? result.text : `${result.text}\n`,
        {
          ok: true,
          markdown: result.text,
          ...(outlineHint ? { hint: outlineHint } : {}),
        },
      ),
      stderr: "",
    };
  }

  const result = await cliRequest(host, requestParams);
  if (result.kind !== "ok") {
    const failed = failureFromRequestNotFoundAsUsage(result, json);
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }
  const outlineHint =
    values["outline"] !== undefined
      ? await outlineEscalationHint(target, host)
      : undefined;

  const parsed = readResponseSchema.safeParse(result.body);
  const humanBody = parsed.success
    ? renderTranscriptHuman(parsed.data)
    : `${JSON.stringify(result.body, null, 2)}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      transcript: result.body,
      ...(outlineHint ? { hint: outlineHint } : {}),
    }),
    stderr: "",
  };
}

const OUTLINE_WINDOW_SYNTAX =
  "narrow with --message-range A:B / --seq-range A:B";

/**
 * The escalation hint after `--outline` steers by what actually exists: a
 * complete compaction is worth fetching, a pending one is worth checking,
 * and an absent one must be created first (a background LLM generation the
 * caller may not want) — advertising `compaction get` unconditionally sends
 * agents into a guaranteed exit-1.
 */
async function outlineEscalationHint(
  target: ConversationCommandTarget,
  host: CliHost,
): Promise<string> {
  const fetchHint = `${OUTLINE_WINDOW_SYNTAX}, or fetch the compaction: cctl conversation compaction get ${target.target.conversationId}`;

  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: artifactsPath(target),
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  });
  // The listing is advisory — never let it degrade a successful read.
  if (result.kind !== "ok") return fetchHint;
  const listed = artifactListSchema.safeParse(result.body);
  if (!listed.success) return fetchHint;

  const compactions = listed.data.filter(
    (row) => row.kind === "conversation_compaction",
  );
  if (compactions.some((row) => row.status === "complete")) return fetchHint;
  if (compactions.some((row) => row.status === "pending")) {
    return `${OUTLINE_WINDOW_SYNTAX}; a compaction is generating — check it with: cctl conversation compaction get ${target.target.conversationId}`;
  }
  return `${OUTLINE_WINDOW_SYNTAX}; no compaction exists — create one (background LLM generation) with: ${compactCommand(target)}`;
}

function renderTranscriptHuman(
  transcript: z.infer<typeof readResponseSchema>,
): string {
  if (transcript.units.length === 0) {
    if (transcript.truncated) {
      // The sentence below already says truncated, so the marker line is
      // suppressed and only the recovery coordinates are appended.
      const recovery = truncationLines(transcript.truncation, false);
      return `${[
        "no transcript units fit within --max-bytes (truncated — raise --max-bytes or narrow the window)",
        ...recovery,
      ].join("\n")}\n`;
    }
    // Teach the conversation's coordinate space: the observed failure mode is
    // windowing on [sN] seq markers with --message-range (or vice versa).
    const lastMessage = Math.max(0, transcript.totalMessages - 1);
    return `no matching transcript units — the conversation has ${transcript.totalMessages} messages (#0..#${lastMessage}) and seqs 0..${transcript.maxSeq}; [sN] markers are seq coordinates (--seq-range), #N headers are message indexes (--message-range)\n`;
  }
  const blocks = transcript.units.map((unit) => {
    const header = `#${unit.ref.messageIndex} [seq ${unit.ref.seqStart}-${unit.ref.seqEnd}] ${unit.role} ${unit.timestamp}`;
    return [header, ...unit.lines].join("\n");
  });
  const recovery = [
    ...checkpointBoundaryLines(transcript.boundaries),
    ...truncationLines(transcript.truncation, transcript.truncated),
  ];
  return `${blocks.join("\n\n")}${recovery.length === 0 ? "" : `\n\n${recovery.join("\n")}`}\n`;
}

/**
 * What a bounded read left out, and the exact command that recovers each kind.
 *
 * Three different losses, three different recoveries: entries the byte budget
 * never reached come back by reading their raw sequence range, while an entry
 * the cut landed inside and an entry the renderer shortened come back only by
 * exporting that entry complete — raising `--max-bytes` returns the same
 * excerpt. Saying "truncated" without distinguishing them sends a reader to the
 * wrong command.
 */
function truncationLines(
  truncation: z.infer<typeof transcriptTruncationSchema>,
  truncated: boolean,
): string[] {
  const lines: string[] = [];
  if (truncated) {
    lines.push("(truncated at --max-bytes)");
  }

  const omitted = truncation.omittedAfter;
  if (omitted !== null) {
    lines.push(
      `omitted after seq ${omitted.nextSeq}: ${omitted.unitCount} message(s) through seq ${omitted.lastSeq} — ${omitted.command}`,
    );
  }

  const partial = truncation.partialEntry;
  if (partial !== null) {
    lines.push(
      `partial entry seq ${partial.seq} (#${partial.messageIndex}, ${partial.elidedBytes} bytes elided) — ${partial.command}`,
    );
  }

  // The server's index is already capped, so its own overflow count and cursor
  // are what the accounting states — never a second cap applied here.
  const total =
    truncation.excerptedEntries.length + truncation.excerptedEntriesOmitted;
  if (total > 0) {
    const omission = pagedOmission({
      total,
      returned: truncation.excerptedEntries.length,
      reveal: truncation.excerptedEntriesNext?.command ?? null,
    });
    lines.push(
      `excerpted entries: ${omissionSummary(omission)}`,
      ...truncation.excerptedEntries.map(
        (entry) =>
          `  seq ${entry.seq} (#${entry.messageIndex}, ${entry.elidedBytes} bytes elided) — ${entry.command}`,
      ),
    );
  }
  return lines;
}

async function runConversationCompact(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation compact", json);
  if (denied) return denied;

  const { id, extra } = takeConversationPositional(rest);
  if (extra) {
    return usageFailure(
      "conversation compact takes a single <conversation-id> argument",
      json,
    );
  }

  const rawMessage = values["message"];
  if (rawMessage !== undefined && !INTEGER_PATTERN.test(rawMessage)) {
    return usageFailure("--message must be a non-negative integer", json);
  }
  const messageIndex =
    rawMessage === undefined ? undefined : Number(rawMessage);

  const resolved = await resolveConversationCommandTarget(id, flags, env, host);
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    compactBody(target, values, messageIndex, host, json),
  );
}

async function compactBody(
  target: ConversationCommandTarget,
  values: Record<string, string>,
  messageIndex: number | undefined,
  host: CliHost,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "POST",
    path: artifactsPath(target),
    body: {
      kind:
        messageIndex === undefined
          ? "conversation_compaction"
          : "message_compaction",
      mode: "create_or_refresh",
      ...(messageIndex === undefined ? {} : { messageIndex }),
      ...(values["force"] !== undefined ? { force: true } : {}),
      ...(target.callerConversationId === null
        ? {}
        : { callerConversationId: target.callerConversationId }),
    },
  });

  if (result.kind !== "ok") {
    const failed = failureFromRequestNotFoundAsUsage(result, json);
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }

  const fresh = artifactEnvelopeResponseSchema.safeParse(result.body);
  if (fresh.success) {
    // 200 — the artifact was already fresh (server-side coalescing / no-op).
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        `compaction already fresh (artifact ${fresh.data.artifact.id})\n`,
        {
          ok: true,
          artifact: extractArtifactBody(result.body),
          status: "fresh",
        },
      ),
      stderr: "",
    };
  }

  const pending = pendingResponseSchema.safeParse(result.body);
  if (!pending.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected compaction response from the server",
      json,
    });
  }

  if (values["wait"] === undefined) {
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        `compaction started (artifact ${pending.data.artifactId})\n`,
        {
          ok: true,
          artifactId: pending.data.artifactId,
          status: "pending",
          hint: `check status with: cctl conversation compaction get ${target.target.conversationId}${messageIndex === undefined ? "" : ` --message ${messageIndex}`}`,
        },
      ),
      stderr: "",
    };
  }

  return awaitArtifact(
    host,
    target,
    pending.data.artifactId,
    json,
    messageIndex,
  );
}

/** Poll the artifact until it leaves `pending` (bounded; instant in tests via host.sleep). */
async function awaitArtifact(
  host: CliHost,
  target: ConversationCommandTarget,
  artifactId: string,
  json: boolean,
  messageIndex: number | undefined,
): Promise<CliResult> {
  const path = `${artifactsPath(target)}/${encodePathSegment(artifactId)}`;
  const absentHint = `create with: ${compactCommand(target, messageIndex)}`;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await host.sleep(POLL_INTERVAL_MS);

    const result = await cliRequest(host, {
      server: target.server,
      token: target.token,
      tokenSource: target.tokenSource,
      method: "GET",
      path,
    });
    if (result.kind !== "ok") {
      return artifactRequestFailure(result, json, absentHint);
    }

    const parsed = artifactSchema.safeParse(result.body);
    if (!parsed.success) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: "unexpected artifact response from the server",
        json,
      });
    }
    if (parsed.data.status === "pending") continue;

    if (parsed.data.status === "failed") {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `compaction failed: ${parsed.data.error ?? "unknown error"}`,
        hint: `retry with: ${compactCommand(target, messageIndex)}`,
        json,
      });
    }
    return {
      exitCode: EXIT_OK,
      stdout: render(json, artifactSummaryLine(parsed.data, target), {
        ok: true,
        artifact: result.body,
      }),
      stderr: "",
    };
  }

  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message: `timed out waiting for compaction (artifact ${artifactId})`,
    hint: `check later with: cctl conversation compaction get ${target.target.conversationId}${messageIndex === undefined ? "" : ` --message ${messageIndex}`}`,
    json,
  });
}

function extractArtifactBody(body: unknown): unknown {
  return body && typeof body === "object" && "artifact" in body
    ? (body as { artifact: unknown }).artifact
    : body;
}

function artifactSummaryLine(
  artifact: z.infer<typeof artifactSchema>,
  target: ConversationCommandTarget,
): string {
  const freshness = artifact.outdated
    ? "outdated"
    : artifact.stale
      ? `stale (behind ${artifact.staleBehindMessages})`
      : "fresh";
  const message =
    artifact.messageIndex === null ? "" : ` message=${artifact.messageIndex}`;
  return `artifact ${artifact.id} ${artifact.kind}${message} status=${artifact.status} covered=${artifact.coveredStartSeq}..${artifact.coveredEndSeq} ${freshness} (conversation ${target.target.conversationId})\n`;
}

async function runCompactionGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation compaction get", json);
  if (denied) return denied;

  const { id, extra } = takeConversationPositional(rest);
  if (extra) {
    return usageFailure(
      "conversation compaction get takes a single <conversation-id> argument",
      json,
    );
  }

  const rawMessage = values["message"];
  if (rawMessage !== undefined && !INTEGER_PATTERN.test(rawMessage)) {
    return usageFailure("--message must be a non-negative integer", json);
  }
  const messageIndex =
    rawMessage === undefined ? undefined : Number(rawMessage);

  const format = values["format"] ?? "json";
  if (format !== "json" && format !== "markdown") {
    return usageFailure("--format must be json or markdown", json);
  }

  const resolved = await resolveConversationCommandTarget(id, flags, env, host);
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    compactionGetBody(target, messageIndex, format, host, json),
  );
}

async function compactionGetBody(
  target: ConversationCommandTarget,
  messageIndex: number | undefined,
  format: "json" | "markdown",
  host: CliHost,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const absentHint = `create with: ${compactCommand(target, messageIndex)}`;

  const listResult = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: artifactsPath(target),
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  });
  if (listResult.kind !== "ok") {
    const failed = artifactRequestFailure(listResult, json, absentHint);
    return isWrongScope404(listResult) ? scopeMiss(failed) : failed;
  }

  const listed = artifactListSchema.safeParse(listResult.body);
  const rows = listed.success ? listed.data : [];
  const wantedKind =
    messageIndex === undefined
      ? "conversation_compaction"
      : "message_compaction";
  const candidates = rows
    .filter(
      (row) =>
        row.kind === wantedKind &&
        (messageIndex === undefined || row.messageIndex === messageIndex),
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const chosen = candidates[0];
  if (chosen === undefined) {
    const what =
      messageIndex === undefined
        ? "no conversation compaction"
        : `no compaction for message ${messageIndex}`;
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `${what} for conversation ${target.target.conversationId}`,
      hint: absentHint,
      json,
    });
  }

  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: `${artifactsPath(target)}/${encodePathSegment(chosen.id)}`,
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  });
  if (result.kind !== "ok") {
    return artifactRequestFailure(result, json, absentHint);
  }

  const parsed = artifactSchema.safeParse(result.body);
  const hint = !parsed.success
    ? undefined
    : parsed.data.status === "failed"
      ? `retry with: ${compactCommand(target, messageIndex)}`
      : parsed.data.stale || parsed.data.outdated
        ? `refresh with: ${compactCommand(target, messageIndex)}`
        : undefined;

  const payload =
    result.body && typeof result.body === "object" && "payload" in result.body
      ? (result.body as { payload: unknown }).payload
      : null;

  if (format === "markdown" && parsed.success) {
    const envelope = compactionEnvelopeSchema.safeParse(payload);
    const markdown = envelope.success
      ? compactionEnvelopeToMarkdown(envelope.data, {
          stale: parsed.data.stale,
          staleBehindMessages: parsed.data.staleBehindMessages,
          outdated: parsed.data.outdated,
          updatedAt: parsed.data.updatedAt,
        })
      : `${artifactSummaryLine(parsed.data, target)}no renderable payload (status=${parsed.data.status})\n`;
    return {
      exitCode: EXIT_OK,
      stdout: render(json, markdown, {
        ok: true,
        markdown,
        ...(hint ? { hint } : {}),
      }),
      stderr: "",
    };
  }

  const humanBody = parsed.success
    ? `${artifactSummaryLine(parsed.data, target)}${payload === null ? "" : `${JSON.stringify(payload, null, 2)}\n`}`
    : `${JSON.stringify(result.body, null, 2)}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      artifact: result.body,
      ...(hint ? { hint } : {}),
    }),
    stderr: "",
  };
}

async function runCompactionList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation compaction list", json);
  if (denied) return denied;

  const { id, extra } = takeConversationPositional(rest);
  if (extra) {
    return usageFailure(
      "conversation compaction list takes a single <conversation-id> argument",
      json,
    );
  }

  const resolved = await resolveConversationCommandTarget(id, flags, env, host);
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    compactionListBody(target, host, json),
  );
}

async function compactionListBody(
  target: ConversationCommandTarget,
  host: CliHost,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: artifactsPath(target),
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  });
  if (result.kind !== "ok") {
    const failed = failureFromRequestNotFoundAsUsage(result, json);
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }

  const parsed = artifactListSchema.safeParse(result.body);
  const rows = parsed.success ? parsed.data : [];
  const humanBody =
    rows.length === 0
      ? `no compaction artifacts for conversation ${target.target.conversationId}\n`
      : `${rows.map((row) => artifactSummaryLine(row, target).trimEnd()).join("\n")}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      artifacts: result.body,
      hint: `fetch the full envelope with: cctl conversation compaction get ${target.target.conversationId}; create one with: ${compactCommand(target)}`,
    }),
    stderr: "",
  };
}
