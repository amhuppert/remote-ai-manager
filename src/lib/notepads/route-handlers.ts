/**
 * Notepad route handlers — the flat, id-addressed `/api/notepads` surface (D10).
 *
 * Route shells under `src/app/api` re-export the traced default handlers; tests
 * create handlers with injected deps via `createNotepadsRouteHandlers`. The
 * soft token gate (`validateOptionalToken`) is the house shape: browser
 * requests carry no token, cctl carries the instance bearer token, anything
 * malformed is 401.
 *
 * Routes are id-addressed rather than project-nested because a notepad's
 * address is its immutable id; a notepad's scope governs where it is listed and
 * picked, not who may address it. Project resolution therefore appears only
 * where a scope is being named — the list filter and a scoped create — and goes
 * through the shared `RouteResolution` seam.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { readBodyBounded } from "@/lib/shared/bounded-body";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import {
  notepadCommentAnchorSchema,
  notepadCommentStatusSchema,
  notepadScopeSchema,
  notepadSortSchema,
  notepadWriteModeSchema,
  notepadWriteOperationSchema,
  updateNotepadInputSchema,
  type Notepad,
  type NotepadAuthor,
  type NotepadComment,
  type NotepadCommentReply,
} from "./schemas";
import type {
  NotepadError,
  NotepadResult,
  NotepadService,
  NotepadValidationIssue,
} from "./service";
import { getNotepadService } from "./service-factory";

const logger = createLogger("notepads.routes");

/**
 * The claimed caller conversation. Present with a valid bearer token, this
 * request is an agent write and is attributed to (and governed for) that
 * conversation; absent, it is the user's own write. The claim is cooperative by
 * design — the same convention the spec and CLI surfaces use.
 */
export const NOTEPAD_CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";

/**
 * Ceiling on a notepad request body. Autosave posts the whole canonical text on
 * every flush, so the content routes are the one place an unbounded body would
 * arrive as a matter of course rather than by abuse.
 */
export const MAX_NOTEPAD_BODY_BYTES = 4 * 1024 * 1024;

/** History is bounded by default so an old notepad's panel load stays cheap. */
export const DEFAULT_NOTEPAD_REVISION_LIMIT = 50;
export const MAX_NOTEPAD_REVISION_LIMIT = 200;

export type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface NotepadsRouteDeps {
  /** Lazy so importing this module (route shells do) never opens the DB. */
  getService(): NotepadService;
  resolveProjectPath(projectName: string): Promise<string | null>;
  auth: AgentAuth;
}

