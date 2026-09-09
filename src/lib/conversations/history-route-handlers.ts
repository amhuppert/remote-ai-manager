/**
 * Scoped evidence-retrieval endpoints: one complete archive entry, and the
 * original bytes of one image that entry displays (design §7, §8).
 *
 * Both leaves serve the two conversation route families from one handler core,
 * so a project conversation reaches exactly the resources a session
 * conversation does at its own address. The archive stays the authority: a
 * caller addresses evidence by ORIGINAL coordinate — raw sequence, and for an
 * image the image-bearing content-block index — and the server resolves where
 * the bytes are. No request carries a filesystem path, and no response echoes
 * one.
 *
 * The entry export is STREAMED. A single archive entry can be tens of
 * megabytes (an oversized tool result is an ordinary day), so the bounded
 * reader's job is to excerpt and name the recovery command, and this route's
 * job is to hand over the exact bytes without a presentation cap. The bounded
 * half of the same resource — sizes, hash, image handles — is a separate
 * `format=metadata` projection that never carries the body, so nothing here
 * collects an unbounded entry into a JSON response.
 *
 * Reading is all this does: retrieving evidence has no model-context effect,
 * which `history-no-send.arch.test.ts` enforces structurally over this module.
 */

import { NextResponse } from "next/server";

import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import {
  createHistoryEntryService,
  historyEntryTextStream,
  type HistoryEntry,
  type HistoryEntryRefusalCode,
  type HistoryEntryService,
} from "@/lib/conversations/history-entry-service";
import {
  createHistoryImageService,
  type HistoryImageRefusalCode,
  type HistoryImageService,
} from "@/lib/conversations/history-image-service";
import {
  resolveProjectScopedConversation,
  resolveSessionScopedConversation,
  type ScopedConversationRouteDeps,
  type ScopedConversationTarget,
} from "@/lib/conversations/scoped-route-target";
import { createLogger, withTracing, type Logger } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { jsonError } from "@/lib/shared/route-resolution";
import { getProjectConversation, getSession } from "@/lib/state-store";

const logger = createLogger("conversation-history");

type RouteContext = { params: Promise<Record<string, string>> };

export interface HistoryRouteDeps extends ScopedConversationRouteDeps {
  entryService: HistoryEntryService;
  imageService: HistoryImageService;
  auth: AgentAuth;
  log?: Logger;
}

function defaultDeps(): HistoryRouteDeps {
  return {
    resolveProjectPath,
    getSession,
    getProjectConversation,
    entryService: createHistoryEntryService(),
    imageService: createHistoryImageService(),
    auth: createAgentAuth(),
  };
}

interface QueryIssue {
  path: string;
  message: string;
}

const NON_NEGATIVE_INTEGER = /^\d+$/;

function invalidCoordinate(issues: QueryIssue[]): Response {
  return NextResponse.json(
    {
      error: "Invalid archive coordinate",
      code: "invalid_archive_coordinate",
      details: { issues },
      issues,
    },
    { status: 400 },
  );
}

/**
 * A raw-sequence or block-index path segment. Only a non-negative integer
 * literal is a coordinate: anything else — a path, a range, a negative — is
 * refused here rather than coerced, so a caller cannot spell its way past the
 * archive's own addressing.
 */
function parseCoordinate(
  raw: string | undefined,
  field: string,
): { ok: true; value: number } | { ok: false; response: Response } {
  if (raw === undefined || !NON_NEGATIVE_INTEGER.test(raw)) {
    return {
      ok: false,
      response: invalidCoordinate([
        { path: field, message: "expected a non-negative integer" },
      ]),
    };
  }
  return { ok: true, value: Number(raw) };
}

function parseIncludeThinking(
  url: string,
): { ok: true; value: boolean } | { ok: false; response: Response } {
  const raw = new URL(url).searchParams.get("includeThinking");
  if (raw === null) return { ok: true, value: false };
  if (raw === "true" || raw === "1") return { ok: true, value: true };
  if (raw === "false" || raw === "0") return { ok: true, value: false };
  return {
    ok: false,
    response: invalidCoordinate([
      { path: "includeThinking", message: "expected true or false" },
    ]),
  };
}

/**
 * `entry_not_found` is a missing coordinate; `entry_unsupported` is a real
 * archive line the adapter does not project as a readable entry, which no
 * retry of the same coordinate can change.
 */
function entryRefusalStatus(code: HistoryEntryRefusalCode): number {
  return code === "entry_not_found" ? 404 : 422;
}

/**
 * A block index that addresses no image is a malformed coordinate (400); an
 * unservable recorded media type is unprocessable (422); everything else means
 * the archive owns no bytes at that coordinate to serve (404) — including a
 * recorded path that escapes the image root, which is refused rather than read.
 */
function imageRefusalStatus(code: HistoryImageRefusalCode): number {
  switch (code) {
    case "not_an_image_block":
      return 400;
    case "unsupported_media_type":
      return 422;
    default:
      return 404;
  }
}

/** The bounded half of an entry: everything except the exported body. */
function entryMetadata(entry: HistoryEntry) {
  const { lines: _lines, ...metadata } = entry;
  return metadata;
}

