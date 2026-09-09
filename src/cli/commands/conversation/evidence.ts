/**
 * `cctl conversation entry get` and `cctl conversation image get` — bounded
 * retrieval of ORIGINAL conversation evidence (design §7; R7.2, R7.3, R8.3).
 *
 * These are the executable ends of the reader's follow-ups. A bounded
 * `conversation read` names the raw sequence it could not show and the image
 * handles an entry carries; these two leaves turn those coordinates into the
 * complete entry and the original bytes, without the caller ever supplying a
 * filesystem path — the archive owns where evidence lives.
 *
 * Both are reads with no model-context effect, so both keep the conversation
 * group's id-only scope resolution.
 *
 * The entry export is fetched in two parts on purpose. Its METADATA — sizes,
 * digest, thinking accounting, and the image handles with their ready-to-run
 * commands — is a small JSON projection, while the body is an unbounded stream
 * the server refuses to wrap in JSON. Reading the small half first means a
 * refusal costs one bounded response, and the body is fetched only for a
 * coordinate that exists.
 */

import { z } from "zod";

import { historyImageHandleSchema } from "@/lib/conversations/history-recovery";

import { dispatchGroup } from "../../dispatch";
import {
  artifactWriteFailure,
  emitBinary,
  renderBounded,
} from "../../disclosure";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  checkFlags,
  cliRequest,
  cliRequestBytes,
  cliRequestText,
  failure,
  failureFromRequest,
  render,
  structuredErrorFields,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type GlobalFlags,
} from "../../shared";
import {
  callerHeaders,
  conversationBasePath,
  isWrongScope404,
  resolveConversationCommandTarget,
  scopeMiss,
  withScopeResolution,
  type ConversationCommandTarget,
  type ScopeMiss,
} from "./target";

const NON_NEGATIVE_INTEGER = /^\d+$/;

const entryMetadataSchema = z.object({
  entry: z.object({
    conversationId: z.string(),
    seq: z.number().int(),
    kind: z.enum(["message", "tool_result"]),
    role: z.enum(["user", "assistant", "notice"]).nullable(),
    entryId: z.string().nullable(),
    timestamp: z.string().nullable(),
    messageIndex: z.number().int(),
    includeThinking: z.boolean(),
    thinkingOmitted: z.number().int(),
    bytes: z.number().int(),
    sha256: z.string(),
    images: z.array(historyImageHandleSchema),
  }),
});

type EntryMetadata = z.infer<typeof entryMetadataSchema>["entry"];

function historyPath(target: ConversationCommandTarget): string {
  return `${conversationBasePath(target)}/history`;
}

function requestParams(target: ConversationCommandTarget) {
  return {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  };
}

/**
 * A raw-sequence or block-index argument. Only a non-negative integer literal
 * is a coordinate, and the check is LOCAL — a caller who typed a message index
 * where a seq belongs, or a path where a block index belongs, learns it before
 * a request goes out (R8.9).
 */
function coordinate(
  raw: string | undefined,
  field: string,
  json: boolean,
): { ok: true; value: number } | { ok: false; result: CliResult } {
  if (raw === undefined || !NON_NEGATIVE_INTEGER.test(raw)) {
    return {
      ok: false,
      result: usageFailure(
        `<${field}> must be a non-negative integer (archive coordinates are raw line indexes, not #N message indexes)`,
        json,
      ),
    };
  }
  return { ok: true, value: Number(raw) };
}

/**
 * An archive refusal keeps its own vocabulary. A coordinate that addresses
 * nothing is the caller's mistake (exit 2); a real line the adapter cannot
 * project, or an asset the archive no longer holds, is a server "no" about a
 * real coordinate (exit 1) whose handle stays in the output.
 */
function archiveFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
  hint: string,
): CliResult {
  if (result.kind !== "error") return failureFromRequest(result, json);
  const usage =
    result.status === 400 ||
    result.code === "entry_not_found" ||
    result.code === "not_an_image_block" ||
    (result.status === 404 && result.code === undefined);
  return failure({
    exitCode: usage ? EXIT_USAGE : EXIT_OPERATION_FAILED,
    message: result.error,
    ...structuredErrorFields(result),
    hint,
    json,
  });
}

// ---------------------------------------------------------------------------
// entry get
// ---------------------------------------------------------------------------

export async function runConversationEntry(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["conversation", "entry"],
    rest,
    json: flags.json,
    noun: "verb",
    handlers: {
      get: (r) => runEntryGet(r, flags, values, env, host),
    },
  });
}

async function runEntryGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation entry get", json);
  if (denied) return denied;

  const [conversationId, rawSeq, ...extra] = rest;
  if (
    conversationId === undefined ||
    rawSeq === undefined ||
    extra.length > 0
  ) {
    return usageFailure(
      "conversation entry get takes <conversation-id> <seq>",
      json,
    );
  }
  const seq = coordinate(rawSeq, "seq", json);
  if (!seq.ok) return seq.result;
  const includeThinking = values["include-thinking"] !== undefined;

  const resolved = await resolveConversationCommandTarget(
    conversationId,
    flags,
    env,
    host,
  );
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    entryBody(host, target, seq.value, includeThinking, json),
  );
}

