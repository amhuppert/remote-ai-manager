import { NextResponse } from "next/server";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import type { PerRepoConfig } from "@/lib/config/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { resolveSessionConversationRoute } from "@/lib/conversations/route-resolution";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectConversationRoute } from "@/lib/project-conversations/route-resolution";
import { discoverProjects as defaultDiscoverProjects } from "@/lib/projects/discovery";
import { readRepoConfig as defaultReadRepoConfig } from "@/lib/projects/repo-config";
import { resolveProjectPath } from "@/lib/projects/resolver";
import type { DiscoveredProject } from "@/lib/projects/schemas";
import { getProjectConversation, getSession } from "@/lib/state-store";
import { notFound, type RouteResolution } from "@/lib/shared/route-resolution";
import {
  isTerminalValidationRunStatus,
  type ValidationCommandsResponse,
  type ValidationCommandSummary,
  type ValidationRunStatus,
} from "@/lib/validation/schemas";
import {
  VALIDATION_LEASE_HEADER,
  validationPollQuerySchema,
  validationSubmitBodySchema,
  type ValidationBudgetResponse,
  type ValidationCancelResponse,
  type ValidationListResponse,
  type ValidationPollResponse,
  type ValidationSubmitResponse,
} from "./api-schemas";
import { maxDeclaredCost } from "./cost-resolution";
import { getValidationService } from "./singleton";
import type {
  ValidationCallerRef,
  ValidationListResult,
  ValidationService,
  ValidationSubmitInvalidReason,
} from "./service";

export { VALIDATION_LEASE_HEADER } from "./api-schemas";

type RouteContext = { params: Promise<Record<string, string>> };

interface ValidationRouteIdentity {
  caller: ValidationCallerRef;
}

interface ValidationHandlerDeps {
  auth: AgentAuth;
  service: ValidationService;
}

export interface SessionValidationRouteDeps extends ValidationHandlerDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ conversations: ConversationState[] } | null>;
}

export interface ProjectValidationRouteDeps extends ValidationHandlerDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

interface ValidationErrorBody {
  error: string;
  code: string;
  issues: Array<{ path: string; message: string }>;
}

function errorResponse(
  error: string,
  status: number,
  code: string,
  issues: ValidationErrorBody["issues"] = [],
): Response {
  return NextResponse.json(
    { error, code, issues } satisfies ValidationErrorBody,
    { status },
  );
}

function invalidServiceResult(
  result:
    | Extract<ValidationListResult, { kind: "invalid" }>
    | {
        kind: "invalid";
        reason: ValidationSubmitInvalidReason;
        message: string;
      },
): Response {
  const statuses: Record<ValidationSubmitInvalidReason, number> = {
    identity_unresolved: 403,
    nested_invocation: 400,
    duplicate_active: 409,
    path_args_forbidden: 400,
    path_args_rejected: 400,
    path_args_require_changed: 400,
    service_unavailable: 503,
  };
  return errorResponse(
    result.message,
    statuses[result.reason],
    `validation_${result.reason}`,
  );
}

function claimedWorkflow(body: {
  workflowExecutionId?: string;
  workflowContextId?: string;
}): ValidationCallerRef["claimedWorkflow"] {
  if (
    body.workflowExecutionId === undefined ||
    body.workflowContextId === undefined
  ) {
    return undefined;
  }
  return {
    executionId: body.workflowExecutionId,
    contextId: body.workflowContextId,
  };
}

type PolledRun = ReturnType<ValidationService["poll"]>;
type ResolvedPolledRun = PolledRun & { status: ValidationRunStatus };

function isResolvedRun(polled: PolledRun): polled is ResolvedPolledRun {
  return polled.status !== null;
}

function runNotFound(runId: string): Response {
  return notFound(
    `Validation run "${runId}" was not found`,
    "validation_run_not_found",
  );
}

function pollResponse(runId: string, polled: ResolvedPolledRun): Response {
  const response: ValidationPollResponse = {
    runId,
    status: polled.status,
    position: polled.position,
    result: polled.result,
    requestedScope: polled.requestedScope,
    effectiveScope: polled.effectiveScope,
  };
  return NextResponse.json(response);
}

