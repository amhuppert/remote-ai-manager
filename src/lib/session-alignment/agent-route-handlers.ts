/**
 * Agent-facing alignment submission endpoints (docs/design/cc-cli/02 §3.2).
 *
 * The browser UI surface lives in `route-handlers.ts` (read / approve / reject /
 * resolve, no token). These two endpoints are the authenticated write path used
 * by the agent-facing `cctl charter write` and `cctl decisions propose`
 * commands:
 *
 *  - POST /alignment/charter   — charter content + conversationId
 *  - POST /alignment/decisions — decision batch + conversationId
 *
 * They call the SAME service methods (`beginDraft` / `fillDraft` /
 * `proposeDecisions`) through the shared `authoring.ts` wrapper. Charter writes
 * return the state-driven `draft_ready` or `activated` result; decision
 * proposals persist pending review. Token-gated (doc 01 §4).
 */
import { NextResponse } from "next/server";
import {
  jsonError,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { z } from "zod";

import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { getErrorMessage } from "@/lib/shared/errors";
import { getConversationRuntime } from "@/lib/workflows/conversation/runtime-state";

import {
  ALIGNMENT_AUTONOMOUS_DENIAL_MESSAGE,
  fillOpenDraft,
  resolveAttendedRuntime,
  type AlignmentAuthoringDeps,
} from "./authoring";
import {
  submitCharterRequestSchema,
  submitDecisionsRequestSchema,
} from "./schemas";
import { createSessionAlignmentServiceForProduction } from "./service-factory";
import {
  AlignmentDraftContentError,
  AlignmentNotSupportedError,
} from "./service";

const logger = createLogger("session-alignment.agent-route");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

/** Injected deps (method syntax → bivariant params). Extends the shared
 * authoring seams with the token gate + project/session resolution. */
export interface SessionAlignmentAgentRouteDeps extends AlignmentAuthoringDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ sessionName: string } | null>;
}

export interface SessionAlignmentAgentRouteHandlers {
  writeCharter(request: Request, context: RouteContext): Promise<Response>;
  proposeDecisions(request: Request, context: RouteContext): Promise<Response>;
}

