/**
 * Notepad image routes — multipart upload on the collection, bytes on the item.
 *
 * The editor uploads a pasted image immediately and embeds only the returned id
 * as a token in the canonical text, so these two routes are what make that
 * token resolvable: the upload names the id, and the read serves the bytes with
 * a content type an `<img>` can render. Route shells under `src/app/api`
 * re-export the traced defaults; tests inject deps via the factory.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import type { ApiError } from "@/lib/api/errors";
import { createLogger, withTracing } from "@/lib/logging";
import { readBodyBounded } from "@/lib/shared/bounded-body";
import {
  jsonError,
  notFound,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import type { NotepadImageError, NotepadImageService } from "./image-service";
import {
  notepadErrorResponse,
  toNotepadValidationIssues,
  validationFailedResponse,
  type RouteContext,
} from "./route-handlers";
import { getNotepadImageService } from "./service-factory";

const logger = createLogger("notepads.images.routes");

/** Hard per-image cap; an oversized upload is refused with 413. */
export const MAX_NOTEPAD_IMAGE_BYTES = 20 * 1024 * 1024;

/** Declared-length precheck allowance for multipart framing overhead. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

export interface NotepadImageRouteDeps {
  /** Lazy so importing this module (route shells do) never opens the DB. */
  getImageService(): NotepadImageService;
  auth: AgentAuth;
}

export interface NotepadImageRouteHandlers {
  uploadPOST(request: Request, context: RouteContext): Promise<Response>;
  readGET(request: Request, context: RouteContext): Promise<Response>;
}

/**
 * The multipart `metadata` part. A pasted image arrives as an unnamed blob, so
 * the editor states the name and type it wants recorded; both fall back to the
 * file part's own naming when absent.
 */
const imageMetadataSchema = z
  .object({
    fileName: z.string().min(1).optional(),
    mediaType: z.string().min(1).optional(),
  })
  .strict();

const idParamSchema = z.string().min(1);

function missingIdParam(name: string): Response {
  return validationFailedResponse([
    { path: name, message: `a ${name} is required` },
  ]);
}

/**
 * The route segments, validated at the boundary. Unreachable via normal Next.js
 * routing (an empty segment never matches), but a direct handler call gets a
 * stated bad request rather than a not-found naming an empty id.
 */
async function resolveNotepadIdParam(
  context: RouteContext,
): Promise<RouteResolution<string>> {
  const parsed = idParamSchema.safeParse((await context.params)["notepadId"]);
  if (!parsed.success) {
    return { ok: false, response: missingIdParam("notepadId") };
  }
  return { ok: true, value: parsed.data };
}

