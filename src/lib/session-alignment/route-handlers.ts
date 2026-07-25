/**
 * HTTP route handlers for the session-alignment REST surface.
 *
 * The route modules under
 * `src/app/api/projects/[name]/sessions/[session]/alignment/**` are thin
 * re-exports over `createSessionAlignmentRouteHandlers()`. Keeping handler logic
 * here lets route tests instantiate the factory with an injected service +
 * project resolver without spinning up Next.js, mirroring the collaboration
 * route-handler pattern in `src/lib/workflows/collaboration/route-handlers.ts`.
 *
 * Surface (all SESSION-scoped):
 *
 *  - GET  /alignment                  — aggregate state (active/draft/history/decisions/pendingProposals/preview)
 *  - POST /alignment/charter/approve  — approve a draft (the Approve-Charter gate)
 *  - POST /alignment/charter/reject   — discard a draft, leaving the active charter unchanged
 *  - POST /alignment/decisions/resolve— resolve a pending proposal batch
 *  - GET  /alignment/diff?from&to     — per-version content diff
 *  - POST /alignment/rollback         — roll back to a prior version
 */
import { NextResponse } from "next/server";
import {
  jsonError,
  notFound,
  refuseProjectSentinelSessionParam,
  resolveProjectOr404,
} from "@/lib/shared/route-resolution";
import { z } from "zod";

import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getErrorMessage } from "@/lib/shared/errors";

import {
  approveDraftRequestSchema,
  rejectDraftRequestSchema,
  resolveProposalsRequestSchema,
  rollbackRequestSchema,
} from "./schemas";
import { createSessionAlignmentServiceForProduction } from "./service-factory";
import {
  AlignmentDraftNotFoundError,
  AlignmentNotSupportedError,
  AlignmentProposalBatchNotFoundError,
  AlignmentVersionNotFoundError,
  type SessionAlignmentService,
} from "./service";

const logger = createLogger("session-alignment.route");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

/** Injected deps (method syntax → bivariant params). */
export interface SessionAlignmentRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  service: SessionAlignmentService;
}

export interface SessionAlignmentRouteHandlers {
  getAlignmentState(request: Request, context: RouteContext): Promise<Response>;
  approveCharterDraft(
    request: Request,
    context: RouteContext,
  ): Promise<Response>;
  rejectCharterDraft(
    request: Request,
    context: RouteContext,
  ): Promise<Response>;
  resolveDecisionProposals(
    request: Request,
    context: RouteContext,
  ): Promise<Response>;
  getAlignmentDiff(request: Request, context: RouteContext): Promise<Response>;
  rollbackAlignment(request: Request, context: RouteContext): Promise<Response>;
}

/**
 * Coerce the `from`/`to` diff query params: each must be present and an integer.
 * `z.coerce.number()` turns `""`/missing (→ NaN) and non-numeric strings into a
 * validation failure surfaced as a 400; the `.int()` rejects fractional values.
 */
const diffQuerySchema = z.object({
  from: z.coerce.number().int(),
  to: z.coerce.number().int(),
});

function buildValidationErrorResponse(error: z.ZodError): Response {
  return NextResponse.json(
    {
      error: "Invalid request body",
      issues: error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    },
    { status: 400 },
  );
}

/**
 * Map a service-thrown domain error to its HTTP response. `AlignmentNotSupported`
 * (optimistic/unavailable session) and a stale/already-resolved proposal batch
 * are 409 conflicts; an unknown draft or version is a 404; anything else is a
 * 500 carrying the error message.
 */
function mapDomainError(err: unknown): Response {
  if (err instanceof AlignmentNotSupportedError) {
    return jsonError(err.message, 409);
  }
  if (err instanceof AlignmentProposalBatchNotFoundError) {
    return jsonError(err.message, 409);
  }
  if (err instanceof AlignmentDraftNotFoundError) {
    return notFound(err.message);
  }
  if (err instanceof AlignmentVersionNotFoundError) {
    return notFound(err.message);
  }
  logger.error("session-alignment.route.unexpected_error", {
    error: getErrorMessage(err),
  });
  return jsonError(getErrorMessage(err), 500);
}

async function resolveSessionParams(
  context: RouteContext,
  deps: SessionAlignmentRouteDeps,
): Promise<{ error: Response } | { projectPath: string; sessionName: string }> {
  const p = await context.params;
  const name = p["name"] ?? "";
  const sessionName = decodeURIComponent(p["session"] ?? "");

  if (name.length === 0 || sessionName.length === 0) {
    return {
      error: jsonError("Project and session names are required", 400),
    };
  }

  // Alignment resolves the project itself rather than going through the session
  // resolution seam, so the seam's refusal never runs for it. Without this guard
  // the sentinel is carried into the service as a session name and answered as
  // an alignment domain outcome instead of a malformed address (R1.2).
  const refusal = refuseProjectSentinelSessionParam(sessionName, name);
  if (refusal) return { error: refusal };

  const project = await resolveProjectOr404(deps, name);
  if (!project.ok) return { error: project.response };

  return { projectPath: project.value, sessionName };
}

async function readJsonBody(
  request: Request,
): Promise<{ error: Response } | { body: unknown }> {
  try {
    return { body: await request.json() };
  } catch {
    return { error: jsonError("Request body must be valid JSON", 400) };
  }
}

