/**
 * Memory route handlers — the production HTTP surface every memory consumer
 * shares (spec R12, R13). The `cctl memory` group and the Memory Library's
 * query hooks both call these handlers; there is no second, test-only wiring,
 * so a refusal an agent sees is the refusal the panel sees.
 *
 * Routes are flat and handle-addressed (`/api/memory/notes/<handle>`) like the
 * notepad surface: a note's address is its slug (or its internal id), and the
 * note's own scope decides where it is listed, not who may address it.
 *
 * **Scope authority is resolved here, server-side, and is never a payload
 * field.** A request carrying the instance token and a caller conversation is
 * an AGENT acting as that conversation: its project, session incarnation, and
 * visibility union come from the conversation row, so an agent cannot name a
 * scope it does not occupy. Everything else is the user, whose scope comes from
 * the `project`/`session` query parameters the Library sends — request context
 * rather than body, so it reads the same on a GET and on a mutation.
 *
 * Contribution policy is NOT re-derived here. The service consults the
 * contribution gate on every mutation verb and returns `policy_refused`; this
 * layer only maps that typed refusal onto its status. Events publish from the
 * service write path, so nothing here publishes.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import {
  getConversationRuntimeConfiguration,
  readDesiredConversationRuntimeConfiguration,
} from "@/lib/workflows/conversation/manager";

import { readNextTurnContextLoss } from "@/lib/workflows/conversation/pre-turn/next-turn-context-loss";
import { getConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/service-factory";
import type { CheckpointScopeKey } from "@/lib/conversation-checkpoints/schemas";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { readBodyBounded } from "@/lib/shared/bounded-body";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import { getStateStore } from "@/lib/state-store";
import { getTicketsRepo } from "@/lib/tickets/service-factory";
import { findLaneBindingForConversation } from "@/lib/workflow-graph/lane-binding";

import type {
  MemoryConversationLocation,
  MemoryLaneBindingRef,
} from "./delivery-policy";
import { renderMemoryArchive } from "./export";
import type { MemoryFreshnessEngine } from "./freshness";
import type { MemoryIndexContextProvider } from "./index-live-context";
import { parseMemoryArtifactHandle } from "./artifact-handles";
import type { MemoryRecallService } from "./recall";
import type { MemoryTelemetryService } from "./telemetry";
import {
  memoryKindSchema,
  memoryLifecycleSchema,
  memoryLinkKindSchema,
  memoryReviewTargetSchema,
  memoryScopeSchema,
  memorySlugSchema,
  type MemoryActor,
  type MemoryHandleNarrowing,
  type MemoryNote,
  type MemoryArtifactRef,
  type MemoryLink,
  type MemoryVisibility,
} from "./schemas";
import {
  getMemoryFreshnessEngine,
  getMemoryIndexContextProvider,
  getMemoryRecallService,
  getMemoryRepo,
  getMemoryService,
  getMemoryTelemetryService,
} from "./service-factory";
import type { MemoryError, MemoryResult, MemoryService } from "./service";

const logger = createLogger("memory.routes");

/** The claimed caller conversation an agent request acts as. */
export const MEMORY_CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";

/**
 * Ceiling on a memory request body. A note body caps at 8 KiB, so this is only
 * a boundary against abuse — the recall request's artifact list is the largest
 * legitimate payload and is far under it.
 */
export const MAX_MEMORY_BODY_BYTES = 256 * 1024;

/** History reads stay bounded so an old note's panel load stays cheap. */
export const DEFAULT_MEMORY_REVISION_LIMIT = 50;
export const MAX_MEMORY_REVISION_LIMIT = 200;

export type RouteContext = { params: Promise<Record<string, string>> };

