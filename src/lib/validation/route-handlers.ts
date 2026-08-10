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
import type {
  ValidationCommandsResponse,
  ValidationCommandSummary,
} from "@/lib/validation/schemas";
import {
  VALIDATION_LEASE_HEADER,
  validationSubmitBodySchema,
  type ValidationCancelResponse,
  type ValidationListResponse,
  type ValidationPollResponse,
  type ValidationSubmitResponse,
} from "./api-schemas";
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
      ...(parsed.data.wait === undefined ? {} : { wait: parsed.data.wait }),
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
    const polled = deps.service.poll(runId, leaseToken);
    if (polled.status === null) {
      return notFound(
        `Validation run "${runId}" was not found`,
        "validation_run_not_found",
      );
    }
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
  submitSystem: (request) => getValidationService().submitSystem(request),
  waitForCompletion: (runId) => getValidationService().waitForCompletion(runId),
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
export const sessionValidationPollGET = withTracing(sessionHandlers.POLL);
export const sessionValidationCancelPOST = withTracing(sessionHandlers.CANCEL);

export const projectValidationGET = withTracing(projectHandlers.GET);
export const projectValidationPOST = withTracing(projectHandlers.POST);
export const projectValidationPollGET = withTracing(projectHandlers.POLL);
export const projectValidationCancelPOST = withTracing(projectHandlers.CANCEL);

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
            cost: command.cost,
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