function validationErrorResponse(error: z.ZodError): Response {
  return NextResponse.json(
    {
      error: "Invalid request body",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
    { status: 400 },
  );
}

/**
 * Render the attended-runtime refusal: an autonomous turn is a 403 carrying the
 * "proceed with best judgment" text (doc 03 §2.2 precedent); an absent runtime
 * is a 409 — there is no live turn to author against.
 */
function attendedRefusalResponse(
  reason: "no_runtime" | "autonomous",
): Response {
  if (reason === "autonomous") {
    return jsonError(ALIGNMENT_AUTONOMOUS_DENIAL_MESSAGE, 403);
  }
  return jsonError(
    "no active conversation runtime; cannot author alignment",
    409,
  );
}

/** Optimistic/unknown sessions surface as 409; anything else is a 500. */
function mapDomainError(err: unknown): Response {
  if (err instanceof AlignmentDraftContentError) {
    return jsonError(err.message, 400);
  }
  if (err instanceof AlignmentNotSupportedError) {
    return jsonError(err.message, 409);
  }
  logger.error("session-alignment.agent-route.unexpected_error", {
    error: getErrorMessage(err),
  });
  return jsonError(getErrorMessage(err), 500);
}

export function createSessionAlignmentAgentRouteHandlers(
  deps: SessionAlignmentAgentRouteDeps,
): SessionAlignmentAgentRouteHandlers {
  /**
   * Token gate → project (404) → session (404), mirroring the shared agent
   * endpoint contract. Returns the resolved identity or the response to send.
   */
  async function resolveScope(
    request: Request,
    context: RouteContext,
  ): Promise<
    { error: Response } | { projectPath: string; sessionName: string }
  > {
    const denied = await deps.auth.requireToken(request);
    if (denied) return { error: denied };

    const p = await context.params;
    const name = p["name"] ?? "";
    const sessionName = decodeURIComponent(p["session"] ?? "");

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return { error: resolved.response };
    return { projectPath: resolved.value.projectPath, sessionName };
  }

  async function readJsonBody(
    request: Request,
  ): Promise<{ error: Response } | { body: unknown }> {
    try {
      return { body: await request.json() };
    } catch {
      return { error: jsonError("Request body must be JSON", 400) };
    }
  }

  return {
    async writeCharter(request, context) {
      const scope = await resolveScope(request, context);
      if ("error" in scope) return scope.error;

      const bodyResult = await readJsonBody(request);
      if ("error" in bodyResult) return bodyResult.error;
      const parsed = submitCharterRequestSchema.safeParse(bodyResult.body);
      if (!parsed.success) return validationErrorResponse(parsed.error);

      const authoringContext = {
        projectPath: scope.projectPath,
        sessionName: scope.sessionName,
        conversationId: parsed.data.conversationId,
      };
      const attended = resolveAttendedRuntime(authoringContext, deps);
      if (!attended.ok) return attendedRefusalResponse(attended.reason);

      try {
        const result = await fillOpenDraft(
          deps,
          authoringContext,
          parsed.data.content,
        );
        logger.info("agent-route.write_charter", {
          conversationId: parsed.data.conversationId,
          status: result.status,
          version: result.version,
        });
        return NextResponse.json(
          { ok: true, status: result.status, version: result.version },
          { status: 200 },
        );
      } catch (err) {
        return mapDomainError(err);
      }
    },

    async proposeDecisions(request, context) {
      const scope = await resolveScope(request, context);
      if ("error" in scope) return scope.error;

      const bodyResult = await readJsonBody(request);
      if ("error" in bodyResult) return bodyResult.error;
      const parsed = submitDecisionsRequestSchema.safeParse(bodyResult.body);
      if (!parsed.success) return validationErrorResponse(parsed.error);

      const authoringContext = {
        projectPath: scope.projectPath,
        sessionName: scope.sessionName,
        conversationId: parsed.data.conversationId,
      };
      const attended = resolveAttendedRuntime(authoringContext, deps);
      if (!attended.ok) return attendedRefusalResponse(attended.reason);

      try {
        const originMessageId = attended.runtime.currentTurnMessageId ?? null;
        const { batchId } = await deps.proposeDecisions({
          projectPath: authoringContext.projectPath,
          sessionName: authoringContext.sessionName,
          conversationId: authoringContext.conversationId,
          decisions: parsed.data.decisions,
          originMessageId,
        });
        logger.info("agent-route.propose_decisions", {
          conversationId: parsed.data.conversationId,
          originMessageId,
          batchId,
          count: parsed.data.decisions.length,
        });
        return NextResponse.json(
          { ok: true, batchId, count: parsed.data.decisions.length },
          { status: 200 },
        );
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
let memoizedService: ReturnType<
  typeof createSessionAlignmentServiceForProduction
> | null = null;
function getProductionService() {
  memoizedService ??= createSessionAlignmentServiceForProduction();
  return memoizedService;
}

const defaultDeps: SessionAlignmentAgentRouteDeps = {
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  getRuntime: getConversationRuntime,
  beginDraft: (input) => getProductionService().beginDraft(input),
  fillDraft: (input) => getProductionService().fillDraft(input),
  proposeDecisions: (input) => getProductionService().proposeDecisions(input),
};

const defaultHandlers = createSessionAlignmentAgentRouteHandlers(defaultDeps);

/** POST /api/projects/[name]/sessions/[session]/alignment/charter */
export const writeCharter = withTracing(defaultHandlers.writeCharter);
/** POST /api/projects/[name]/sessions/[session]/alignment/decisions */
export const proposeDecisions = withTracing(defaultHandlers.proposeDecisions);