export interface MemoryRouteDeps {
  /** Lazy so importing this module (route shells do) never opens the DB. */
  getService(): MemoryService;
  getRecall(): MemoryRecallService;
  /**
   * Observation only (R15); nothing read back here reaches ranking. A counter
   * raised as a SIDE EFFECT of another verb is fire-and-forget — a failed
   * counter must never fail the verb that produced it — while `rederivedPOST`,
   * whose whole purpose is the observation, lets the failure surface.
   */
  getTelemetry(): MemoryTelemetryService;
  getFreshness(): MemoryFreshnessEngine;
  getIndexProvider(): MemoryIndexContextProvider;
  /** These notes' links, for the export archive — one read for the whole set. */
  /**
   * One note by internal id, whatever its scope or lifecycle: the export's
   * supersession lookup, which reads a record the caller holds a pointer TO
   * without granting any other reach into it.
   */
  findNoteById(memoryId: string): Promise<MemoryNote | null>;
  listLinksForNotes(memoryIds: readonly string[]): Promise<MemoryLink[]>;
  resolveProjectPath(projectName: string): Promise<string | null>;
  /**
   * The ticket a `ticket:` handle names, as the `tickets.id` a link is stored
   * against — by display number within a project, or by raw id. Null when no
   * such ticket exists, which the boundary turns into a refusal: a link stored
   * against a ticket that is not there can never match the active-artifact ref
   * the index composer builds, and would sit in the table saying nothing.
   */
  findTicketId(
    reference:
      | { readonly byId: string }
      | { readonly projectPath: string; readonly number: number },
  ): Promise<string | null>;
  /** Where a conversation id lives; null when no conversation carries it. */
  locateConversation(
    conversationId: string,
  ): Promise<MemoryConversationLocation | null>;
  /** The session incarnation's created-at, or null when no such session row exists. */
  findSessionCreatedAt(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;
  /** The execution context a lane conversation drives right now, or null. */
  findLaneBinding(ref: MemoryLaneBindingRef): Promise<{
    readonly executionId: string;
    readonly contextId: string;
  } | null>;
  /**
   * The context-loss signals this conversation's NEXT turn would carry, read
   * from outside a turn (D4).
   *
   * The preview prints the block due for the conversation as it stands, and a
   * context loss makes that block a FULL one however far the delivery sequence
   * has advanced — so assuming no loss made the preview disagree with the turn
   * for exactly the conversations most in need of the answer: the ones whose
   * runtime is gone, and the ones whose runtime the next turn will discard
   * because the charter moved under it. What the reader cannot see is the
   * configuration a dispatcher hands the next turn; that boundary is stated in
   * the `memory index` help and on the Library's next-turn view.
   */
  readNextTurnContextLoss(conversationId: string): Promise<{
    readonly runtimeCreatedWithoutResume: boolean;
    readonly backendReportedCompactionLastTurn: boolean;
  }>;
  auth: AgentAuth;
}

export interface MemoryRouteHandlers {
  listGET(request: Request): Promise<Response>;
  createPOST(request: Request): Promise<Response>;
  detailGET(request: Request, context: RouteContext): Promise<Response>;
  detailPATCH(request: Request, context: RouteContext): Promise<Response>;
  detailDELETE(request: Request, context: RouteContext): Promise<Response>;
  revisionsGET(request: Request, context: RouteContext): Promise<Response>;
  linksPOST(request: Request, context: RouteContext): Promise<Response>;
  linksDELETE(request: Request, context: RouteContext): Promise<Response>;
  reviewedPOST(request: Request, context: RouteContext): Promise<Response>;
  rederivedPOST(request: Request, context: RouteContext): Promise<Response>;
  promotePOST(request: Request, context: RouteContext): Promise<Response>;
  archivePOST(request: Request, context: RouteContext): Promise<Response>;
  restorePOST(request: Request, context: RouteContext): Promise<Response>;
  proposalPOST(request: Request, context: RouteContext): Promise<Response>;
  recallPOST(request: Request): Promise<Response>;
  indexGET(request: Request): Promise<Response>;
  reviewGET(request: Request): Promise<Response>;
  exportGET(request: Request): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

export interface MemoryValidationIssueShape {
  path: string;
  message: string;
}

export function memoryValidationFailedResponse(
  issues: MemoryValidationIssueShape[],
): Response {
  return NextResponse.json(
    {
      error: "Memory request validation failed",
      code: "validation_failed",
      issues,
    },
    { status: 400 },
  );
}

export function toMemoryValidationIssues(
  error: z.ZodError,
): MemoryValidationIssueShape[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * The one exhaustive typed-error-to-response mapper. Each refusal already
 * carries its message, rationale, and instruction from the service, so this
 * chooses only the status and the machine-readable details the CLI and the
 * Library need to compose an exact recovery command.
 */
export function memoryErrorResponse(error: MemoryError): Response {
  switch (error.code) {
    case "validation_failed":
      return memoryValidationFailedResponse(error.issues);
    case "not_found":
      return notFound(
        error.message,
        error.code,
        { handle: error.handle },
        error.instruction,
        error.rationale,
      );
    case "revision_not_found":
      return notFound(
        error.message,
        error.code,
        { revision: error.revision },
        error.instruction,
        error.rationale,
      );
    case "link_not_found":
      return notFound(
        error.message,
        error.code,
        {},
        error.instruction,
        error.rationale,
      );
    case "ambiguous_handle":
      return jsonError(
        error.message,
        409,
        error.code,
        { handle: error.handle, candidates: error.candidates },
        error.instruction,
        error.rationale,
      );
    case "scope_unavailable":
      return jsonError(
        error.message,
        409,
        error.code,
        { scope: error.scope, missing: error.missing },
        error.instruction,
        error.rationale,
      );
    case "slug_taken":
      return jsonError(
        error.message,
        409,
        error.code,
        { slug: error.slug, scope: error.scope },
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
          // The resolved note's slug: the surface composing the retry command
          // may not echo the handle it sent, which can be an internal id.
          slug: error.slug,
        },
        error.instruction,
        error.rationale,
      );
    case "body_too_large":
      return jsonError(
        error.message,
        413,
        error.code,
        { limitBytes: error.limitBytes, actualBytes: error.actualBytes },
        error.instruction,
        error.rationale,
      );
    case "not_proposed":
      return jsonError(
        error.message,
        409,
        error.code,
        { lifecycle: error.lifecycle },
        error.instruction,
        error.rationale,
      );
    case "no_status_note":
      return jsonError(
        error.message,
        409,
        error.code,
        {},
        error.instruction,
        error.rationale,
      );
    // Understood and permanently refused for this caller, not malformed: the
    // same 403 shape the notepad write-mode refusal uses.
    case "human_act_required":
      return jsonError(
        error.message,
        403,
        error.code,
        { act: error.act },
        error.instruction,
        error.rationale,
      );
    case "policy_refused":
      return jsonError(
        error.message,
        403,
        error.code,
        { verb: error.verb, reason: error.reason, policy: error.policy },
        error.instruction,
        error.rationale,
      );
  }
}

function resultResponse<T>(
  result: MemoryResult<T>,
  toBody: (value: T) => Record<string, unknown>,
  successStatus = 200,
): Response {
  if (!result.ok) return memoryErrorResponse(result.error);
  return NextResponse.json(toBody(result.value), { status: successStatus });
}

/**
 * Lineage pointers resolved to `<scope>:<slug>` handles, so every surface that
 * shows a supersession reads one resolved value instead of re-deriving it from
 * an internal id. A target the `lookup` cannot reach resolves to NOTHING rather
 * than to its id: an id a reader cannot address is worse than silence, and the
 * cases are real — a promoted project note's predecessor is session-scoped, and
 * a scope narrowing drops it.
 */
async function resolveLineageHandles(
  notes: readonly MemoryNote[],
  lookup: (memoryId: string) => Promise<MemoryNote | null>,
  alreadyHeld: ReadonlySet<string> = new Set<string>(),
): Promise<Map<string, string>> {
  const handles = new Map<string, string>();
  const wanted = new Set(
    notes
      .flatMap((note) => [note.supersedesId, note.supersededById])
      .filter((id): id is string => id !== null && !alreadyHeld.has(id)),
  );
  for (const id of wanted) {
    const target = await lookup(id);
    if (target !== null) {
      handles.set(id, `${target.scope}:${target.slug}`);
    }
  }
  return handles;
}

/** The pair a single-note read carries beside the ids it is keyed on. */
function lineageOf(
  note: MemoryNote,
  handles: ReadonlyMap<string, string>,
): { supersedes: string | null; supersededBy: string | null } {
  return {
    supersedes:
      note.supersedesId === null
        ? null
        : (handles.get(note.supersedesId) ?? null),
    supersededBy:
      note.supersededById === null
        ? null
        : (handles.get(note.supersededById) ?? null),
  };
}

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

const booleanParamSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/**
 * The caller's own scope, when the caller is the user. An agent never sends
 * these — its scope comes from its conversation row — so they are optional at
 * the boundary and rejected below when an agent sends them anyway.
 */
const actorScopeQuerySchema = z
  .object({
    project: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    incarnation: z.iso.datetime().optional(),
  })
  .strict();

const ACTOR_SCOPE_PARAMS = ["project", "session", "incarnation"] as const;

const listQuerySchema = actorScopeQuerySchema.extend({
  scope: memoryScopeSchema.optional(),
  lifecycle: memoryLifecycleSchema.optional(),
  archived: booleanParamSchema.default(false),
});

/**
 * The mutation query: the caller's scope narrowing rides the REQUEST, uniformly
 * with the reads, so the disambiguation a refusal prints — `--scope project` —
 * is the same parameter whichever verb reproduced the ambiguity.
 */
const narrowedQuerySchema = actorScopeQuerySchema.extend({
  scope: memoryScopeSchema.optional(),
});

const detailQuerySchema = actorScopeQuerySchema.extend({
  scope: memoryScopeSchema.optional(),
  archived: booleanParamSchema.default(false),
});

const revisionsQuerySchema = actorScopeQuerySchema.extend({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_MEMORY_REVISION_LIMIT)
    .default(DEFAULT_MEMORY_REVISION_LIMIT),
});

const reviewQuerySchema = actorScopeQuerySchema.extend({
  projectCandidates: booleanParamSchema.default(false),
  /** Narrow to promotion candidates — the session-completion follow-up (R10). */
  promotionCandidates: booleanParamSchema.default(false),
  /** A session incarnation named from outside: both halves or neither. */
  sessionName: z.string().min(1).optional(),
  sessionCreatedAt: z.string().min(1).optional(),
});

/**
 * `full` is the block selector, not a filter: the default is what the NEXT turn
 * would actually be given — a delta for a conversation that already holds a
 * block — and `full=true` asks for the whole index whatever the delivery state
 * says (R12, R12.2). Neither render settles anything.
 */
const indexQuerySchema = z
  .object({
    conversation: z.string().min(1),
    full: booleanParamSchema.default(false),
  })
  .strict();

const exportQuerySchema = actorScopeQuerySchema.extend({
  scope: memoryScopeSchema.optional(),
});

const createBodySchema = z
  .object({
    scope: memoryScopeSchema,
    kind: memoryKindSchema,
    hook: z.string().min(1),
    body: z.string().optional(),
    slug: memorySlugSchema.optional(),
    aliases: z.array(z.string().min(1)).optional(),
    statusNote: z.string().min(1).nullable().optional(),
    indexMode: z.enum(["auto", "always", "search-only"]).optional(),
    reviewAfter: z.string().min(1).nullable().optional(),
    expiresAt: z.string().min(1).nullable().optional(),
    supersedes: z.string().min(1).nullable().optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    baseRevision: z.number().int().positive(),
    hook: z.string().min(1).optional(),
    body: z.string().optional(),
    slug: memorySlugSchema.optional(),
    aliases: z.array(z.string().min(1)).optional(),
    statusNote: z.string().min(1).nullable().optional(),
    indexMode: z.enum(["auto", "always", "search-only"]).optional(),
    reviewAfter: z.string().min(1).nullable().optional(),
    expiresAt: z.string().min(1).nullable().optional(),
  })
  .strict();

/**
 * A link's artifact travels as the HANDLE form the CLI prints and accepts
 * (`ticket:<id>`, `context:<executionId>/<contextId>`, …). One wire
 * representation means the handle a narrowing command renders is the handle
 * every surface sends back.
 */
const linkBodySchema = z
  .object({
    kind: memoryLinkKindSchema,
    artifact: z.string().min(1),
  })
  .strict();

const unlinkBodySchema = z.union([
  z.object({ linkId: z.string().min(1) }).strict(),
  linkBodySchema,
]);

const lifecycleBodySchema = z
  .object({ baseRevision: z.number().int().positive().nullable().optional() })
  .strict();

const restoreBodySchema = z
  .object({
    revision: z.number().int().positive(),
    baseRevision: z.number().int().positive().nullable().optional(),
  })
  .strict();

const reviewedBodySchema = z
  .object({
    target: memoryReviewTargetSchema.optional(),
    baseRevision: z.number().int().positive().nullable().optional(),
  })
  .strict();

/**
 * The workflow round the observation belongs to, as an artifact handle. It is
 * optional because an unattributed round still counts: the subject R15 asks
 * about is the NOTE whose content was re-derived, and a round nobody can name
 * is worth less than a round nobody records.
 */
const rederivedBodySchema = z
  .object({ artifact: z.string().min(1).optional() })
  .strict();

const promoteBodySchema = z
  .object({
    slug: memorySlugSchema.optional(),
    hook: z.string().min(1).optional(),
    body: z.string().optional(),
    aliases: z.array(z.string().min(1)).optional(),
    statusNote: z.string().min(1).nullable().optional(),
    indexMode: z.enum(["auto", "always", "search-only"]).optional(),
    baseRevision: z.number().int().positive().nullable().optional(),
  })
  .strict();

const proposalBodySchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    baseRevision: z.number().int().positive(),
  })
  .strict();

