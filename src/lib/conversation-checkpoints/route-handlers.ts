import { resolveSessionRoute } from "@/lib/conversations/route-resolution";
import { resolveProjectOr404 } from "@/lib/shared/route-resolution";
/**
 * Scoped HTTP surface for the checkpoint operation (design §8 route table).
 *
 * One handler core serves both conversation route families through the shared
 * scoped-target resolver, so the session and project surfaces cannot drift.
 * Every mutating leaf composes the conversation manager's semantic commands —
 * the single lifecycle owner — and every read composes the checkpoint
 * repository's public receipt projection. This module owns no lifecycle
 * decision of its own: it validates the request, addresses the conversation,
 * and translates the manager's typed outcome into a status code.
 *
 * The seed is disclosed by exactly one branch (`detail=seed`) reading the
 * immutable payload. Nothing else here can reach payload text, and no handler
 * composes the operation's protected provider references at all — the receipt
 * projection is the only thing these routes serialize.
 */

import { NextResponse } from "next/server";
import { toPublicConversationState } from "@/lib/conversations/schemas";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
import { checkpointForkRequestSchema } from "./fork-schemas";
import {
  CheckpointForkError,
  type createCheckpointForkService,
} from "./fork-service";
import { getCheckpointForkService } from "./fork-production";
import { z } from "zod";

import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import {
  projectConversationTarget,
  sessionConversationTarget,
  conversationStoreIdentity,
  conversationTargetApiBase,
  conversationTargetLogFields,
} from "@/lib/conversations/conversation-target";
import {
  resolveProjectScopedConversation,
  resolveSessionScopedConversation,
  type ScopedConversationRouteDeps,
  type ScopedConversationTarget,
} from "@/lib/conversations/scoped-route-target";
import { createLogger, withTracing, type Logger } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { jsonError, notFound } from "@/lib/shared/route-resolution";
import { getProjectConversation, getSession } from "@/lib/state-store";
import {
  cancelConversationCheckpoint,
  checkConversationCheckpoint,
  reconcileConversationCheckpoint,
  startConversationCheckpoint,
  type ConversationCheckpointCancel,
  type ConversationCheckpointCheck,
  type ConversationCheckpointReconcile,
  type ConversationCheckpointRequest,
  type ConversationCheckpointStart,
} from "@/lib/workflows/conversation/manager";
import { checkpointScopeKeyForStoreIdentity } from "@/lib/workflows/conversation/actor-input-loader";
import type { ConversationAddress } from "@/lib/workflows/conversation/turn-spec";

import type { CheckpointRefusal, CheckpointRefusalCode } from "./admission";
import { checkpointReceipt, type CheckpointReceipt } from "./receipt";
import {
  MAX_CHECKPOINT_LIST_LIMIT,
  type ConversationCheckpointsRepo,
} from "./repo";
import type { CheckpointOperation, CheckpointScopeKey } from "./schemas";

const logger = createLogger("conversation-checkpoints");

type RouteContext = { params: Promise<Record<string, string>> };

export interface CheckpointRouteDeps extends ScopedConversationRouteDeps {
  forkService?: ReturnType<typeof createCheckpointForkService>;
  repo(): Promise<ConversationCheckpointsRepo>;
  startCheckpoint(
    input: ConversationCheckpointRequest,
  ): Promise<ConversationCheckpointStart>;
  checkCheckpoint(
    address: ConversationAddress,
    options?: { recover?: string | null },
  ): Promise<ConversationCheckpointCheck>;
  cancelCheckpoint(input: {
    address: ConversationAddress;
    operationId: string;
  }): Promise<ConversationCheckpointCancel>;
  reconcileCheckpoint(input: {
    address: ConversationAddress;
    operationId: string;
  }): Promise<ConversationCheckpointReconcile>;
  auth: AgentAuth;
  log?: Logger;
}

function defaultDeps(): CheckpointRouteDeps {
  return {
    resolveProjectPath,
    getSession,
    getProjectConversation,
    async repo() {
      const { getConversationCheckpointsRepo } =
        await import("./service-factory");
      return getConversationCheckpointsRepo();
    },
    startCheckpoint: startConversationCheckpoint,
    checkCheckpoint: checkConversationCheckpoint,
    cancelCheckpoint: cancelConversationCheckpoint,
    reconcileCheckpoint: reconcileConversationCheckpoint,
    auth: createAgentAuth(),
  };
}

// ---------------------------------------------------------------------------
// Request contracts
// ---------------------------------------------------------------------------