async function resolveImageParams(
  context: RouteContext,
): Promise<RouteResolution<{ notepadId: string; imageId: string }>> {
  const notepadId = await resolveNotepadIdParam(context);
  if (!notepadId.ok) return notepadId;

  const parsed = idParamSchema.safeParse((await context.params)["imageId"]);
  if (!parsed.success) {
    return { ok: false, response: missingIdParam("imageId") };
  }
  return {
    ok: true,
    value: { notepadId: notepadId.value, imageId: parsed.data },
  };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The image refusals, delegating the shared notepad vocabulary to its mapper. */
export function notepadImageErrorResponse(error: NotepadImageError): Response {
  switch (error.code) {
    case "image_not_found":
      return notFound(
        error.message,
        error.code,
        { notepadId: error.notepadId, imageId: error.imageId },
        error.instruction,
        error.rationale,
      );
    case "image_unavailable":
      return jsonError(
        error.message,
        410,
        error.code,
        { notepadId: error.notepadId, imageId: error.imageId },
        error.instruction,
        error.rationale,
      );
    case "unsupported_media_type":
      return jsonError(
        error.message,
        415,
        error.code,
        { mediaType: error.mediaType },
        error.instruction,
        error.rationale,
      );
    default:
      return notepadErrorResponse(error);
  }
}

function payloadTooLargeResponse(sizeBytes: number): Response {
  return jsonError(
    `Image exceeds the ${MAX_NOTEPAD_IMAGE_BYTES}-byte upload limit`,
    413,
    "payload_too_large",
    { sizeBytes, maxBytes: MAX_NOTEPAD_IMAGE_BYTES },
    "Shrink or re-encode the image and upload it again.",
  );
}

function internalErrorResponse(): Response {
  return NextResponse.json(
    {
      error: "Notepad image operation failed",
      code: "internal_error",
    } satisfies ApiError,
    { status: 500 },
  );
}

// ---------------------------------------------------------------------------
// Multipart parsing
// ---------------------------------------------------------------------------

interface UploadedImage {
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

/**
 * Reads the upload as bounded bytes, then as multipart. The ceiling is enforced
 * three times over — declared length, streamed length, then the decoded file —
 * because each catches a case the next cannot: a lying header, an unbounded
 * stream, and a file that fits the envelope but not the cap.
 */
async function parseUpload(
  request: Request,
): Promise<RouteResolution<UploadedImage>> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_NOTEPAD_IMAGE_BYTES + MULTIPART_OVERHEAD_BYTES
  ) {
    logger.info("notepads.images.routes.upload_rejected_declared", {
      declaredLength,
    });
    return { ok: false, response: payloadTooLargeResponse(declaredLength) };
  }

  const bounded = await readBodyBounded(
    request.body,
    MAX_NOTEPAD_IMAGE_BYTES + MULTIPART_OVERHEAD_BYTES,
  );
  if (!bounded.ok) {
    logger.info("notepads.images.routes.upload_rejected_stream", {
      receivedBytes: bounded.receivedBytes,
    });
    return {
      ok: false,
      response: payloadTooLargeResponse(bounded.receivedBytes),
    };
  }

  let form: FormData;
  try {
    // The platform multipart parser runs over the already-bounded bytes;
    // a Response wrapper is the only fetch-spec surface that exposes it.
    form = await new Response(bounded.bytes, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return {
      ok: false,
      response: validationFailedResponse([
        { path: "", message: "request body must be multipart form data" },
      ]),
    };
  }

  const metadataRaw = form.get("metadata");
  let metadata: z.infer<typeof imageMetadataSchema> = {};
  if (metadataRaw !== null) {
    if (typeof metadataRaw !== "string") {
      return {
        ok: false,
        response: validationFailedResponse([
          { path: "metadata", message: "metadata part must be JSON text" },
        ]),
      };
    }
    let metadataJson: unknown;
    try {
      metadataJson = JSON.parse(metadataRaw);
    } catch {
      return {
        ok: false,
        response: validationFailedResponse([
          { path: "metadata", message: "metadata part must be JSON" },
        ]),
      };
    }
    const parsed = imageMetadataSchema.safeParse(metadataJson);
    if (!parsed.success) {
      return {
        ok: false,
        response: validationFailedResponse(
          toNotepadValidationIssues(parsed.error).map((issue) => ({
            ...issue,
            path: issue.path === "" ? "metadata" : `metadata.${issue.path}`,
          })),
        ),
      };
    }
    metadata = parsed.data;
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return {
      ok: false,
      response: validationFailedResponse([
        { path: "file", message: "file part is required" },
      ]),
    };
  }
  if (file.size > MAX_NOTEPAD_IMAGE_BYTES) {
    logger.info("notepads.images.routes.upload_rejected", {
      sizeBytes: file.size,
    });
    return { ok: false, response: payloadTooLargeResponse(file.size) };
  }

  return {
    ok: true,
    value: {
      fileName: metadata.fileName ?? file.name,
      mediaType: metadata.mediaType ?? file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNotepadImageRouteHandlers(
  deps: NotepadImageRouteDeps = defaultDeps(),
): NotepadImageRouteHandlers {
  /**
   * Image routes gate the token but key no author: an upload records no
   * revision. The write mode governs the text write that embeds the token, so
   * checking it here too would refuse in two places for one decision.
   */
  async function softGate(request: Request): Promise<Response | null> {
    const validation = await deps.auth.validateOptionalToken(request);
    if (validation.kind === "invalid") {
      return jsonError("Invalid Command Center API token", 401);
    }
    return null;
  }

  return {
    async uploadPOST(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const notepadId = await resolveNotepadIdParam(context);
      if (!notepadId.ok) return notepadId.response;

      const upload = await parseUpload(request);
      if (!upload.ok) return upload.response;

      try {
        const result = await deps.getImageService().add({
          notepadId: notepadId.value,
          fileName: upload.value.fileName,
          mediaType: upload.value.mediaType,
          bytes: upload.value.bytes,
        });
        if (!result.ok) return notepadImageErrorResponse(result.error);
        return NextResponse.json({ image: result.value }, { status: 201 });
      } catch (error) {
        logger.error("notepads.images.routes.upload_failed", {
          notepadId: notepadId.value,
          error: error instanceof Error ? error.message : String(error),
        });
        return internalErrorResponse();
      }
    },

    async readGET(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const ids = await resolveImageParams(context);
      if (!ids.ok) return ids.response;

      const result = await deps
        .getImageService()
        .read(ids.value.notepadId, ids.value.imageId);
      if (!result.ok) return notepadImageErrorResponse(result.error);

      const { image, bytes } = result.value;
      // The content store reads through `readFile`, whose view is only known to
      // be backed by an ArrayBufferLike; a response body must be ArrayBuffer-
      // backed, so the bytes are copied into one rather than cast into it.
      const body = new Uint8Array(bytes.byteLength);
      body.set(bytes);
      return new NextResponse(body, {
        headers: {
          "content-type": image.mediaType,
          "content-length": String(body.byteLength),
          // An image id addresses one immutable set of bytes: a notepad edit
          // that drops the token leaves the id unused rather than reassigned.
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    },
  };
}

function defaultDeps(): NotepadImageRouteDeps {
  return {
    getImageService: () => getNotepadImageService(),
    auth: createAgentAuth(),
  };
}

// ---------------------------------------------------------------------------
// Default traced exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _handlers = createNotepadImageRouteHandlers();
export const uploadNotepadImage = withTracing(_handlers.uploadPOST);
export const readNotepadImage = withTracing(_handlers.readGET);