export interface NotepadsRouteHandlers {
  listGET(request: Request): Promise<Response>;
  createPOST(request: Request): Promise<Response>;
  detailGET(request: Request, context: RouteContext): Promise<Response>;
  detailPATCH(request: Request, context: RouteContext): Promise<Response>;
  detailDELETE(request: Request, context: RouteContext): Promise<Response>;
  contentPOST(request: Request, context: RouteContext): Promise<Response>;
  revisionsGET(request: Request, context: RouteContext): Promise<Response>;
  restorePOST(request: Request, context: RouteContext): Promise<Response>;
  commentsGET(request: Request, context: RouteContext): Promise<Response>;
  commentsPOST(request: Request, context: RouteContext): Promise<Response>;
  commentPATCH(request: Request, context: RouteContext): Promise<Response>;
  commentDELETE(request: Request, context: RouteContext): Promise<Response>;
  commentRepliesPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

export function validationFailedResponse(
  issues: NotepadValidationIssue[],
): Response {
  return NextResponse.json(
    {
      error: "Notepad request validation failed",
      code: "validation_failed",
      issues,
    },
    { status: 400 },
  );
}

export function toNotepadValidationIssues(
  error: z.ZodError,
): NotepadValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * The one exhaustive typed-error-to-response mapper. Every refusal already
 * carries its own message, rationale, and instruction from the service, so this
 * only chooses the status and the machine-readable details — the explanation a
 * caller reads is authored once, where the decision was made.
 */
export function notepadErrorResponse(error: NotepadError): Response {
  switch (error.code) {
    case "validation_failed":
      return validationFailedResponse(error.issues);
    case "not_found":
      return notFound(
        error.message,
        error.code,
        { notepadId: error.notepadId },
        error.instruction,
        error.rationale,
      );
    case "name_taken":
      return jsonError(
        error.message,
        409,
        error.code,
        { name: error.name },
        error.instruction,
        error.rationale,
      );
    case "write_mode_refused":
      return jsonError(
        error.message,
        403,
        error.code,
        { writeMode: error.writeMode, operation: error.operation },
        error.instruction,
        error.rationale,
      );
    case "stale_revision":
      return jsonError(
        error.message,
        409,
        error.code,
        {
          currentRevision: error.currentRevision,
          baseRevision: error.baseRevision,
        },
        error.instruction,
        error.rationale,
      );
    case "comment_not_found":
      return notFound(
        error.message,
        error.code,
        { notepadId: error.notepadId, commentId: error.commentId },
        error.instruction,
        error.rationale,
      );
    case "comment_user_act_refused":
      // 403 like the write-mode refusal: the request was understood and is
      // permanently refused for this caller, not malformed or retryable.
      return jsonError(
        error.message,
        403,
        error.code,
        { act: error.act },
        error.instruction,
        error.rationale,
      );
  }
}

function notepadResponse(
  result: NotepadResult<Notepad>,
  successStatus = 200,
): Response {
  if (!result.ok) return notepadErrorResponse(result.error);
  return NextResponse.json(
    { notepad: result.value },
    { status: successStatus },
  );
}

function commentResponse(
  result: NotepadResult<NotepadComment>,
  successStatus = 200,
): Response {
  if (!result.ok) return notepadErrorResponse(result.error);
  return NextResponse.json(
    { comment: result.value },
    { status: successStatus },
  );
}

function replyResponse(result: NotepadResult<NotepadCommentReply>): Response {
  if (!result.ok) return notepadErrorResponse(result.error);
  return NextResponse.json({ reply: result.value }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

/** Query params arrive as strings; `archived` is a flag, not free text. */
const archivedParamSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const listQuerySchema = z
  .object({
    scope: notepadScopeSchema.optional(),
    project: z.string().min(1).optional(),
    sort: notepadSortSchema.default("recency"),
    archived: archivedParamSchema.default(false),
  })
  .strict();

const createBodySchema = z
  .object({
    scope: notepadScopeSchema,
    /** A project display name; the scope pairing itself is the service's rule. */
    project: z.string().min(1).optional(),
    name: z.string().min(1),
    content: z.string().optional(),
    writeMode: notepadWriteModeSchema.optional(),
  })
  .strict();

/**
 * The author is deliberately absent from every write body: it is derived from
 * the request's own credentials, so a caller cannot name itself something the
 * transport does not support.
 */
const contentBodySchema = z
  .object({
    operation: notepadWriteOperationSchema,
    content: z.string(),
    baseRevision: z.number().int().positive().optional(),
    /**
     * User opt-in to treat `baseRevision` as a compare-and-swap — stated by
     * conditional acts like clip undo, whose tail check must be atomic with
     * the write. Agent writes are always enforced regardless.
     */
    enforceBaseRevision: z.boolean().optional(),
  })
  .strict();

const restoreBodySchema = z
  .object({ revision: z.number().int().positive() })
  .strict();

const revisionsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_NOTEPAD_REVISION_LIMIT)
      .default(DEFAULT_NOTEPAD_REVISION_LIMIT),
    /**
     * Id-addressed resolution: return exactly this revision and its immediate
     * predecessor instead of the newest-first window, so a selection or diff
     * target resolves however far the head has advanced past any listed page.
     */
    at: z.coerce.number().int().positive().optional(),
  })
  .strict();

const notepadIdParamSchema = z.string().min(1);

/** The author is derived from credentials here too — never from the body. */
const createCommentBodySchema = z
  .object({ anchor: notepadCommentAnchorSchema, body: z.string().min(1) })
  .strict();

const commentStatusBodySchema = z
  .object({ status: notepadCommentStatusSchema })
  .strict();