/**
 * The start body. `requestId` is a UUID the CALLER generates once per
 * invocation and reuses on retransmit — it is the operation's identity and its
 * idempotency key, so a client that mints a fresh value per retry would open a
 * second operation rather than rejoin its own.
 */
export const startCheckpointRequestSchema = z
  .object({
    requestId: z.uuid(),
    /** Explicit recovery: the recovery-required operation this build supersedes. */
    recoversOperationId: z.string().min(1).optional(),
  })
  .strict();
export type StartCheckpointRequest = z.infer<
  typeof startCheckpointRequestSchema
>;

export const checkpointDetailSchema = z.enum(["receipt", "seed"]);

const listQuerySchema = z
  .object({
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(MAX_CHECKPOINT_LIST_LIMIT).optional(),
  })
  .strict();

interface QueryIssue {
  path: string;
  message: string;
}

const INTEGER_PATTERN = /^\d+$/;

function invalidRequest(code: string, issues: QueryIssue[]): Response {
  return NextResponse.json(
    {
      error: "Invalid checkpoint request",
      code,
      details: { issues },
      issues,
    },
    { status: 400 },
  );
}

function zodIssues(error: z.ZodError): QueryIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Coerce the two integer list params before validation, keeping a value that
 * is not an integer literal out of `raw` so the schema reports the field
 * rather than a type mismatch the caller cannot act on.
 */
export function parseCheckpointListQuery(url: string):
  | { ok: true; options: z.infer<typeof listQuerySchema> }
  | {
      ok: false;
      issues: QueryIssue[];
    } {
  const searchParams = new URL(url).searchParams;
  const raw: Record<string, unknown> = {};
  const issues: QueryIssue[] = [];
  for (const key of ["before", "limit"] as const) {
    const value = searchParams.get(key);
    if (value === null) continue;
    if (!INTEGER_PATTERN.test(value)) {
      issues.push({ path: key, message: "expected a positive integer" });
      continue;
    }
    raw[key] = Number(value);
  }
  const parsed = listQuerySchema.safeParse(raw);
  if (!parsed.success || issues.length > 0) {
    return {
      ok: false,
      issues: [...issues, ...(parsed.success ? [] : zodIssues(parsed.error))],
    };
  }
  return { ok: true, options: parsed.data };
}

// ---------------------------------------------------------------------------
// Refusal translation
// ---------------------------------------------------------------------------

/**
 * The one refusal → status mapping (R8.1). A refusal is a DOMAIN outcome, so
 * the code travels in the body either way; the status only says which kind of
 * problem it is. Missing/wrong-scope resources are 404, the two states that
 * make a checkpoint impossible rather than untimely are 422, and everything
 * else is a lifecycle conflict a caller can retry after acting.
 */
export function checkpointRefusalStatus(code: CheckpointRefusalCode): number {
  switch (code) {
    case "conversation_not_found":
    case "checkpoint_not_found":
    case "target_conversation_missing":
      return 404;
    case "backend_unsupported":
    case "no_recorded_history":
      return 422;
    default:
      return 409;
  }
}