function createValidationHandlers(
  deps: ValidationHandlerDeps,
  resolveIdentity: (
    context: RouteContext,
  ) => Promise<RouteResolution<ValidationRouteIdentity>>,
) {
  async function authorizeAndResolve(
    request: Request,
    context: RouteContext,
  ): Promise<RouteResolution<ValidationRouteIdentity>> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return { ok: false, response: denied };
    return resolveIdentity(context);
  }

  async function post(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await authorizeAndResolve(request, context);
    if (!resolved.ok) return resolved.response;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return errorResponse(
        "Request body must be JSON",
        400,
        "validation_invalid_request",
        [{ path: "", message: "Expected a JSON object" }],
      );
    }
    const parsed = validationSubmitBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(
        "Invalid validation request",
        400,
        "validation_invalid_request",
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }

    const submission = await deps.service.submit({
      source: "agent_cli",
      commandName: parsed.data.commandName,
      scope: parsed.data.scope,
      ...(parsed.data.scopePaths === undefined
        ? {}
        : { scopePaths: parsed.data.scopePaths }),
      ...(parsed.data.queueIfBusy === undefined
        ? {}
        : { queueIfBusy: parsed.data.queueIfBusy }),
      nestedValidationRunId: parsed.data.nestedValidationRunId ?? null,
      caller: {
        ...resolved.value.caller,
        ...(claimedWorkflow(parsed.data) === undefined
          ? {}
          : { claimedWorkflow: claimedWorkflow(parsed.data) }),
      },
    });
    if (submission.kind === "invalid") {
      return invalidServiceResult(submission);
    }
    return NextResponse.json(submission satisfies ValidationSubmitResponse, {
      status: submission.kind === "accepted" ? 202 : 200,
    });
  }

  async function get(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await authorizeAndResolve(request, context);
    if (!resolved.ok) return resolved.response;
    const listed = await deps.service.list(resolved.value.caller);
    if (listed.kind === "invalid") return invalidServiceResult(listed);
    const response: ValidationListResponse = {
      commands: listed.commands,
      capacity: listed.capacity,
      runs: listed.runs,
    };
    return NextResponse.json(response);
  }

  async function poll(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await authorizeAndResolve(request, context);
    if (!resolved.ok) return resolved.response;
    const { runId = "" } = await context.params;
    const leaseToken =
      request.headers.get(VALIDATION_LEASE_HEADER) ?? undefined;
    const query = validationPollQuerySchema.safeParse({
      waitMs: new URL(request.url).searchParams.get("waitMs"),
    });
    if (!query.success) {
      return errorResponse(
        "Invalid validation status request",
        400,
        "validation_invalid_request",
        query.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }

    // Reading state first is what makes holding safe: it renews the lease at
    // request entry (the hold is now the gap between renewals) and answers an
    // unknown run with its 404 — waiting on a run that does not exist would
    // never be woken by anything.
    const entry = deps.service.poll(runId, leaseToken);
    if (!isResolvedRun(entry)) return runNotFound(runId);
    // Terminality is read from the run's status, never from the presence of a
    // result: results live in memory only, so a run that finished before the
    // last server restart has none and a result-keyed hold would wait on a
    // transition that already happened.
    if (
      query.data.waitMs === 0 ||
      isTerminalValidationRunStatus(entry.status)
    ) {
      return pollResponse(runId, entry);
    }

    // Only this run's own transitions wake the hold. Queue position also
    // moves when unrelated runs ahead retire, so a queued run's reported
    // position may lag by up to the wait budget — accepted, because waking
    // every waiter on every other run's transition rebuilds the polling
    // storm this hold exists to remove.
    const wait = new AbortController();
    const abandon = () => wait.abort();
    const budget = setTimeout(abandon, query.data.waitMs);
    request.signal.addEventListener("abort", abandon, { once: true });
    if (request.signal.aborted) abandon();
    try {
      await deps.service.waitForStatusChange(runId, wait.signal);
    } finally {
      clearTimeout(budget);
      request.signal.removeEventListener("abort", abandon);
    }
    const settled = deps.service.poll(runId, leaseToken);
    return isResolvedRun(settled)
      ? pollResponse(runId, settled)
      : runNotFound(runId);
  }

  async function cancel(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await authorizeAndResolve(request, context);
    if (!resolved.ok) return resolved.response;
    const { runId = "" } = await context.params;
    const leaseToken = request.headers.get(VALIDATION_LEASE_HEADER);
    if (!leaseToken) {
      return errorResponse(
        `Missing ${VALIDATION_LEASE_HEADER} header`,
        400,
        "validation_lease_required",
        [
          {
            path: VALIDATION_LEASE_HEADER,
            message: "The submitter lease token is required to cancel a run",
          },
        ],
      );
    }
    const result = await deps.service.cancel(runId, leaseToken);
    switch (result.authorization) {
      case "authorized":
        return NextResponse.json({
          cancelled: true,
        } satisfies ValidationCancelResponse);
      case "not_found":
        return notFound(
          `Validation run "${runId}" was not found`,
          "validation_run_not_found",
        );
      case "already_terminal":
        return errorResponse(
          `Validation run "${runId}" is already terminal`,
          409,
          "validation_run_not_active",
        );
      case "system_owned":
        return errorResponse(
          "System-owned validation runs cannot be cancelled through the agent API",
          403,
          "validation_system_owned",
        );
      case "not_owner":
        return errorResponse(
          "The validation run lease does not belong to this caller",
          403,
          "validation_not_owner",
        );
    }
  }

  return { GET: get, POST: post, POLL: poll, CANCEL: cancel };
}