export function createSessionAlignmentRouteHandlers(
  deps: SessionAlignmentRouteDeps,
): SessionAlignmentRouteHandlers {
  return {
    async getAlignmentState(_request, context) {
      const resolution = await resolveSessionParams(context, deps);
      if ("error" in resolution) return resolution.error;

      try {
        const state = await deps.service.getState(
          resolution.projectPath,
          resolution.sessionName,
        );
        return NextResponse.json(state, { status: 200 });
      } catch (err) {
        return mapDomainError(err);
      }
    },

    async approveCharterDraft(request, context) {
      const resolution = await resolveSessionParams(context, deps);
      if ("error" in resolution) return resolution.error;

      const bodyResult = await readJsonBody(request);
      if ("error" in bodyResult) return bodyResult.error;

      const parsed = approveDraftRequestSchema.safeParse(bodyResult.body);
      if (!parsed.success) return buildValidationErrorResponse(parsed.error);

      try {
        const version = await deps.service.approveDraft({
          projectPath: resolution.projectPath,
          sessionName: resolution.sessionName,
          draftId: parsed.data.draftId,
          approver: parsed.data.approver,
        });
        return NextResponse.json(version, { status: 200 });
      } catch (err) {
        return mapDomainError(err);
      }
    },

    async rejectCharterDraft(request, context) {
      const resolution = await resolveSessionParams(context, deps);
      if ("error" in resolution) return resolution.error;

      const bodyResult = await readJsonBody(request);
      if ("error" in bodyResult) return bodyResult.error;

      const parsed = rejectDraftRequestSchema.safeParse(bodyResult.body);
      if (!parsed.success) return buildValidationErrorResponse(parsed.error);

      try {
        await deps.service.rejectDraft({
          projectPath: resolution.projectPath,
          sessionName: resolution.sessionName,
          draftId: parsed.data.draftId,
        });
        return NextResponse.json({ ok: true }, { status: 200 });
      } catch (err) {
        return mapDomainError(err);
      }
    },

    async resolveDecisionProposals(request, context) {
      const resolution = await resolveSessionParams(context, deps);
      if ("error" in resolution) return resolution.error;

      const bodyResult = await readJsonBody(request);
      if ("error" in bodyResult) return bodyResult.error;

      const parsed = resolveProposalsRequestSchema.safeParse(bodyResult.body);
      if (!parsed.success) return buildValidationErrorResponse(parsed.error);

      try {
        const counts = await deps.service.resolveProposals({
          projectPath: resolution.projectPath,
          sessionName: resolution.sessionName,
          batchId: parsed.data.batchId,
          resolutions: parsed.data.resolutions,
        });
        return NextResponse.json(counts, { status: 200 });
      } catch (err) {
        return mapDomainError(err);
      }
    },

    async getAlignmentDiff(request, context) {
      const resolution = await resolveSessionParams(context, deps);
      if ("error" in resolution) return resolution.error;

      const { searchParams } = new URL(request.url);
      const parsed = diffQuerySchema.safeParse({
        from: searchParams.get("from") ?? undefined,
        to: searchParams.get("to") ?? undefined,
      });
      if (!parsed.success) return buildValidationErrorResponse(parsed.error);

      try {
        const diff = await deps.service.diff(
          resolution.projectPath,
          resolution.sessionName,
          parsed.data.from,
          parsed.data.to,
        );
        return NextResponse.json(diff, { status: 200 });
      } catch (err) {
        return mapDomainError(err);
      }
    },

    async rollbackAlignment(request, context) {
      const resolution = await resolveSessionParams(context, deps);
      if ("error" in resolution) return resolution.error;

      const bodyResult = await readJsonBody(request);
      if ("error" in bodyResult) return bodyResult.error;

      const parsed = rollbackRequestSchema.safeParse(bodyResult.body);
      if (!parsed.success) return buildValidationErrorResponse(parsed.error);

      try {
        const version = await deps.service.rollback({
          projectPath: resolution.projectPath,
          sessionName: resolution.sessionName,
          version: parsed.data.version,
        });
        return NextResponse.json(version, { status: 200 });
      } catch (err) {
        return mapDomainError(err);
      }
    },
  };
}

/**
 * Lazily memoize the production service so importing this module never opens the
 * DB (route shells import it at build/registration time).
 */
let memoizedService: SessionAlignmentService | null = null;
function getProductionService(): SessionAlignmentService {
  const existing = memoizedService;
  if (existing) return existing;
  const created = createSessionAlignmentServiceForProduction();
  memoizedService = created;
  return created;
}

const defaultSessionAlignmentRouteDeps: SessionAlignmentRouteDeps = {
  resolveProjectPath: (name) => defaultResolveProjectPath(name),
  get service() {
    return getProductionService();
  },
};

const defaultHandlers = createSessionAlignmentRouteHandlers(
  defaultSessionAlignmentRouteDeps,
);

export const getAlignmentState = withTracing(defaultHandlers.getAlignmentState);
export const approveCharterDraft = withTracing(
  defaultHandlers.approveCharterDraft,
);
export const rejectCharterDraft = withTracing(
  defaultHandlers.rejectCharterDraft,
);
export const resolveDecisionProposals = withTracing(
  defaultHandlers.resolveDecisionProposals,
);
export const getAlignmentDiff = withTracing(defaultHandlers.getAlignmentDiff);
export const rollbackAlignment = withTracing(defaultHandlers.rollbackAlignment);
