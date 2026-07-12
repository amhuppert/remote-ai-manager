/**
 * Attachment route handlers — index/add on the collection, resolve/edit/remove
 * by attachment id. File adds arrive as multipart form data (Zod-validated
 * `metadata` part + `file` part); every other kind is JSON. Route shells under
 * `src/app/api` re-export the traced default handlers; tests inject deps via
 * `createTicketAttachmentRouteHandlers`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { ApiError } from "@/lib/api/errors";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { createLogger, withTracing } from "@/lib/logging";
import {
  addTicketAttachmentPayloadInputSchema,
  attachmentServiceIdentitySchema,
  updateTicketAttachmentServiceInputSchema,
  type TicketAttachmentService,
} from "./attachment-service";
import {
  jsonBodyOrNull,
  resolveIdentity,
  ticketErrorResponse,
  ticketResponse,
  validationFailedResponse,
  type RouteContext,
} from "./route-handlers";
import { toTicketValidationIssues } from "./service";
import {
  getTicketAttachmentService,
  getTicketService,
} from "./service-factory";
import type { TicketService } from "./service";

const logger = createLogger("tickets.attachments.routes");

/** Hard per-file cap; oversized uploads are rejected with 413. */
export const MAX_TICKET_FILE_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Declared-length precheck allowance for multipart framing overhead. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

export interface TicketAttachmentRouteDeps {
  /** Lazy so importing this module (route shells do) never opens the DB. */
  getTicketService(): TicketService;
  getAttachmentService(): TicketAttachmentService;
  auth: AgentAuth;
}

export interface TicketAttachmentRouteHandlers {
  indexGET(request: Request, context: RouteContext): Promise<Response>;
  addPOST(request: Request, context: RouteContext): Promise<Response>;
  resolveGET(request: Request, context: RouteContext): Promise<Response>;
  editPATCH(request: Request, context: RouteContext): Promise<Response>;
  removeDELETE(request: Request, context: RouteContext): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

const descriptionInputSchema = z.string();

const jsonAddBodySchema = z.object({
  description: descriptionInputSchema,
  payload: addTicketAttachmentPayloadInputSchema,
});

/** JSON add bodies cannot carry file bytes — file adds must use multipart. */
function isFileKindBody(body: Record<string, unknown>): boolean {
  const payload = body["payload"];
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === "file"
  );
}

/** The multipart `metadata` part. */
const fileMetadataSchema = z.object({
  description: descriptionInputSchema,
  fileName: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
});