export function createHistoryRouteHandlers(
  deps: HistoryRouteDeps = defaultDeps(),
) {
  const log = deps.log ?? logger;

  async function serveEntry(
    request: Request,
    target: ScopedConversationTarget,
    rawSeq: string | undefined,
  ): Promise<Response> {
    const seq = parseCoordinate(rawSeq, "seq");
    if (!seq.ok) return seq.response;
    const includeThinking = parseIncludeThinking(request.url);
    if (!includeThinking.ok) return includeThinking.response;

    const result = await deps.entryService.getEntry({
      conversationId: target.target.conversationId,
      transcriptPath: target.conversation.transcriptPath,
      seq: seq.value,
      includeThinking: includeThinking.value,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.reason, code: result.code, seq: result.seq },
        { status: entryRefusalStatus(result.code) },
      );
    }

    const entry = result.entry;
    log.info("history.entry.served", {
      conversationId: target.target.conversationId,
      scope: target.target.scope,
      seq: entry.seq,
      bytes: entry.bytes,
      includeThinking: entry.includeThinking,
      thinkingOmitted: entry.thinkingOmitted,
      imageCount: entry.images.length,
    });

    if (new URL(request.url).searchParams.get("format") === "metadata") {
      return NextResponse.json({ entry: entryMetadata(entry) });
    }

    // Streamed, not collected: the export leaves the process a line at a time,
    // and the measurements travel in headers so the body stays exactly the
    // entry's own bytes.
    return new Response(historyEntryTextStream(entry), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-cc-entry-seq": String(entry.seq),
        "x-cc-entry-kind": entry.kind,
        "x-cc-entry-message-index": String(entry.messageIndex),
        "x-cc-entry-bytes": String(entry.bytes),
        "x-cc-entry-sha256": entry.sha256,
        "x-cc-entry-include-thinking": String(entry.includeThinking),
        "x-cc-entry-thinking-omitted": String(entry.thinkingOmitted),
        "x-cc-entry-image-count": String(entry.images.length),
      },
    });
  }

  async function serveImage(
    _request: Request,
    target: ScopedConversationTarget,
    rawSeq: string | undefined,
    rawBlockIndex: string | undefined,
  ): Promise<Response> {
    const seq = parseCoordinate(rawSeq, "seq");
    if (!seq.ok) return seq.response;
    const blockIndex = parseCoordinate(rawBlockIndex, "blockIndex");
    if (!blockIndex.ok) return blockIndex.response;

    const result = await deps.imageService.getImage({
      conversationId: target.target.conversationId,
      transcriptPath: target.conversation.transcriptPath,
      seq: seq.value,
      contentBlockIndex: blockIndex.value,
    });
    if (!result.ok) {
      // The handle survives the refusal — the coordinate is still the
      // evidence — while the recorded filesystem path never leaves the server.
      return NextResponse.json(
        {
          error: result.reason,
          code: result.code,
          requested: result.requested,
          handle: result.handle,
        },
        { status: imageRefusalStatus(result.code) },
      );
    }

    const image = result.image;
    return new Response(new Uint8Array(image.bytes), {
      status: 200,
      headers: {
        "content-type": image.mediaType,
        "content-length": String(image.byteLength),
        "content-disposition": "inline",
        "x-cc-image-seq": String(image.handle.seq),
        "x-cc-image-block-index": String(image.handle.contentBlockIndex),
        "x-cc-image-storage": image.handle.storage,
        "x-cc-image-sha256": image.sha256,
        "x-cc-image-command": image.handle.command,
      },
    });
  }

  type Resolve = (
    deps: ScopedConversationRouteDeps,
    context: RouteContext,
  ) => Promise<
    | { ok: true; value: ScopedConversationTarget }
    | { ok: false; response: Response }
  >;

  async function checkOptionalToken(
    request: Request,
  ): Promise<Response | null> {
    const validation = await deps.auth.validateOptionalToken(request);
    return validation.kind === "invalid"
      ? jsonError("Invalid Command Center API token", 401)
      : null;
  }

  function entryHandler(resolve: Resolve) {
    return async (
      request: Request,
      context: RouteContext,
    ): Promise<Response> => {
      const denied = await checkOptionalToken(request);
      if (denied) return denied;
      const target = await resolve(deps, context);
      if (!target.ok) return target.response;
      const params = await context.params;
      return serveEntry(request, target.value, params["seq"]);
    };
  }

  function imageHandler(resolve: Resolve) {
    return async (
      request: Request,
      context: RouteContext,
    ): Promise<Response> => {
      const denied = await checkOptionalToken(request);
      if (denied) return denied;
      const target = await resolve(deps, context);
      if (!target.ok) return target.response;
      const params = await context.params;
      return serveImage(
        request,
        target.value,
        params["seq"],
        params["blockIndex"],
      );
    };
  }

  return {
    sessionEntry: entryHandler(resolveSessionScopedConversation),
    sessionImage: imageHandler(resolveSessionScopedConversation),
    projectEntry: entryHandler(resolveProjectScopedConversation),
    projectImage: imageHandler(resolveProjectScopedConversation),
  };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

let _handlers: ReturnType<typeof createHistoryRouteHandlers> | null = null;
function handlers(): ReturnType<typeof createHistoryRouteHandlers> {
  _handlers ??= createHistoryRouteHandlers();
  return _handlers;
}

function shell(
  select: (
    all: ReturnType<typeof createHistoryRouteHandlers>,
  ) => (request: Request, context: RouteContext) => Promise<Response>,
) {
  return withTracing((request: Request, context: RouteContext) =>
    select(handlers())(request, context),
  );
}

export const getSessionConversationHistoryEntry = shell((h) => h.sessionEntry);
export const getSessionConversationHistoryImage = shell((h) => h.sessionImage);
export const getProjectConversationHistoryEntry = shell((h) => h.projectEntry);
export const getProjectConversationHistoryImage = shell((h) => h.projectImage);