const replyBodySchema = z.object({ body: z.string().min(1) }).strict();

const commentsQuerySchema = z
  .object({ status: notepadCommentStatusSchema.optional() })
  .strict();

// ---------------------------------------------------------------------------
// Boundary parsing
// ---------------------------------------------------------------------------

/** A present, non-empty query param; empty or absent both read as "not sent". */
function paramOrUndefined(
  params: URLSearchParams,
  name: string,
): string | undefined {
  const value = params.get(name);
  return value !== null && value.length > 0 ? value : undefined;
}

function queryRecord(
  request: Request,
  names: string[],
): Record<string, string> {
  const params = new URL(request.url).searchParams;
  const record: Record<string, string> = {};
  for (const name of names) {
    const value = paramOrUndefined(params, name);
    if (value !== undefined) record[name] = value;
  }
  return record;
}

type BoundedJsonBody =
  | { kind: "value"; value: Record<string, unknown> }
  | { kind: "invalid" }
  | { kind: "too_large"; sizeBytes: number };

async function boundedJsonBody(request: Request): Promise<BoundedJsonBody> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_NOTEPAD_BODY_BYTES
  ) {
    return { kind: "too_large", sizeBytes: declaredLength };
  }

  const bounded = await readBodyBounded(request.body, MAX_NOTEPAD_BODY_BYTES);
  if (!bounded.ok)
    return { kind: "too_large", sizeBytes: bounded.receivedBytes };

  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bounded.bytes));
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { kind: "invalid" };
    }
    return { kind: "value", value: body as Record<string, unknown> };
  } catch {
    logger.info("notepads.routes.invalid_json_body", {
      path: new URL(request.url).pathname,
    });
    return { kind: "invalid" };
  }
}

