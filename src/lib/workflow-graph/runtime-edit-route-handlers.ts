import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { withTracing } from "@/lib/logging";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { readConfig } from "@/lib/config/loader";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
} from "@/lib/state-store";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import { workflowLiveEditRequestSchema } from "@/lib/workflows/edit-schemas";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
  type PublishCharterUpdatedInput,
  type PublishLiveEditAppliedInput,
} from "./execution-events";
import { CHARTER_DOCUMENT_PATH } from "./charter/render";
import {
  createGraphWorkflowExecutionRepository,
  type MutateActiveResult,
} from "./execution-repository";
import { formatDefinitionEditIssue } from "./definition-edits";
import {
  applyLiveEditsToActiveExecution,
  type LiveEditFailure,
} from "./live-edit-apply";
import {
  coerceGlobalDefaults,
  resolveCollaborationConfigWithProvenance,
  resolveContext,
} from "./resolve-config";
import type { LiveEditDeps, ResolvedContextConfig } from "./runtime-edits";
import { createRegisteredGraphExecutionContract } from "./execution-contract-port";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const eventPublisher = createGraphWorkflowExecutionEventPublisher();
const executionRepository = createGraphWorkflowExecutionRepository({
  getSession: defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  eventPublisher,
});

/**
 * Resolve the concrete config a new `add-context` op seeds from when no
 * `configFromContextId` is given and the deferred script-validator prerequisite,
 * both computed once per request (the pure core's deps are sync). Resolves the
 * global defaults through the same cascade a launch uses, against a synthetic
 * no-override context, so a live-added context matches what a seeded one carries.
 */
async function defaultBuildLiveEditDeps(
  projectPath: string,
): Promise<LiveEditDeps> {
  const repoConfig = await readRepoConfig(projectPath);
  const hasPreMergeCommand = Boolean(repoConfig?.preMergeCommand);

  const global = await readConfig();
  const defaults = coerceGlobalDefaults(global.workflowDefaults);
  const syntheticContext: GraphWorkflowExecutionContextDefinition = {
    id: "__live_edit_global_defaults__",
    title: "Live edit defaults",
    acceptanceCriteria: "Live edit defaults",
  };
  const resolved = resolveContext(defaults, {}, syntheticContext);
  const collaboration = resolveCollaborationConfigWithProvenance(
    defaults,
    {},
    syntheticContext,
  );
  const resolvedGlobalDefaults: ResolvedContextConfig = {
    implementer: resolved.implementer,
    contextValidator: resolved.contextValidator,
    scriptValidator: resolved.scriptValidator,
    humanApprovalGate: resolved.humanApprovalGate,
    askUserQuestions: resolved.askUserQuestions,
    mutability: resolved.mutability,
    circuitBreaker: resolved.circuitBreaker,
    iterationPolicy: resolved.iterationPolicy,
    planRepair: resolved.planRepair,
    collaboration,
  };

  return {
    createTaskId: () => `task-${randomUUID()}`,
    resolvedGlobalDefaults: () => resolvedGlobalDefaults,
    hasPreMergeCommand: () => hasPreMergeCommand,
    now: () => new Date().toISOString(),
    executionContract: createRegisteredGraphExecutionContract(),
  };
}

export interface GraphWorkflowRuntimeEditRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
  buildLiveEditDeps(projectPath: string): Promise<LiveEditDeps>;
  publishLiveEditApplied(
    input: PublishLiveEditAppliedInput,
  ): GraphWorkflowEventDelivery;
  publishCharterUpdated(
    input: PublishCharterUpdatedInput,
  ): GraphWorkflowEventDelivery;
  /**
   * Rewrite the session worktree's charter.md pointer copy after an accepted
   * amendment. Lane worktrees re-materialize per iteration; the session
   * worktree's copy is only written at seed time, so it goes stale without
   * this. Best-effort: a failure is logged, never a request failure — the
   * inline prompt digest is authoritative, the file is a pointer copy.
   */
  writeCharterDocument(input: {
    worktreePath: string;
    markdown: string;
  }): Promise<void>;
}

async function defaultWriteCharterDocument(input: {
  worktreePath: string;
  markdown: string;
}): Promise<void> {
  const absolutePath = path.join(input.worktreePath, CHARTER_DOCUMENT_PATH);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, input.markdown);
}

const defaultDeps: GraphWorkflowRuntimeEditRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getActiveExecution: getActiveGraphWorkflowExecution,
  mutateActive: executionRepository.mutateActive,
  buildLiveEditDeps: defaultBuildLiveEditDeps,
  publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
  publishCharterUpdated: eventPublisher.publishCharterUpdated,
  writeCharterDocument: defaultWriteCharterDocument,
};

/** Map a service-layer rejection onto the doc-06 HTTP error contract. */
function respondLiveEditFailure(failure: LiveEditFailure): Response {
  const body: Record<string, unknown> = {
    error: failure.error,
    code: failure.code,
  };
  if (failure.currentLiveRevision !== undefined) {
    body["currentLiveRevision"] = failure.currentLiveRevision;
  }
  if (failure.issues) {
    body["issues"] = failure.issues.map(formatDefinitionEditIssue);
  }
  if (failure.instruction) {
    body["instruction"] = failure.instruction;
  }
  return NextResponse.json(body, { status: failure.status });
}

async function resolveSession(
  context: RouteContext,
  deps: GraphWorkflowRuntimeEditRouteDeps,
): Promise<{ error: Response } | { projectPath: string; sessionName: string }> {
  const params = await context.params;
  const projectName = params["name"] ?? "";
  const sessionName = decodeURIComponent(params["session"] ?? "");
  const resolved = await resolveProjectSessionOr404(
    deps,
    projectName,
    sessionName,
  );
  if (!resolved.ok) return { error: resolved.response };
  return { projectPath: resolved.value.projectPath, sessionName };
}

export function createGraphWorkflowRuntimeEditRouteHandlers(
  deps: GraphWorkflowRuntimeEditRouteDeps = defaultDeps,
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: "Invalid live edit request: body must be JSON",
          issues: [{ path: "body", message: "invalid JSON" }],
        },
        { status: 400 },
      );
    }

    const parsed = workflowLiveEditRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid live edit request",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "operations",
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }
    const editRequest = parsed.data;

    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }
    const { projectPath, sessionName } = resolved;

    const outcome = await applyLiveEditsToActiveExecution(
      { projectPath, sessionName, request: editRequest },
      deps,
    );

    if (!outcome.ok) {
      if (outcome.kind === "no_active_execution") {
        return notFound(
          "Session does not have an active graph workflow execution",
        );
      }
      return respondLiveEditFailure(outcome.failure);
    }

    return NextResponse.json({
      applied: outcome.applied,
      liveRevision: outcome.liveRevision,
      affectedContextIds: outcome.affectedContextIds,
      dryRun: outcome.dryRun,
    });
  }

  return { POST };
}

const defaultGraphWorkflowRuntimeEditHandlers =
  createGraphWorkflowRuntimeEditRouteHandlers();

export const applyGraphWorkflowRuntimeEdits = withTracing(
  defaultGraphWorkflowRuntimeEditHandlers.POST,
);