const recallBodySchema = z
  .object({
    query: z.string().min(1).nullable().optional(),
    /** Handle form, as on the link body. */
    related: z.string().min(1).nullable().optional(),
    activeArtifacts: z.array(z.string().min(1)).optional(),
    scope: memoryScopeSchema.optional(),
    budgetChars: z.number().int().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Boundary parsing
// ---------------------------------------------------------------------------

function paramOrUndefined(
  params: URLSearchParams,
  name: string,
): string | undefined {
  const value = params.get(name);
  return value !== null && value.length > 0 ? value : undefined;
}

function queryRecord(
  request: Request,
  names: readonly string[],
): Record<string, string> {
  const params = new URL(request.url).searchParams;
  const record: Record<string, string> = {};
  for (const name of names) {
    const value = paramOrUndefined(params, name);
    if (value !== undefined) record[name] = value;
  }
  return record;
}

function parseQuery<T>(
  request: Request,
  names: readonly string[],
  schema: { safeParse(input: unknown): z.ZodSafeParseResult<T> },
): RouteResolution<T> {
  const parsed = schema.safeParse(queryRecord(request, names));
  if (!parsed.success) {
    return {
      ok: false,
      response: memoryValidationFailedResponse(
        toMemoryValidationIssues(parsed.error),
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

type BoundedJsonBody =
  | { kind: "value"; value: Record<string, unknown> }
  | { kind: "invalid" }
  | { kind: "too_large"; sizeBytes: number };

async function boundedJsonBody(request: Request): Promise<BoundedJsonBody> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_MEMORY_BODY_BYTES
  ) {
    return { kind: "too_large", sizeBytes: declaredLength };
  }
  const bounded = await readBodyBounded(request.body, MAX_MEMORY_BODY_BYTES);
  if (!bounded.ok) {
    return { kind: "too_large", sizeBytes: bounded.receivedBytes };
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bounded.bytes));
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { kind: "invalid" };
    }
    return { kind: "value", value: body as Record<string, unknown> };
  } catch {
    logger.info("memory.routes.invalid_json_body", {
      path: new URL(request.url).pathname,
    });
    return { kind: "invalid" };
  }
}

async function parseBody<T>(
  request: Request,
  schema: { safeParse(input: unknown): z.ZodSafeParseResult<T> },
): Promise<RouteResolution<T>> {
  const body = await boundedJsonBody(request);
  if (body.kind === "too_large") {
    return {
      ok: false,
      response: jsonError(
        `Memory request body exceeds the ${MAX_MEMORY_BODY_BYTES}-byte limit`,
        413,
        "payload_too_large",
        { sizeBytes: body.sizeBytes, maxBytes: MAX_MEMORY_BODY_BYTES },
      ),
    };
  }
  if (body.kind === "invalid") {
    return {
      ok: false,
      response: memoryValidationFailedResponse([
        { path: "", message: "request body must be a JSON object" },
      ]),
    };
  }
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return {
      ok: false,
      response: memoryValidationFailedResponse(
        toMemoryValidationIssues(parsed.error),
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

const handleParamSchema = z.string().min(1);

async function resolveHandleParam(
  context: RouteContext,
): Promise<RouteResolution<string>> {
  const params = await context.params;
  const parsed = handleParamSchema.safeParse(params["handle"]);
  if (!parsed.success) {
    return {
      ok: false,
      response: memoryValidationFailedResponse([
        { path: "handle", message: "a memory slug or id is required" },
      ]),
    };
  }
  return { ok: true, value: decodeURIComponent(parsed.data) };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryRouteHandlers(
  deps: MemoryRouteDeps = defaultDeps(),
): MemoryRouteHandlers {
  /**
   * The actor a request acts as, with the visibility that bounds every read and
   * is the authority behind every write. The token gate and the scope
   * derivation are one step because they read the same credentials: a valid
   * bearer token naming a caller conversation is an agent acting as that
   * conversation, and anything else that gets through the soft gate is the user.
   */
  async function resolveActor(
    request: Request,
    scope: {
      project?: string | undefined;
      session?: string | undefined;
      incarnation?: string | undefined;
    },
  ): Promise<RouteResolution<MemoryActor>> {
    const validation = await deps.auth.validateOptionalToken(request);
    if (validation.kind === "invalid") {
      return {
        ok: false,
        response: jsonError("Invalid Command Center API token", 401),
      };
    }

    const conversationId =
      validation.kind === "absent"
        ? undefined
        : (request.headers.get(MEMORY_CALLER_CONVERSATION_HEADER)?.trim() ??
          undefined);

    if (conversationId !== undefined && conversationId !== "") {
      const location = await deps.locateConversation(conversationId);
      if (location === null) {
        return {
          ok: false,
          response: jsonError(
            `No conversation ${conversationId} exists, so no memory scope can be resolved for this caller`,
            403,
            "caller_unresolved",
            { conversationId },
            "Re-read your CC_CONVERSATION_ID, or drop the caller header to act as the user.",
            "A memory scope is the caller's own: it is read from the conversation row rather than taken from the request, so a caller Command Center cannot place has no visibility to read or write within.",
          ),
        };
      }
      const visibility = await visibilityForConversation(location);
      if (!visibility.ok) return visibility;
      return {
        ok: true,
        value: {
          kind: "agent",
          conversationId,
          visibility: visibility.value,
        },
      };
    }

    const visibility = await userVisibility(scope);
    if (!visibility.ok) return visibility;
    return { ok: true, value: { kind: "user", visibility: visibility.value } };
  }

  async function visibilityForConversation(
    location: MemoryConversationLocation,
  ): Promise<RouteResolution<MemoryVisibility>> {
    if (location.conversation.kind === "project") {
      return {
        ok: true,
        value: { projectPath: location.projectPath, session: null },
      };
    }
    const sessionName = location.conversation.sessionName;
    const createdAt = await deps.findSessionCreatedAt(
      location.projectPath,
      sessionName,
    );
    // A session conversation whose session row is gone still sees its project
    // and the global scope: losing the incarnation narrows the union rather
    // than failing the read.
    return {
      ok: true,
      value: {
        projectPath: location.projectPath,
        session:
          createdAt === null
            ? null
            : { sessionName, sessionCreatedAt: createdAt },
      },
    };
  }

  async function userVisibility(scope: {
    project?: string | undefined;
    session?: string | undefined;
    incarnation?: string | undefined;
  }): Promise<RouteResolution<MemoryVisibility>> {
    if (
      scope.incarnation !== undefined &&
      (scope.project === undefined || scope.session === undefined)
    ) {
      return {
        ok: false,
        response: memoryValidationFailedResponse([
          {
            path: "incarnation",
            message: "an incarnation requires a project and session",
          },
        ]),
      };
    }
    if (scope.project === undefined) {
      if (scope.session !== undefined) {
        return {
          ok: false,
          response: memoryValidationFailedResponse([
            {
              path: "session",
              message:
                "a session is named within a project — pass project alongside it",
            },
          ]),
        };
      }
      return { ok: true, value: { projectPath: null, session: null } };
    }

    const resolved = await resolveProjectOr404(
      { resolveProjectPath: deps.resolveProjectPath },
      scope.project,
    );
    if (!resolved.ok) return resolved;

    if (scope.session === undefined) {
      return {
        ok: true,
        value: { projectPath: resolved.value, session: null },
      };
    }
    const createdAt =
      scope.incarnation ??
      (await deps.findSessionCreatedAt(resolved.value, scope.session));
    if (createdAt === null) {
      return {
        ok: false,
        response: notFound(
          `No session ${scope.session} exists in project ${scope.project}`,
          "session_not_found",
          { session: scope.session, project: scope.project },
          "List the project's sessions and name one that exists.",
          "A session-scoped read binds to an exact incarnation, so a name with no session row behind it has no incarnation to bind to.",
        ),
      };
    }
    return {
      ok: true,
      value: {
        projectPath: resolved.value,
        session: {
          sessionName: scope.session,
          sessionCreatedAt: createdAt,
        },
      },
    };
  }

  /** Resolve the actor from a request whose scope params ride the query string. */
  /**
   * The actor together with the scope narrowing the caller stated. Mutations
   * take this rather than {@link actorFromQuery}: dropping the narrowing would
   * make every `--scope` recovery a refusal prints reproduce the ambiguity it
   * was printed to resolve.
   */
  async function narrowedActorFromQuery(
    request: Request,
  ): Promise<
    RouteResolution<{ actor: MemoryActor; narrowing: MemoryHandleNarrowing }>
  > {
    const query = parseQuery(
      request,
      [...ACTOR_SCOPE_PARAMS, "scope"],
      narrowedQuerySchema,
    );
    if (!query.ok) return query;
    const actor = await resolveActor(request, query.value);
    if (!actor.ok) return actor;
    return {
      ok: true,
      value: {
        actor: actor.value,
        narrowing:
          query.value.scope === undefined ? {} : { scope: query.value.scope },
      },
    };
  }

  async function actorFromQuery(
    request: Request,
  ): Promise<RouteResolution<MemoryActor>> {
    const scope = parseQuery(
      request,
      ACTOR_SCOPE_PARAMS,
      actorScopeQuerySchema,
    );
    if (!scope.ok) return scope;
    return resolveActor(request, scope.value);
  }

  function handleRefusal(
    field: string,
    message: string,
  ): RouteResolution<MemoryArtifactRef> {
    return {
      ok: false,
      response: memoryValidationFailedResponse([{ path: field, message }]),
    };
  }

  /**
   * The artifact a handle names, in the caller's own project. Every verb that
   * takes `--artifact` comes through here, so the ticket id spaces are
   * reconciled once: a display number, `<project>#<number>`, or the raw id all
   * resolve to `tickets.id`, and a handle naming no ticket is refused here
   * rather than persisted as a link that can never fire.
   */
  async function artifactOr400(
    handle: string,
    visibility: MemoryVisibility,
    field: string,
  ): Promise<RouteResolution<MemoryArtifactRef>> {
    const parsed = parseMemoryArtifactHandle(handle, visibility.projectPath);
    if (parsed === null) {
      return handleRefusal(
        field,
        `'${handle}' is not an artifact handle — use ticket:<number>, ticket:<project>#<number>, ticket:<id>, spec:<id>, execution:<id>, context:<executionId>/<contextId>, or session:<name>@<createdAt>`,
      );
    }
    if (parsed.kind === "artifact") {
      return { ok: true, value: parsed.artifact };
    }

    const reference = parsed.ticket;
    if (reference.form === "id") {
      const ticketId = await deps.findTicketId({ byId: reference.ticketId });
      return ticketId === null
        ? handleRefusal(
            field,
            `'${handle}' names no ticket — check the id, or name the ticket by its number as ticket:<number>`,
          )
        : { ok: true, value: { kind: "ticket", ticketId } };
    }

    let projectPath: string | null;
    if (reference.projectName === null) {
      projectPath = visibility.projectPath;
      if (projectPath === null) {
        return handleRefusal(
          field,
          `'${handle}' names a ticket number, which is only meaningful inside a project — write ticket:<project>#${reference.number}, or pass the ticket id`,
        );
      }
    } else {
      projectPath = await deps.resolveProjectPath(reference.projectName);
      if (projectPath === null) {
        return handleRefusal(
          field,
          `'${handle}' names no project '${reference.projectName}'`,
        );
      }
    }

    const ticketId = await deps.findTicketId({
      projectPath,
      number: reference.number,
    });
    return ticketId === null
      ? handleRefusal(
          field,
          `'${handle}' names no ticket ${reference.number} in ${projectPath}`,
        )
      : { ok: true, value: { kind: "ticket", ticketId } };
  }

  return {
    async listGET(request) {
      const query = parseQuery(
        request,
        [...ACTOR_SCOPE_PARAMS, "scope", "lifecycle", "archived"],
        listQuerySchema,
      );
      if (!query.ok) return query.response;
      const actor = await resolveActor(request, query.value);
      if (!actor.ok) return actor.response;

      return resultResponse(
        await deps.getService().list(
          {
            ...(query.value.scope !== undefined
              ? { scope: query.value.scope }
              : {}),
            ...(query.value.lifecycle !== undefined
              ? { lifecycle: query.value.lifecycle }
              : {}),
            includeArchived: query.value.archived,
          },
          actor.value,
        ),
        (notes) => ({ notes }),
      );
    },

    async createPOST(request) {
      const actor = await actorFromQuery(request);
      if (!actor.ok) return actor.response;
      const body = await parseBody(request, createBodySchema);
      if (!body.ok) return body.response;

      return resultResponse(
        await deps.getService().create(body.value, actor.value),
        (outcome) => ({
          note: outcome.note,
          advisories: outcome.advisories,
        }),
        201,
      );
    },

    async detailGET(request, context) {
      const query = parseQuery(
        request,
        [...ACTOR_SCOPE_PARAMS, "scope", "archived"],
        detailQuerySchema,
      );
      if (!query.ok) return query.response;
      const actor = await resolveActor(request, query.value);
      if (!actor.ok) return actor.response;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;

      const options = {
        ...(query.value.scope !== undefined
          ? { scope: query.value.scope }
          : {}),
        includeArchived: query.value.archived,
        includeProposed: actor.value.kind === "user",
      };
      const found = await deps
        .getService()
        .get(handle.value, actor.value, options);
      if (!found.ok) return memoryErrorResponse(found.error);

      // Resolved through the SAME reach the read itself had, so a lineage
      // target this caller could not have read is named as nothing rather than
      // surfaced as an id they cannot address.
      const handles = await resolveLineageHandles(
        [found.value.note],
        async (memoryId) => {
          const target = await deps.getService().get(memoryId, actor.value, {
            ...options,
            includeArchived: true,
          });
          return target.ok ? target.value.note : null;
        },
      );
      return NextResponse.json(
        {
          note: found.value.note,
          links: found.value.links,
          lineage: lineageOf(found.value.note, handles),
        },
        { status: 200 },
      );
    },

    async detailPATCH(request, context) {
      const resolved = await narrowedActorFromQuery(request);
      if (!resolved.ok) return resolved.response;
      const { actor, narrowing } = resolved.value;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;
      const body = await parseBody(request, updateBodySchema);
      if (!body.ok) return body.response;

      return resultResponse(
        await deps
          .getService()
          .update(handle.value, body.value, actor, narrowing),
        (note) => ({ note }),
      );
    },

    async detailDELETE(request, context) {
      const resolved = await narrowedActorFromQuery(request);
      if (!resolved.ok) return resolved.response;
      const { actor, narrowing } = resolved.value;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;

      return resultResponse(
        await deps.getService().delete(handle.value, actor, narrowing),
        (note) => ({ note }),
      );
    },

    async revisionsGET(request, context) {
      const query = parseQuery(
        request,
        [...ACTOR_SCOPE_PARAMS, "limit"],
        revisionsQuerySchema,
      );
      if (!query.ok) return query.response;
      const actor = await resolveActor(request, query.value);
      if (!actor.ok) return actor.response;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;

      return resultResponse(
        await deps
          .getService()
          .listRevisions(handle.value, actor.value, query.value.limit),
        (revisions) => ({ revisions }),
      );
    },

    async linksPOST(request, context) {
      const resolved = await narrowedActorFromQuery(request);
      if (!resolved.ok) return resolved.response;
      const { actor, narrowing } = resolved.value;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;
      const body = await parseBody(request, linkBodySchema);
      if (!body.ok) return body.response;
      const artifact = await artifactOr400(
        body.value.artifact,
        actor.visibility,
        "artifact",
      );
      if (!artifact.ok) return artifact.response;

      return resultResponse(
        await deps
          .getService()
          .link(
            handle.value,
            { kind: body.value.kind, artifact: artifact.value },
            actor,
            narrowing,
          ),
        (outcome) => ({ link: outcome.link, note: outcome.note }),
        201,
      );
    },

    async linksDELETE(request, context) {
      const resolved = await narrowedActorFromQuery(request);
      if (!resolved.ok) return resolved.response;
      const { actor, narrowing } = resolved.value;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;
      const body = await parseBody(request, unlinkBodySchema);
      if (!body.ok) return body.response;

      if ("linkId" in body.value) {
        return resultResponse(
          await deps
            .getService()
            .unlink(
              handle.value,
              { linkId: body.value.linkId },
              actor,
              narrowing,
            ),
          (outcome) => ({ link: outcome.link, note: outcome.note }),
        );
      }
      const artifact = await artifactOr400(
        body.value.artifact,
        actor.visibility,
        "artifact",
      );
      if (!artifact.ok) return artifact.response;
      return resultResponse(
        await deps
          .getService()
          .unlink(
            handle.value,
            { kind: body.value.kind, artifact: artifact.value },
            actor,
            narrowing,
          ),
        (outcome) => ({ link: outcome.link, note: outcome.note }),
      );
    },

    async reviewedPOST(request, context) {
      const resolved = await narrowedActorFromQuery(request);
      if (!resolved.ok) return resolved.response;
      const { actor, narrowing } = resolved.value;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;
      const body = await parseBody(request, reviewedBodySchema);
      if (!body.ok) return body.response;

      return resultResponse(
        await deps.getService().markReviewed(
          handle.value,
          {
            ...(body.value.target !== undefined
              ? { target: body.value.target }
              : {}),
            baseRevision: body.value.baseRevision ?? null,
          },
          actor,
          narrowing,
        ),
        // The re-leased claim travels with the act (R2.2): the surface that
        // ran it names what it put back into ambient delivery.
        (outcome) => ({
          note: outcome.note,
          statusReLease: outcome.statusReLease,
        }),
      );
    },

    /**
     * The production path for R15's validator re-derivation observation: a
     * round that spent itself re-deriving a fact one of its linked notes
     * already held. Detecting that is a judgement no code path in this
     * delivery can make, so the surface takes the judgement from whoever holds
     * it — the validator itself, the implementer reading its feedback, or an
     * evaluation replaying the round — and turns it into the greppable event
     * and the counter.
     *
     * Deliberately NOT behind the contribution gate: an observation about a
     * round is not a mutation of a note, and the validator whose rounds this
     * counts is exactly the caller whose note contributions R10 refuses. It
     * reads no counter back, so no caller can reason about how popular a note
     * is (`inv-no-popularity-or-telemetry-rank`).
     */
    async rederivedPOST(request, context) {
      const resolved = await narrowedActorFromQuery(request);
      if (!resolved.ok) return resolved.response;
      const { actor, narrowing } = resolved.value;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;
      const body = await parseBody(request, rederivedBodySchema);
      if (!body.ok) return body.response;

      let executionId: string | null = null;
      let contextId: string | null = null;
      if (body.value.artifact !== undefined) {
        const artifact = await artifactOr400(
          body.value.artifact,
          actor.visibility,
          "artifact",
        );
        if (!artifact.ok) return artifact.response;
        if (artifact.value.kind === "workflow_context") {
          executionId = artifact.value.executionId;
          contextId = artifact.value.contextId;
        } else if (artifact.value.kind === "workflow_execution") {
          executionId = artifact.value.executionId;
        } else {
          return memoryValidationFailedResponse([
            {
              path: "artifact",
              message:
                "a re-derived round is named by the run it ran in — use context:<executionId>/<contextId> or execution:<id>",
            },
          ]);
        }
      }

      const found = await deps
        .getService()
        .resolve(handle.value, actor, narrowing);
      if (!found.ok) return memoryErrorResponse(found.error);
      const note = found.value;

      const conversationId =
        actor.kind === "agent" ? actor.conversationId : null;
      // Unlike the promotion counter, recording IS this verb: a swallowed
      // failure would answer "recorded" for an observation that was lost.
      await deps.getTelemetry().recordValidatorRederivation({
        memoryId: note.id,
        conversationId,
        executionId,
        contextId,
      });

      return NextResponse.json(
        {
          observed: {
            memoryId: note.id,
            slug: note.slug,
            conversationId,
            executionId,
            contextId,
          },
        },
        { status: 200 },
      );
    },

    async promotePOST(request, context) {
      const actor = await actorFromQuery(request);
      if (!actor.ok) return actor.response;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;
      const body = await parseBody(request, promoteBodySchema);
      if (!body.ok) return body.response;

      const promotion = await deps
        .getService()
        .promote(handle.value, body.value, actor.value);

      // Counted against the SESSION note this retired rather than the new
      // project note: session end counted that same record as a candidate, and
      // the pair is only a measure of the missed affordance if both name it.
      if (promotion.ok) {
        try {
          await deps
            .getTelemetry()
            .recordPromoted(promotion.value.superseded.id);
        } catch (err) {
          logger.warn("memory.routes.promotion_telemetry_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return resultResponse(promotion, (outcome) => ({
        promoted: outcome.promoted,
        superseded: outcome.superseded,
      }));
    },

    async archivePOST(request, context) {
      const resolved = await narrowedActorFromQuery(request);
      if (!resolved.ok) return resolved.response;
      const { actor, narrowing } = resolved.value;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;
      const body = await parseBody(request, lifecycleBodySchema);
      if (!body.ok) return body.response;

      return resultResponse(
        await deps
          .getService()
          .archive(
            handle.value,
            { baseRevision: body.value.baseRevision ?? null },
            actor,
            narrowing,
          ),
        (note) => ({ note }),
      );
    },

    async restorePOST(request, context) {
      const actor = await actorFromQuery(request);
      if (!actor.ok) return actor.response;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;
      const body = await parseBody(request, restoreBodySchema);
      if (!body.ok) return body.response;

      return resultResponse(
        await deps.getService().restore(
          handle.value,
          {
            revision: body.value.revision,
            baseRevision: body.value.baseRevision ?? null,
          },
          actor.value,
        ),
        (note) => ({ note }),
      );
    },

    async proposalPOST(request, context) {
      const actor = await actorFromQuery(request);
      if (!actor.ok) return actor.response;
      const handle = await resolveHandleParam(context);
      if (!handle.ok) return handle.response;
      const body = await parseBody(request, proposalBodySchema);
      if (!body.ok) return body.response;

      const decision = { baseRevision: body.value.baseRevision };
      const service = deps.getService();
      return resultResponse(
        body.value.decision === "approve"
          ? await service.approveProposal(handle.value, decision, actor.value)
          : await service.rejectProposal(handle.value, decision, actor.value),
        (note) => ({ note }),
      );
    },

    async recallPOST(request) {
      const actor = await actorFromQuery(request);
      if (!actor.ok) return actor.response;
      const body = await parseBody(request, recallBodySchema);
      if (!body.ok) return body.response;

      const activeArtifacts: MemoryArtifactRef[] = [];
      for (const handle of body.value.activeArtifacts ?? []) {
        const parsed = await artifactOr400(
          handle,
          actor.value.visibility,
          "activeArtifacts",
        );
        if (!parsed.ok) return parsed.response;
        activeArtifacts.push(parsed.value);
      }

      let related: MemoryArtifactRef | null = null;
      if (body.value.related !== undefined && body.value.related !== null) {
        const parsed = await artifactOr400(
          body.value.related,
          actor.value.visibility,
          "related",
        );
        if (!parsed.ok) return parsed.response;
        related = parsed.value;
      }

      const recalled = await deps.getRecall().recall(
        {
          query: body.value.query ?? null,
          related,
          activeArtifacts,
          ...(body.value.scope !== undefined
            ? { scope: body.value.scope }
            : {}),
          ...(body.value.budgetChars !== undefined
            ? { budgetChars: body.value.budgetChars }
            : {}),
        },
        actor.value,
      );

      // The `expanded` half of R15's two delivery channels, recorded at the one
      // surface every recall caller reaches. A user actor names no conversation
      // to hold the watermark, so a Library browse records nothing.
      if (recalled.ok && actor.value.kind === "agent") {
        const conversationId = actor.value.conversationId;
        try {
          await deps.getTelemetry().recordDelivery({
            conversationId,
            channel: "expanded",
            notes: recalled.value.entries.map(({ note, statusLine }) => ({
              memoryId: note.id,
              revision: note.revision,
              statusDelivered: statusLine !== null,
            })),
          });
        } catch (err) {
          logger.warn("memory.routes.recall_watermark_failed", {
            conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return resultResponse(recalled, (pack) => ({ pack }));
    },

    /**
     * The index a conversation's NEXT turn would inject, rendered through the
     * same provider the turn uses. There is no project- or session-level
     * preview: a block is composed for one conversation, and a synthetic one
     * would be a block no turn will ever carry (R12).
     */
    async indexGET(request) {
      const query = parseQuery(
        request,
        ["conversation", "full"],
        indexQuerySchema,
      );
      if (!query.ok) return query.response;
      // Reading a conversation's block is a read; the soft token gate still
      // applies, so an invalid token fails here rather than being ignored.
      const actor = await actorFromQuery(request);
      if (!actor.ok) return actor.response;

      const location = await deps.locateConversation(query.value.conversation);
      if (location === null) {
        return notFound(
          `No conversation ${query.value.conversation} exists`,
          "conversation_not_found",
          { conversation: query.value.conversation },
          "Name a conversation that exists; 'cctl conversation list' shows them.",
          "The index is composed for one conversation's next turn, so there is nothing to render without one.",
        );
      }
      const lane =
        location.conversation.kind === "session"
          ? await deps.findLaneBinding({
              projectPath: location.projectPath,
              sessionName: location.conversation.sessionName,
              conversationId: query.value.conversation,
            })
          : null;

      // Read, never assumed. A conversation whose next turn must create a
      // runtime with no resume handle is due a FULL block even though its
      // delivery state says otherwise, and a preview that assumed no context
      // loss would print a delta for precisely that conversation.
      const contextLoss = await deps.readNextTurnContextLoss(
        query.value.conversation,
      );
      const delivery = await deps.getIndexProvider().previewForConversation(
        {
          projectPath: location.projectPath,
          conversationId: query.value.conversation,
          conversation: location.conversation,
          role: location.role,
          workflowExecutionId: lane?.executionId ?? null,
          workflowContextId: lane?.contextId ?? null,
          ...contextLoss,
        },
        query.value.full ? "full" : "next-turn",
      );
      // The mode rides the envelope rather than being inferred from the text:
      // a caller comparing this render against an injected block has to know
      // WHICH render it asked for, and a conversation told nothing composes no
      // text to infer it from.
      return NextResponse.json(
        { mode: delivery?.mode ?? null, block: delivery?.rendered ?? null },
        { status: 200 },
      );
    },

    async reviewGET(request) {
      const query = parseQuery(
        request,
        [
          ...ACTOR_SCOPE_PARAMS,
          "promotionCandidates",
          "projectCandidates",
          "sessionName",
          "sessionCreatedAt",
        ],
        reviewQuerySchema,
      );
      if (!query.ok) return query.response;
      const actor = await resolveActor(request, query.value);
      if (!actor.ok) return actor.response;

      const { sessionName, sessionCreatedAt } = query.value;
      if ((sessionName === undefined) !== (sessionCreatedAt === undefined)) {
        return memoryValidationFailedResponse([
          {
            path: "sessionName",
            message:
              "a session incarnation is a name AND a created-at — state both or neither",
          },
        ]);
      }
      const projectPath = actor.value.visibility.projectPath;
      if (sessionName !== undefined && projectPath === null) {
        return memoryValidationFailedResponse([
          {
            path: "project",
            message:
              "a session incarnation is identified within its project — name the project",
          },
        ]);
      }

      const entries = await deps.getFreshness().buildReviewQueue({
        visibility: actor.value.visibility,
        ...(query.value.projectCandidates && projectPath !== null
          ? { projectCandidates: projectPath }
          : {}),
        ...(query.value.promotionCandidates
          ? { promotionCandidates: true }
          : {}),
        ...(sessionName !== undefined &&
        sessionCreatedAt !== undefined &&
        projectPath !== null
          ? { session: { projectPath, sessionName, sessionCreatedAt } }
          : {}),
      });
      return NextResponse.json({ entries }, { status: 200 });
    },

    /**
     * The portable archive of everything the caller can see, archived and
     * proposed records included: lifecycle is one of the fields the archive
     * has to carry, so an export that silently dropped them would not be the
     * current state at all (R14.2).
     */
    async exportGET(request) {
      const query = parseQuery(
        request,
        [...ACTOR_SCOPE_PARAMS, "scope"],
        exportQuerySchema,
      );
      if (!query.ok) return query.response;
      const actor = await resolveActor(request, query.value);
      if (!actor.ok) return actor.response;

      const listed = await deps.getService().list(
        {
          ...(query.value.scope !== undefined
            ? { scope: query.value.scope }
            : {}),
          includeArchived: true,
        },
        actor.value,
      );
      if (!listed.ok) return memoryErrorResponse(listed.error);

      const notes = listed.value;
      const links = await deps.listLinksForNotes(notes.map((note) => note.id));
      const linksByMemoryId = new Map<string, MemoryLink[]>();
      for (const link of links) {
        const existing = linksByMemoryId.get(link.memoryId);
        if (existing === undefined) linksByMemoryId.set(link.memoryId, [link]);
        else existing.push(link);
      }

      // Lineage targets the selection does not hold: a promoted project note's
      // predecessor is session-scoped, and a --scope narrowing drops it. The
      // pointer is part of the note's current state, so the handle is looked up
      // rather than rendered as null.
      const lineageHandlesByMemoryId = await resolveLineageHandles(
        notes,
        deps.findNoteById,
        new Set(notes.map((note) => note.id)),
      );

      const generatedAt = new Date().toISOString();
      return NextResponse.json(
        {
          archive: renderMemoryArchive({
            generatedAt,
            notes,
            linksByMemoryId,
            lineageHandlesByMemoryId,
          }),
          noteCount: notes.length,
          generatedAt,
        },
        { status: 200 },
      );
    },
  };
}

function defaultDeps(): MemoryRouteDeps {
  return {
    getService: () => getMemoryService(),
    getRecall: () => getMemoryRecallService(),
    getTelemetry: () => getMemoryTelemetryService(),
    getFreshness: () => getMemoryFreshnessEngine(),
    getIndexProvider: () => getMemoryIndexContextProvider(),
    findNoteById: (memoryId) => getMemoryRepo().find(memoryId),
    listLinksForNotes: (memoryIds) =>
      getMemoryRepo().listLinksForNotes(memoryIds),
    resolveProjectPath: (projectName) => defaultResolveProjectPath(projectName),
    async findTicketId(reference) {
      const ticket =
        "byId" in reference
          ? await getTicketsRepo().findById(reference.byId)
          : await getTicketsRepo().find(
              reference.projectPath,
              reference.number,
            );
      return ticket?.id ?? null;
    },
    async locateConversation(conversationId) {
      const store = getStateStore();
      const inSession = await store.getConversationById(conversationId);
      if (inSession !== null) {
        return {
          projectPath: inSession.projectPath,
          conversation: {
            kind: "session",
            sessionName: inSession.sessionName,
          },
          role: inSession.conversation.role,
        };
      }
      const inProject = await store.getProjectConversationById(conversationId);
      if (inProject !== null) {
        return {
          projectPath: inProject.projectPath,
          conversation: { kind: "project" },
          role: inProject.conversation.role,
        };
      }
      return null;
    },
    async findSessionCreatedAt(projectPath, sessionName) {
      const session = await getStateStore().getSession(
        projectPath,
        sessionName,
      );
      return session?.createdAt ?? null;
    },
    readNextTurnContextLoss: (conversationId) =>
      readNextTurnContextLoss(
        {
          async findConversation(id) {
            const store = getStateStore();
            // A ready checkpoint seeds the next turn's FRESH runtime, so the
            // preview reads that intent from the checkpoint authority rather
            // than inferring it from the cleared handle.
            const pendingCheckpoint = async (
              key: CheckpointScopeKey,
            ): Promise<boolean> =>
              (await getConversationCheckpointsRepo().getStateForAdmission(key))
                .active?.phase === "ready";
            const session = await store.getConversationById(id);
            if (session !== null) {
              return {
                projectPath: session.projectPath,
                sessionName: session.sessionName,
                promptCount: session.conversation.promptCount,
                hasResumeHandle: session.conversation.backendRef !== null,
                pendingCheckpoint: await pendingCheckpoint({
                  scope: "session",
                  projectPath: session.projectPath,
                  sessionName: session.sessionName,
                  conversationId: id,
                }),
              };
            }
            const project = await store.getProjectConversationById(id);
            if (project === null) return null;
            return {
              projectPath: project.projectPath,
              // A project conversation has no session, and so no charter.
              sessionName: null,
              promptCount: project.conversation.promptCount,
              hasResumeHandle: project.conversation.backendRef !== null,
              pendingCheckpoint: await pendingCheckpoint({
                scope: "project",
                projectPath: project.projectPath,
                sessionName: null,
                conversationId: id,
              }),
            };
          },
          getRuntimeConfiguration: getConversationRuntimeConfiguration,
          readDesiredRuntimeConfiguration:
            readDesiredConversationRuntimeConfiguration,
        },
        conversationId,
      ),
    async findLaneBinding(ref) {
      const execution = await getStateStore().getActiveGraphWorkflowExecution(
        ref.projectPath,
        ref.sessionName,
      );
      return execution === null
        ? null
        : findLaneBindingForConversation(execution, ref.conversationId);
    },
    auth: createAgentAuth(),
  };
}

// ---------------------------------------------------------------------------
// Default traced exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _handlers = createMemoryRouteHandlers();
export const listMemoryNotes = withTracing(_handlers.listGET);
export const createMemoryNote = withTracing(_handlers.createPOST);
export const getMemoryNote = withTracing(_handlers.detailGET);
export const updateMemoryNote = withTracing(_handlers.detailPATCH);
export const deleteMemoryNote = withTracing(_handlers.detailDELETE);
export const listMemoryNoteRevisions = withTracing(_handlers.revisionsGET);
export const linkMemoryNote = withTracing(_handlers.linksPOST);
export const unlinkMemoryNote = withTracing(_handlers.linksDELETE);
export const markMemoryNoteReviewed = withTracing(_handlers.reviewedPOST);
export const recordMemoryRederivation = withTracing(_handlers.rederivedPOST);
export const promoteMemoryNote = withTracing(_handlers.promotePOST);
export const archiveMemoryNote = withTracing(_handlers.archivePOST);
export const restoreMemoryNote = withTracing(_handlers.restorePOST);
export const decideMemoryProposal = withTracing(_handlers.proposalPOST);
export const recallMemory = withTracing(_handlers.recallPOST);
export const previewMemoryIndex = withTracing(_handlers.indexGET);
export const listMemoryReviewQueue = withTracing(_handlers.reviewGET);
export const exportMemoryArchive = withTracing(_handlers.exportGET);