function refusalResponse(
  refusal: CheckpointRefusal,
  receipt: CheckpointReceipt | null = null,
): Response {
  return NextResponse.json(
    {
      error: refusal.reason,
      code: refusal.code,
      refusal,
      ...(receipt === null ? {} : { receipt }),
    },
    { status: checkpointRefusalStatus(refusal.code) },
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function addressOf(
  target: Pick<ScopedConversationTarget, "projectPath" | "target">,
): ConversationAddress {
  return { projectPath: target.projectPath, target: target.target };
}

function scopeKeyOf(
  target: Pick<ScopedConversationTarget, "projectPath" | "target">,
): CheckpointScopeKey {
  return checkpointScopeKeyForStoreIdentity(
    conversationStoreIdentity(addressOf(target)),
  );
}

function statusUrl(
  target: ScopedConversationTarget,
  operationId: string,
): string {
  return `${conversationTargetApiBase(target.target)}/checkpoints/${encodeURIComponent(operationId)}`;
}

/**
 * The receipt for an operation the manager just returned. The manager hands
 * back the operation row; the payload half of the receipt is a scoped read, so
 * a frozen checkpoint reports its bytes/hash/omissions on every outcome.
 */
async function receiptFor(
  repo: ConversationCheckpointsRepo,
  key: CheckpointScopeKey,
  operation: CheckpointOperation,
): Promise<CheckpointReceipt> {
  return (
    (await repo.getReceipt(key, operation.id)) ??
    checkpointReceipt(operation, null)
  );
}

export function createCheckpointRouteHandlers(
  deps: CheckpointRouteDeps = defaultDeps(),
) {
  const log = deps.log ?? logger;

  async function fork(
    request: Request,
    target: Pick<ScopedConversationTarget, "projectPath" | "target">,
    operationId: string,
    check = false,
  ): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const parsed = checkpointForkRequestSchema.safeParse(raw);
    if (!parsed.success)
      return invalidRequest("invalid_checkpoint_fork", zodIssues(parsed.error));
    const service = deps.forkService ?? getCheckpointForkService();
    const input = {
      projectPath: target.projectPath,
      source: target.target,
      operationId,
      request: parsed.data,
    };
    try {
      if (check) {
        await service.check(input);
        return NextResponse.json({ eligible: true });
      }
      const created = await service.create(input);
      const receipt = await (
        await deps.repo()
      ).getReceipt(
        { ...scopeKeyOf(target), conversationId: created.conversation.id },
        created.operation.id,
      );
      return NextResponse.json(
        {
          conversation: toPublicConversationState(created.conversation),
          receipt,
          reused: created.reused,
        },
        { status: created.reused ? 200 : 201 },
      );
    } catch (error) {
      if (
        error instanceof CheckpointForkError ||
        error instanceof BackendAdmissionError
      ) {
        log.info("checkpoint.fork.route_refused", {
          ...conversationTargetLogFields(target.target),
          code: error.code,
        });
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error instanceof CheckpointForkError ? error.status : 422 },
        );
      }
      throw error;
    }
  }

  async function start(
    request: Request,
    target: ScopedConversationTarget,
  ): Promise<Response> {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return invalidRequest("invalid_checkpoint_request", [
        { path: "", message: "request body must be JSON" },
      ]);
    }
    const parsed = startCheckpointRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidRequest(
        "invalid_checkpoint_request",
        zodIssues(parsed.error),
      );
    }

    const outcome = await deps.startCheckpoint({
      address: addressOf(target),
      requestId: parsed.data.requestId,
      recover: parsed.data.recoversOperationId ?? null,
    });
    if (outcome.kind === "refused") {
      log.info("checkpoint.route.start_refused", {
        ...conversationTargetLogFields(target.target),
        code: outcome.refusal.code,
        operationId: outcome.refusal.operationId,
        phase: outcome.refusal.phase,
      });
      return refusalResponse(outcome.refusal);
    }

    log.info("checkpoint.route.start_admitted", {
      ...conversationTargetLogFields(target.target),
      operationId: outcome.operation.id,
      ordinal: outcome.operation.ordinal,
      outcome: outcome.kind,
      recoversOperationId: outcome.operation.recoversOperationId,
    });
    // 202 follows durable admission: the manager returns only once the
    // operation row exists, so the status URL below already resolves.
    return NextResponse.json(
      {
        outcome: outcome.kind,
        receipt: outcome.receipt,
        statusUrl: statusUrl(target, outcome.operation.id),
      },
      { status: 202 },
    );
  }

  async function eligibility(
    request: Request,
    target: ScopedConversationTarget,
  ): Promise<Response> {
    const recover =
      new URL(request.url).searchParams.get("recoversOperationId") ?? null;
    const check = await deps.checkCheckpoint(addressOf(target), { recover });
    return NextResponse.json({
      eligible: check.eligible,
      refusals: check.refusals,
      active: check.active,
      hosted: check.hosted,
    });
  }

  async function list(
    request: Request,
    target: ScopedConversationTarget,
  ): Promise<Response> {
    const query = parseCheckpointListQuery(request.url);
    if (!query.ok) {
      return invalidRequest("invalid_checkpoint_list_options", query.issues);
    }
    const repo = await deps.repo();
    const page = await repo.listReceipts(scopeKeyOf(target), query.options);
    return NextResponse.json(page);
  }

  async function getOne(
    request: Request,
    target: ScopedConversationTarget,
    operationId: string,
  ): Promise<Response> {
    const rawDetail = new URL(request.url).searchParams.get("detail");
    const detail = checkpointDetailSchema.safeParse(rawDetail ?? "receipt");
    if (!detail.success) {
      return invalidRequest("invalid_checkpoint_detail", [
        { path: "detail", message: "expected receipt or seed" },
      ]);
    }

    const repo = await deps.repo();
    const key = scopeKeyOf(target);
    const receipt = await repo.getReceipt(key, operationId);
    if (!receipt) return checkpointNotFound();

    if (detail.data === "receipt") return NextResponse.json({ receipt });

    // The one seed disclosure: the immutable payload exactly as it was frozen,
    // never the rolling reading artifact and never a re-rendered seed.
    const payload = await repo.getPayload(key, operationId);
    return NextResponse.json({ receipt, seed: payload });
  }

  /**
   * The refusal half of a lifecycle diagnostic. A refused cancel or reconcile
   * answers the caller with a status code and nothing durable changes, so
   * without this line the only record of an operator asking is the HTTP access
   * log — which does not carry which operation, or the phase it is stuck in.
   */
  function logRefusal(
    event: string,
    target: ScopedConversationTarget,
    operationId: string,
    refusal: CheckpointRefusal,
  ): void {
    log.info(event, {
      ...conversationTargetLogFields(target.target),
      operationId: refusal.operationId ?? operationId,
      code: refusal.code,
      phase: refusal.phase,
    });
  }

  async function cancel(
    _request: Request,
    target: ScopedConversationTarget,
    operationId: string,
  ): Promise<Response> {
    const outcome = await deps.cancelCheckpoint({
      address: addressOf(target),
      operationId,
    });
    if (outcome.kind === "refused") {
      logRefusal(
        "checkpoint.route.cancel_refused",
        target,
        operationId,
        outcome.refusal,
      );
      return refusalResponse(outcome.refusal);
    }

    const repo = await deps.repo();
    log.info("checkpoint.route.cancel_settled", {
      ...conversationTargetLogFields(target.target),
      operationId: outcome.operation.id,
      outcome: outcome.kind,
      phase: outcome.operation.phase,
    });
    return NextResponse.json({
      outcome: outcome.kind,
      receipt: await receiptFor(repo, scopeKeyOf(target), outcome.operation),
    });
  }

  async function reconcile(
    _request: Request,
    target: ScopedConversationTarget,
    operationId: string,
  ): Promise<Response> {
    const outcome = await deps.reconcileCheckpoint({
      address: addressOf(target),
      operationId,
    });
    if (outcome.kind === "refused") {
      logRefusal(
        "checkpoint.route.reconcile_refused",
        target,
        operationId,
        outcome.refusal,
      );
      return refusalResponse(outcome.refusal);
    }

    const repo = await deps.repo();
    const receipt = await receiptFor(
      repo,
      scopeKeyOf(target),
      outcome.operation,
    );
    // A blocked repair still answers with the operation's own receipt: the
    // caller needs the phase it is actually stuck in, not only the refusal.
    if (outcome.kind === "blocked") {
      logRefusal(
        "checkpoint.route.reconcile_refused",
        target,
        operationId,
        outcome.refusal,
      );
      return refusalResponse(outcome.refusal, receipt);
    }

    log.info("checkpoint.route.reconcile_settled", {
      ...conversationTargetLogFields(target.target),
      operationId: outcome.operation.id,
      outcome: outcome.kind,
      phase: outcome.operation.phase,
    });
    return NextResponse.json({ outcome: outcome.kind, receipt });
  }

  // -------------------------------------------------------------------------
  // Scope adapters
  // -------------------------------------------------------------------------

  type ScopedHandler = (
    request: Request,
    target: ScopedConversationTarget,
  ) => Promise<Response>;
  type ScopedItemHandler = (
    request: Request,
    target: ScopedConversationTarget,
    operationId: string,
  ) => Promise<Response>;

  type Resolve = (
    deps: ScopedConversationRouteDeps,
    context: RouteContext,
  ) => Promise<
    | { ok: true; value: ScopedConversationTarget }
    | { ok: false; response: Response }
  >;

  function withTarget(resolve: Resolve, handler: ScopedHandler) {
    return async (
      request: Request,
      context: RouteContext,
    ): Promise<Response> => {
      const denied = await checkOptionalToken(request);
      if (denied) return denied;
      const target = await resolve(deps, context);
      if (!target.ok) return target.response;
      return handler(request, target.value);
    };
  }

  function withItemTarget(resolve: Resolve, handler: ScopedItemHandler) {
    return async (
      request: Request,
      context: RouteContext,
    ): Promise<Response> => {
      const denied = await checkOptionalToken(request);
      if (denied) return denied;
      const target = await resolve(deps, context);
      if (!target.ok) return target.response;
      const params = await context.params;
      const operationId = params["checkpointId"] ?? "";
      if (operationId === "") return checkpointNotFound();
      return handler(request, target.value, operationId);
    };
  }

  function withForkTarget(scope: "session" | "project", check: boolean) {
    return async (
      request: Request,
      context: RouteContext,
    ): Promise<Response> => {
      const denied = await checkOptionalToken(request);
      if (denied) return denied;
      const params = await context.params;
      const projectName = params["name"] ?? "";
      const conversationId = params["conversationId"] ?? "";
      const operationId = params["checkpointId"] ?? "";
      if (!conversationId || !operationId) return checkpointNotFound();
      if (scope === "session") {
        const base = await resolveSessionRoute(deps, context);
        if (!base.ok) return base.response;
        return fork(
          request,
          {
            projectPath: base.value.projectPath,
            target: sessionConversationTarget(
              projectName,
              base.value.sessionName,
              conversationId,
            ),
          },
          operationId,
          check,
        );
      }
      const project = await resolveProjectOr404(deps, projectName);
      if (!project.ok) return project.response;
      return fork(
        request,
        {
          projectPath: project.value,
          target: projectConversationTarget(projectName, conversationId),
        },
        operationId,
        check,
      );
    };
  }

  async function checkOptionalToken(
    request: Request,
  ): Promise<Response | null> {
    const validation = await deps.auth.validateOptionalToken(request);
    return validation.kind === "invalid"
      ? jsonError("Invalid Command Center API token", 401)
      : null;
  }

  return {
    sessionFork: withForkTarget("session", false),
    sessionForkCheck: withForkTarget("session", true),
    projectFork: withForkTarget("project", false),
    projectForkCheck: withForkTarget("project", true),
    sessionList: withTarget(resolveSessionScopedConversation, list),
    sessionStart: withTarget(resolveSessionScopedConversation, start),
    sessionEligibility: withTarget(
      resolveSessionScopedConversation,
      eligibility,
    ),
    sessionGet: withItemTarget(resolveSessionScopedConversation, getOne),
    sessionCancel: withItemTarget(resolveSessionScopedConversation, cancel),
    sessionReconcile: withItemTarget(
      resolveSessionScopedConversation,
      reconcile,
    ),
    projectList: withTarget(resolveProjectScopedConversation, list),
    projectStart: withTarget(resolveProjectScopedConversation, start),
    projectEligibility: withTarget(
      resolveProjectScopedConversation,
      eligibility,
    ),
    projectGet: withItemTarget(resolveProjectScopedConversation, getOne),
    projectCancel: withItemTarget(resolveProjectScopedConversation, cancel),
    projectReconcile: withItemTarget(
      resolveProjectScopedConversation,
      reconcile,
    ),
  };
}