const editBodySchema = updateTicketAttachmentServiceInputSchema.pick({
  description: true,
  markdown: true,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function payloadTooLargeResponse(sizeBytes: number): Response {
  return NextResponse.json(
    {
      error: `File exceeds the ${MAX_TICKET_FILE_UPLOAD_BYTES}-byte upload limit`,
      code: "payload_too_large",
      details: { sizeBytes, maxBytes: MAX_TICKET_FILE_UPLOAD_BYTES },
    },
    { status: 413 },
  );
}

function internalErrorResponse(): Response {
  return NextResponse.json(
    {
      error: "Attachment operation failed",
      code: "internal_error",
    } satisfies ApiError,
    { status: 500 },
  );
}

function isMultipart(request: Request): boolean {
  return (
    request.headers.get("content-type")?.includes("multipart/form-data") ??
    false
  );
}

// ---------------------------------------------------------------------------
// Bounded body reading
// ---------------------------------------------------------------------------

export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; receivedBytes: number };

/**
 * Reads a request body while enforcing a byte ceiling, cancelling the source
 * stream the moment the ceiling is crossed — an unbounded upload (or one with
 * a lying content-length) never allocates past the cap.
 */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { ok: false, receivedBytes: received };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTicketAttachmentRouteHandlers(
  deps: TicketAttachmentRouteDeps = defaultDeps(),
): TicketAttachmentRouteHandlers {
  async function softGate(request: Request): Promise<Response | null> {
    const validation = await deps.auth.validateOptionalToken(request);
    if (validation.kind === "invalid") {
      return NextResponse.json(
        { error: "Invalid Command Center API token" } satisfies ApiError,
        { status: 401 },
      );
    }
    return null;
  }

  async function attachmentIdentity(
    context: RouteContext,
  ): Promise<{ projectName: string; number: number; attachmentId: string }> {
    const { projectName, number } = await resolveIdentity(context);
    const params = await context.params;
    return { projectName, number, attachmentId: params["attachmentId"] ?? "" };
  }

  async function addFileFromMultipart(
    request: Request,
    identity: { projectName: string; number: number },
  ): Promise<Response> {
    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_TICKET_FILE_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES
    ) {
      logger.info("tickets.attachments.routes.upload_rejected_declared", {
        ...identity,
        declaredLength,
      });
      return payloadTooLargeResponse(declaredLength);
    }

    const bounded = await readBodyBounded(
      request.body,
      MAX_TICKET_FILE_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
    );
    if (!bounded.ok) {
      logger.info("tickets.attachments.routes.upload_rejected_stream", {
        ...identity,
        receivedBytes: bounded.receivedBytes,
      });
      return payloadTooLargeResponse(bounded.receivedBytes);
    }

    let form: FormData;
    try {
      // The platform multipart parser runs over the already-bounded bytes;
      // a Response wrapper is the only fetch-spec surface that exposes it.
      form = await new Response(bounded.bytes, {
        headers: {
          "content-type": request.headers.get("content-type") ?? "",
        },
      }).formData();
    } catch {
      return validationFailedResponse([
        { path: "", message: "request body must be multipart form data" },
      ]);
    }

    const metadataRaw = form.get("metadata");
    if (typeof metadataRaw !== "string") {
      return validationFailedResponse([
        { path: "metadata", message: "metadata part is required" },
      ]);
    }
    let metadataJson: unknown;
    try {
      metadataJson = JSON.parse(metadataRaw);
    } catch {
      return validationFailedResponse([
        { path: "metadata", message: "metadata part must be JSON" },
      ]);
    }
    const metadata = fileMetadataSchema.safeParse(metadataJson);
    if (!metadata.success) {
      return validationFailedResponse(
        toTicketValidationIssues(metadata.error).map((issue) => ({
          ...issue,
          path: issue.path === "" ? "metadata" : `metadata.${issue.path}`,
        })),
      );
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return validationFailedResponse([
        { path: "file", message: "file part is required" },
      ]);
    }
    if (file.size > MAX_TICKET_FILE_UPLOAD_BYTES) {
      logger.info("tickets.attachments.routes.upload_rejected", {
        ...identity,
        sizeBytes: file.size,
      });
      return payloadTooLargeResponse(file.size);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await deps.getAttachmentService().add({
      ...identity,
      description: metadata.data.description,
      payload: {
        kind: "file",
        fileName: metadata.data.fileName ?? file.name,
        mediaType:
          metadata.data.mediaType ?? (file.type !== "" ? file.type : null),
        bytes,
      },
    });
    return ticketResponse(result, 201);
  }

  return {
    async indexGET(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const identity = await resolveIdentity(context);
      const result = await deps.getTicketService().get(identity);
      if (!result.ok) return ticketErrorResponse(result.error);
      logger.debug("tickets.attachments.routes.index", {
        ...identity,
        attachmentCount: result.value.attachments.length,
      });
      return NextResponse.json({ attachments: result.value.attachments });
    },

    async addPOST(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const identity = await resolveIdentity(context);
      try {
        if (isMultipart(request)) {
          return await addFileFromMultipart(request, identity);
        }

        const body = await jsonBodyOrNull(request);
        if (body === null) {
          return validationFailedResponse([
            { path: "", message: "request body must be a JSON object" },
          ]);
        }
        if (isFileKindBody(body)) {
          return validationFailedResponse([
            {
              path: "payload.kind",
              message:
                "file attachments must be uploaded as multipart form data",
            },
          ]);
        }
        const parsed = jsonAddBodySchema.safeParse(body);
        if (!parsed.success) {
          return validationFailedResponse(
            toTicketValidationIssues(parsed.error),
          );
        }
        const result = await deps.getAttachmentService().add({
          ...identity,
          description: parsed.data.description,
          payload: parsed.data.payload,
        });
        return ticketResponse(result, 201);
      } catch (error) {
        logger.error("tickets.attachments.routes.add_failed", {
          ...identity,
          error: error instanceof Error ? error.message : String(error),
        });
        return internalErrorResponse();
      }
    },

    async resolveGET(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      return ticketResponse(
        await deps
          .getAttachmentService()
          .resolve(await attachmentIdentity(context)),
      );
    },

    async editPATCH(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const identity = await attachmentIdentity(context);
      const body = await jsonBodyOrNull(request);
      if (body === null) {
        return validationFailedResponse([
          { path: "", message: "request body must be a JSON object" },
        ]);
      }
      const parsed = editBodySchema.safeParse(body);
      if (!parsed.success) {
        return validationFailedResponse(toTicketValidationIssues(parsed.error));
      }
      return ticketResponse(
        await deps.getAttachmentService().update({
          ...identity,
          ...parsed.data,
        }),
      );
    },

    async removeDELETE(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const identity = attachmentServiceIdentitySchema.safeParse(
        await attachmentIdentity(context),
      );
      if (!identity.success) {
        return validationFailedResponse(
          toTicketValidationIssues(identity.error),
        );
      }
      return ticketResponse(
        await deps.getAttachmentService().remove(identity.data),
      );
    },
  };
}

function defaultDeps(): TicketAttachmentRouteDeps {
  return {
    getTicketService: () => getTicketService(),
    getAttachmentService: () => getTicketAttachmentService(),
    auth: createAgentAuth(),
  };
}

// ---------------------------------------------------------------------------
// Default traced exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _handlers = createTicketAttachmentRouteHandlers();
export const listTicketAttachments = withTracing(_handlers.indexGET);
export const addTicketAttachment = withTracing(_handlers.addPOST);
export const resolveTicketAttachment = withTracing(_handlers.resolveGET);
export const editTicketAttachment = withTracing(_handlers.editPATCH);
export const removeTicketAttachment = withTracing(_handlers.removeDELETE);