/** Reads the request body as a validated object, or the refusal to return. */
async function parseBody<T>(
  request: Request,
  schema: { safeParse(input: unknown): z.ZodSafeParseResult<T> },
): Promise<RouteResolution<T>> {
  const body = await boundedJsonBody(request);
  if (body.kind === "too_large") {
    logger.info("notepads.routes.body_rejected", {
      path: new URL(request.url).pathname,
      sizeBytes: body.sizeBytes,
      maxBytes: MAX_NOTEPAD_BODY_BYTES,
    });
    return {
      ok: false,
      response: jsonError(
        `Notepad request body exceeds the ${MAX_NOTEPAD_BODY_BYTES}-byte limit`,
        413,
        "payload_too_large",
        { sizeBytes: body.sizeBytes, maxBytes: MAX_NOTEPAD_BODY_BYTES },
      ),
    };
  }
  if (body.kind === "invalid") {
    return {
      ok: false,
      response: validationFailedResponse([
        { path: "", message: "request body must be a JSON object" },
      ]),
    };
  }
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return {
      ok: false,
      response: validationFailedResponse(
        toNotepadValidationIssues(parsed.error),
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

function parseQuery<T>(
  request: Request,
  names: string[],
  schema: { safeParse(input: unknown): z.ZodSafeParseResult<T> },
): RouteResolution<T> {
  const parsed = schema.safeParse(queryRecord(request, names));
  if (!parsed.success) {
    return {
      ok: false,
      response: validationFailedResponse(
        toNotepadValidationIssues(parsed.error),
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * safeParses the `:notepadId` route segment. Unreachable via normal Next.js
 * routing (an empty segment never matches), but the boundary stays validated
 * for direct handler invocation, so a missing id is a stated bad request rather
 * than a not-found naming an empty id.
 */
async function resolveNotepadId(
  context: RouteContext,
): Promise<RouteResolution<string>> {
  const params = await context.params;
  const parsed = notepadIdParamSchema.safeParse(params["notepadId"]);
  if (!parsed.success) {
    return {
      ok: false,
      response: validationFailedResponse([
        { path: "notepadId", message: "a notepad id is required" },
      ]),
    };
  }
  return { ok: true, value: parsed.data };
}

/** As with `resolveNotepadId`: the segment stays validated at the boundary. */
async function resolveCommentId(
  context: RouteContext,
): Promise<RouteResolution<string>> {
  const params = await context.params;
  const parsed = notepadIdParamSchema.safeParse(params["commentId"]);
  if (!parsed.success) {
    return {
      ok: false,
      response: validationFailedResponse([
        { path: "commentId", message: "a comment id is required" },
      ]),
    };
  }
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNotepadsRouteHandlers(
  deps: NotepadsRouteDeps = defaultDeps(),
): NotepadsRouteHandlers {
  /**
   * The soft token gate and the author keying are one step, because they read
   * the same credentials: a valid bearer token naming a caller conversation is
   * an agent write, and everything else that gets through the gate is the
   * user's own. A tokened request that names no conversation has made no agent
   * claim, so it is the user — write modes govern agents, and a caller that has
   * not identified one is not one.
   */
  async function resolveAuthor(
    request: Request,
  ): Promise<RouteResolution<NotepadAuthor>> {
    const validation = await deps.auth.validateOptionalToken(request);
    if (validation.kind === "invalid") {
      return {
        ok: false,
        response: jsonError("Invalid Command Center API token", 401),
      };
    }
    if (validation.kind === "absent")
      return { ok: true, value: { kind: "user" } };

    const conversationId = request.headers
      .get(NOTEPAD_CALLER_CONVERSATION_HEADER)
      ?.trim();
    if (!conversationId) return { ok: true, value: { kind: "user" } };
    return { ok: true, value: { kind: "agent", conversationId } };
  }

  /** The project path a named project resolves to, or null when unnamed. */
  async function resolveScopeProject(
    projectName: string | undefined,
  ): Promise<RouteResolution<string | null>> {
    if (projectName === undefined) return { ok: true, value: null };
    const resolved = await resolveProjectOr404(
      { resolveProjectPath: deps.resolveProjectPath },
      projectName,
    );
    if (!resolved.ok) return resolved;
    return { ok: true, value: resolved.value };
  }

  return {
    async listGET(request) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const query = parseQuery(
        request,
        ["scope", "project", "sort", "archived"],
        listQuerySchema,
      );
      if (!query.ok) return query.response;

      const project = await resolveScopeProject(query.value.project);
      if (!project.ok) return project.response;

      const result = await deps.getService().list({
        ...(query.value.scope !== undefined
          ? { scope: query.value.scope }
          : {}),
        projectPath: project.value,
        includeArchived: query.value.archived,
        sort: query.value.sort,
      });
      if (!result.ok) return notepadErrorResponse(result.error);
      return NextResponse.json({ notepads: result.value });
    },

    async createPOST(request) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const body = await parseBody(request, createBodySchema);
      if (!body.ok) return body.response;

      const project = await resolveScopeProject(body.value.project);
      if (!project.ok) return project.response;

      // The scope/project pairing is checked once, in the service, so the route
      // and the CLI cannot disagree about what a malformed pairing means.
      return notepadResponse(
        await deps.getService().create({
          scope: body.value.scope,
          projectPath: project.value,
          name: body.value.name,
          ...(body.value.content !== undefined
            ? { content: body.value.content }
            : {}),
          ...(body.value.writeMode !== undefined
            ? { writeMode: body.value.writeMode }
            : {}),
          author: author.value,
        }),
        201,
      );
    },

    async detailGET(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;

      return notepadResponse(await deps.getService().get(notepadId.value));
    },

    async detailPATCH(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;

      const body = await parseBody(request, updateNotepadInputSchema);
      if (!body.ok) return body.response;

      return notepadResponse(
        await deps
          .getService()
          .update(notepadId.value, body.value, author.value),
      );
    },

    async detailDELETE(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;

      return notepadResponse(await deps.getService().delete(notepadId.value));
    },

    async contentPOST(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;

      const body = await parseBody(request, contentBodySchema);
      if (!body.ok) return body.response;

      return notepadResponse(
        await deps.getService().writeContent(notepadId.value, {
          operation: body.value.operation,
          content: body.value.content,
          ...(body.value.baseRevision !== undefined
            ? { baseRevision: body.value.baseRevision }
            : {}),
          ...(body.value.enforceBaseRevision !== undefined
            ? { enforceBaseRevision: body.value.enforceBaseRevision }
            : {}),
          author: author.value,
        }),
      );
    },

    async revisionsGET(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;

      const query = parseQuery(request, ["limit", "at"], revisionsQuerySchema);
      if (!query.ok) return query.response;

      const result =
        query.value.at !== undefined
          ? await deps
              .getService()
              .resolveRevision(notepadId.value, query.value.at)
          : await deps
              .getService()
              .listRevisions(notepadId.value, query.value.limit);
      if (!result.ok) return notepadErrorResponse(result.error);
      return NextResponse.json({ revisions: result.value });
    },

    async commentsGET(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;

      const query = parseQuery(request, ["status"], commentsQuerySchema);
      if (!query.ok) return query.response;

      const result = await deps
        .getService()
        .listComments(notepadId.value, query.value);
      if (!result.ok) return notepadErrorResponse(result.error);
      return NextResponse.json({ comments: result.value });
    },

    async commentsPOST(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;

      const body = await parseBody(request, createCommentBodySchema);
      if (!body.ok) return body.response;

      return commentResponse(
        await deps.getService().createComment(notepadId.value, {
          anchor: body.value.anchor,
          body: body.value.body,
          author: author.value,
        }),
        201,
      );
    },

    async commentPATCH(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;
      const commentId = await resolveCommentId(context);
      if (!commentId.ok) return commentId.response;

      const body = await parseBody(request, commentStatusBodySchema);
      if (!body.ok) return body.response;

      return commentResponse(
        await deps
          .getService()
          .setCommentStatus(notepadId.value, commentId.value, {
            status: body.value.status,
            author: author.value,
          }),
      );
    },

    async commentDELETE(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;
      const commentId = await resolveCommentId(context);
      if (!commentId.ok) return commentId.response;

      return commentResponse(
        await deps
          .getService()
          .deleteComment(notepadId.value, commentId.value, author.value),
      );
    },

    async commentRepliesPOST(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;
      const commentId = await resolveCommentId(context);
      if (!commentId.ok) return commentId.response;

      const body = await parseBody(request, replyBodySchema);
      if (!body.ok) return body.response;

      return replyResponse(
        await deps
          .getService()
          .replyToComment(notepadId.value, commentId.value, {
            body: body.value.body,
            author: author.value,
          }),
      );
    },

    async restorePOST(request, context) {
      const author = await resolveAuthor(request);
      if (!author.ok) return author.response;

      const notepadId = await resolveNotepadId(context);
      if (!notepadId.ok) return notepadId.response;

      const body = await parseBody(request, restoreBodySchema);
      if (!body.ok) return body.response;

      return notepadResponse(
        await deps.getService().restore(notepadId.value, {
          revision: body.value.revision,
          author: author.value,
        }),
      );
    },
  };
}

function defaultDeps(): NotepadsRouteDeps {
  return {
    getService: () => getNotepadService(),
    resolveProjectPath: (projectName) => defaultResolveProjectPath(projectName),
    auth: createAgentAuth(),
  };
}

// ---------------------------------------------------------------------------
// Default traced exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _handlers = createNotepadsRouteHandlers();
export const listNotepads = withTracing(_handlers.listGET);
export const createNotepad = withTracing(_handlers.createPOST);
export const getNotepadDetail = withTracing(_handlers.detailGET);
export const updateNotepadDetail = withTracing(_handlers.detailPATCH);
export const deleteNotepadDetail = withTracing(_handlers.detailDELETE);
export const writeNotepadContent = withTracing(_handlers.contentPOST);
export const listNotepadRevisions = withTracing(_handlers.revisionsGET);
export const restoreNotepadRevision = withTracing(_handlers.restorePOST);
export const listNotepadComments = withTracing(_handlers.commentsGET);
export const createNotepadComment = withTracing(_handlers.commentsPOST);
export const updateNotepadComment = withTracing(_handlers.commentPATCH);
export const deleteNotepadComment = withTracing(_handlers.commentDELETE);
export const replyToNotepadComment = withTracing(_handlers.commentRepliesPOST);