function checkpointNotFound(): Response {
  return notFound("Checkpoint operation not found", "checkpoint_not_found");
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

let _handlers: ReturnType<typeof createCheckpointRouteHandlers> | null = null;
function handlers(): ReturnType<typeof createCheckpointRouteHandlers> {
  _handlers ??= createCheckpointRouteHandlers();
  return _handlers;
}

function shell(
  select: (
    all: ReturnType<typeof createCheckpointRouteHandlers>,
  ) => (request: Request, context: RouteContext) => Promise<Response>,
) {
  return withTracing((request: Request, context: RouteContext) =>
    select(handlers())(request, context),
  );
}

export const listSessionConversationCheckpoints = shell((h) => h.sessionList);
export const forkSessionConversationCheckpoint = shell((h) => h.sessionFork);
export const checkSessionConversationCheckpointFork = shell(
  (h) => h.sessionForkCheck,
);
export const forkProjectConversationCheckpoint = shell((h) => h.projectFork);
export const checkProjectConversationCheckpointFork = shell(
  (h) => h.projectForkCheck,
);
export const startSessionConversationCheckpoint = shell((h) => h.sessionStart);
export const getSessionConversationCheckpointEligibility = shell(
  (h) => h.sessionEligibility,
);
export const getSessionConversationCheckpoint = shell((h) => h.sessionGet);
export const cancelSessionConversationCheckpoint = shell(
  (h) => h.sessionCancel,
);
export const reconcileSessionConversationCheckpoint = shell(
  (h) => h.sessionReconcile,
);
export const listProjectConversationCheckpoints = shell((h) => h.projectList);
export const startProjectConversationCheckpoint = shell((h) => h.projectStart);
export const getProjectConversationCheckpointEligibility = shell(
  (h) => h.projectEligibility,
);
export const getProjectConversationCheckpoint = shell((h) => h.projectGet);
export const cancelProjectConversationCheckpoint = shell(
  (h) => h.projectCancel,
);
export const reconcileProjectConversationCheckpoint = shell(
  (h) => h.projectReconcile,
);