export function createSessionValidationHandlers(
  deps: SessionValidationRouteDeps,
) {
  return createValidationHandlers(deps, async (context) => {
    const resolved = await resolveSessionConversationRoute(deps, context);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      value: {
        caller: {
          projectPath: resolved.value.projectPath,
          sessionName: resolved.value.sessionName,
          conversationId: resolved.value.conversationId,
        },
      },
    };
  });
}

export function createProjectValidationHandlers(
  deps: ProjectValidationRouteDeps,
) {
  return createValidationHandlers(deps, async (context) => {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      value: {
        caller: {
          projectPath: resolved.value.projectPath,
          sessionName: null,
          conversationId: resolved.value.conversationId,
        },
      },
    };
  });
}

const productionAuth = createAgentAuth();

interface ValidationProductionRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ conversations: ConversationState[] } | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

const defaultProductionRouteDeps: ValidationProductionRouteDeps = {
  auth: productionAuth,
  resolveProjectPath,
  getSession,
  getProjectConversation,
};

let productionRouteDeps = defaultProductionRouteDeps;

export function _setValidationProductionRouteDepsForTesting(
  overrides: Partial<ValidationProductionRouteDeps>,
): void {
  productionRouteDeps = { ...defaultProductionRouteDeps, ...overrides };
}

export function _resetValidationProductionRouteDepsForTesting(): void {
  productionRouteDeps = defaultProductionRouteDeps;
}

const productionAuthProxy: AgentAuth = {
  requireToken: (request) => productionRouteDeps.auth.requireToken(request),
  validateOptionalToken: (request) =>
    productionRouteDeps.auth.validateOptionalToken(request),
};

const serviceProxy: ValidationService = {
  whenReady: () => getValidationService().whenReady(),
  isAvailable: () => getValidationService().isAvailable(),
  submit: (request) => getValidationService().submit(request),
  list: (caller) => getValidationService().list(caller),
  budget: () => getValidationService().budget(),
  submitSystem: (request) => getValidationService().submitSystem(request),
  waitForCompletion: (runId) => getValidationService().waitForCompletion(runId),
  waitForStatusChange: (runId, signal) =>
    getValidationService().waitForStatusChange(runId, signal),
  poll: (runId, leaseToken) => getValidationService().poll(runId, leaseToken),
  cancel: (runId, leaseToken) =>
    getValidationService().cancel(runId, leaseToken),
  cancelSystemOwned: (runId) => getValidationService().cancelSystemOwned(runId),
  sweepExpiredLeases: () => getValidationService().sweepExpiredLeases(),
  shutdown: () => getValidationService().shutdown(),
};

const sessionHandlers = createSessionValidationHandlers({
  auth: productionAuthProxy,
  service: serviceProxy,
  resolveProjectPath: (name) => productionRouteDeps.resolveProjectPath(name),
  getSession: (projectPath, sessionName) =>
    productionRouteDeps.getSession(projectPath, sessionName),
});