async function entryBody(
  host: CliHost,
  target: ConversationCommandTarget,
  seq: number,
  includeThinking: boolean,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const conversationId = target.target.conversationId;
  const query = includeThinking ? "&includeThinking=true" : "";
  const base = `${historyPath(target)}/entries/${seq}`;

  const metaResult = await cliRequest(host, {
    ...requestParams(target),
    method: "GET",
    path: `${base}?format=metadata${query}`,
  });
  if (metaResult.kind !== "ok") {
    const failed = archiveFailure(
      metaResult,
      json,
      `list the conversation's coordinates with: cctl conversation read ${conversationId} --outline`,
    );
    return isWrongScope404(metaResult) ? scopeMiss(failed) : failed;
  }
  const parsedMeta = entryMetadataSchema.safeParse(metaResult.body);
  if (!parsedMeta.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected archive entry response from the server",
      json,
    });
  }
  const entry = parsedMeta.data.entry;

  // The export streams as plain text: parsing it as JSON would corrupt a tool
  // result full of braces, so it comes back through the text transport.
  const bodyResult = await cliRequestText(host, {
    ...requestParams(target),
    method: "GET",
    path: `${base}${includeThinking ? "?includeThinking=true" : ""}`,
  });
  if (bodyResult.kind !== "ok") {
    return archiveFailure(
      bodyResult,
      json,
      `retry the export with: cctl conversation entry get ${conversationId} ${seq}`,
    );
  }
  const text = bodyResult.text;

  const humanBody = `${[
    ...entryHeaderLines(entry),
    ...entryImageLines(entry),
    "",
    text,
  ].join("\n")}\n`;

  return renderBounded(host, {
    command: "conversation entry get",
    json,
    humanBody,
    namePrefix: `entry-${conversationId}-${seq}`,
    envelope: {
      ok: true,
      entry,
      text,
      hint:
        entry.images.length > 0
          ? `this entry displays ${entry.images.length} image(s); fetch one with the command listed beside it`
          : entry.thinkingOmitted > 0
            ? `${entry.thinkingOmitted} thinking block(s) omitted — re-run with --include-thinking to include them`
            : undefined,
    },
  });
}

function entryHeaderLines(entry: EntryMetadata): string[] {
  return [
    `entry seq ${entry.seq}\tkind=${entry.kind}\trole=${entry.role ?? "-"}\tmessage #${entry.messageIndex}`,
    `timestamp: ${entry.timestamp ?? "-"}\tentryId: ${entry.entryId ?? "-"}`,
    `bytes: ${entry.bytes}\tsha256: ${entry.sha256}`,
    `thinking: ${entry.includeThinking ? "included" : `omitted (${entry.thinkingOmitted} block(s))`}`,
  ];
}

/**
 * One line per displayed image, each carrying the command the archive itself
 * built for it. A paired marker/reference is one image at the image-bearing
 * index, so counting blocks by eye would address the wrong one.
 */
function entryImageLines(entry: EntryMetadata): string[] {
  if (entry.images.length === 0) return ["images: none"];
  return [
    `images: ${entry.images.length}`,
    ...entry.images.map(
      (image) =>
        `  block ${image.contentBlockIndex}\t${image.mediaType}\t${image.storage}\t${image.command}`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// image get
// ---------------------------------------------------------------------------

export async function runConversationImage(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["conversation", "image"],
    rest,
    json: flags.json,
    noun: "verb",
    handlers: {
      get: (r) => runImageGet(r, flags, values, env, host),
    },
  });
}

async function runImageGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation image get", json);
  if (denied) return denied;

  const [conversationId, rawSeq, rawBlock, ...extra] = rest;
  if (
    conversationId === undefined ||
    rawSeq === undefined ||
    rawBlock === undefined ||
    extra.length > 0
  ) {
    return usageFailure(
      "conversation image get takes <conversation-id> <seq> <block-index>",
      json,
    );
  }
  const seq = coordinate(rawSeq, "seq", json);
  if (!seq.ok) return seq.result;
  const blockIndex = coordinate(rawBlock, "block-index", json);
  if (!blockIndex.ok) return blockIndex.result;

  const resolved = await resolveConversationCommandTarget(
    conversationId,
    flags,
    env,
    host,
  );
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    imageBody(host, target, seq.value, blockIndex.value, json),
  );
}

async function imageBody(
  host: CliHost,
  target: ConversationCommandTarget,
  seq: number,
  blockIndex: number,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const conversationId = target.target.conversationId;
  const result = await cliRequestBytes(host, {
    ...requestParams(target),
    method: "GET",
    path: `${historyPath(target)}/images/${seq}/${blockIndex}`,
  });
  if (result.kind !== "ok") {
    const failed = archiveFailure(
      result,
      json,
      `list this entry's image handles with: cctl conversation entry get ${conversationId} ${seq}`,
    );
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }

  const outcome = await emitBinary(host, result.bytes, {
    format: result.mediaType,
    namePrefix: `image-${conversationId}-${seq}-${blockIndex}`,
  });
  if (outcome.kind === "unwritable") {
    return artifactWriteFailure("conversation image get", outcome, json);
  }

  // The manifest's `format` is the media type the file was named from, so the
  // reported type and the extension on disk cannot disagree.
  const mediaType = outcome.manifest.format;
  const lines = [
    `image seq ${seq} block ${blockIndex}`,
    `media type: ${mediaType}`,
    `path: ${outcome.manifest.path}`,
    `bytes: ${outcome.manifest.bytes}`,
    `sha256: ${outcome.manifest.sha256}`,
  ];
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${lines.join("\n")}\n`, {
      ok: true,
      image: {
        conversationId,
        seq,
        contentBlockIndex: blockIndex,
        mediaType,
      },
      artifact: outcome.manifest,
      hint: `open ${outcome.manifest.path} with your image viewer`,
    }),
    stderr: "",
  };
}