const projectHandlers = createProjectValidationHandlers({
  auth: productionAuthProxy,
  service: serviceProxy,
  resolveProjectPath: (name) => productionRouteDeps.resolveProjectPath(name),
  getProjectConversation: (projectPath, conversationId) =>
    productionRouteDeps.getProjectConversation(projectPath, conversationId),
});

export const sessionValidationGET = withTracing(sessionHandlers.GET);
export const sessionValidationPOST = withTracing(sessionHandlers.POST);
export const sessionValidationPollGET = withTracing(sessionHandlers.POLL, {
  longPoll: true,
});
export const sessionValidationCancelPOST = withTracing(sessionHandlers.CANCEL);

export const projectValidationGET = withTracing(projectHandlers.GET);
export const projectValidationPOST = withTracing(projectHandlers.POST);
export const projectValidationPollGET = withTracing(projectHandlers.POLL, {
  longPoll: true,
});
export const projectValidationCancelPOST = withTracing(projectHandlers.CANCEL);

const budgetHandlers = createValidationBudgetRouteHandlers({
  service: serviceProxy,
});

export const validationBudgetGET = withTracing(budgetHandlers.GET);

/**
 * Global budget read for the topbar indicator.
 *
 * Unauthenticated like `/api/validation-commands`, and for the same reason:
 * it is a UI read whose payload carries command NAMES and project names but
 * never a command's underlying executable. It takes no caller identity
 * because the budget it reports is global — the run blocking you may belong
 * to any project.
 */
export interface ValidationBudgetRouteDeps {
  service: Pick<ValidationService, "budget">;
}

export function createValidationBudgetRouteHandlers(
  deps: ValidationBudgetRouteDeps,
) {
  async function GET(): Promise<Response> {
    try {
      const budget = await deps.service.budget();
      return NextResponse.json(budget satisfies ValidationBudgetResponse);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read validation budget";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return { GET };
}

/**
 * Validation-registry route handler logic — extracted for dependency
 * injection, mirroring `src/lib/projects/route-handlers.ts`.
 *
 * GET /api/validation-commands aggregates every discovered project's
 * `CommandCenter.json` validation registry into a display summary for the
 * workflow UI's command multi-selects. The response is advisory only:
 * admission and unknown-name rejection stay at the project-bound server
 * boundaries (create/replace/start/live-edit and the ValidationService).
 */
const validationCommandsLogger = createLogger("validation-commands");

export interface ValidationCommandsRouteDeps {
  discoverProjects(): Promise<DiscoveredProject[]>;
  readRepoConfig(repoRoot: string): Promise<PerRepoConfig | null>;
}

const defaultDeps: ValidationCommandsRouteDeps = {
  discoverProjects: defaultDiscoverProjects,
  readRepoConfig: defaultReadRepoConfig,
};

export function createValidationCommandsRouteHandlers(
  deps: ValidationCommandsRouteDeps = defaultDeps,
) {
  async function GET(): Promise<Response> {
    try {
      const projects = await deps.discoverProjects();
      const entries: ValidationCommandsResponse["projects"] = [];
      for (const project of projects) {
        let config: PerRepoConfig | null;
        try {
          config = await deps.readRepoConfig(project.path);
        } catch (err) {
          // A malformed CommandCenter.json must not take down the listing;
          // omitting the project marks its registry unavailable rather than
          // empty, and enforcement will surface the same read failure.
          validationCommandsLogger.warn(
            "validation_commands.repo_config_unreadable",
            {
              projectName: project.name,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          continue;
        }
        const commands: ValidationCommandSummary[] = Object.entries(
          config?.validation?.commands ?? {},
        )
          .map(([name, command]) => ({
            name,
            cost: maxDeclaredCost(command.cost),
            pathArgs: command.pathArgs,
            changedScope:
              command.command.changed === undefined
                ? ("full_fallback" as const)
                : ("native" as const),
            ...(command.description !== undefined
              ? { description: command.description }
              : {}),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        entries.push({ projectName: project.name, commands });
      }
      const payload: ValidationCommandsResponse = { projects: entries };
      return NextResponse.json(payload);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to list validation commands";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return { GET };
}

const defaultHandlers = createValidationCommandsRouteHandlers();

export const listValidationCommands = withTracing(defaultHandlers.GET);
