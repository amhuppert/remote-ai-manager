/**
 * Agent-facing agent-run job endpoints.
 *
 * - POST   /api/projects/[name]/sessions/[session]/agent-runs → { runId }
 * - GET    /api/projects/[name]/sessions/[session]/agent-runs/[runId] → status
 * - POST   /api/projects/[name]/sessions/[session]/agent-runs/[runId]/cancel
 *
 * Execution stays server-side: the run reuses the requested backend's task
 * runner, config resolution, and artifact-registry document registration. The
 * endpoints are token-gated; the browser UI never calls them.
 */

import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { readConfig } from "@/lib/config/loader";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveAgentBackendTurnDefaults } from "@/lib/agent-backends/conversation-policy";
import {
  backendFacetRefusalFor,
  GATED_BACKEND_FACET_ERROR_CODE,
} from "@/lib/agent-backends/facet-gating";
import { createSessionArtifactRegistryForProduction } from "@/lib/workflows/primitives/default-session-artifact-registry";
import { resolveInsideWorktree } from "@/lib/sessions/reference-documents-route-handlers";
import type { ApiError } from "@/lib/api/errors";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { ProjectModelSelectionValidation } from "@/lib/agent-backends/conversation";
import { admitConfiguredModelSelection } from "@/lib/agent-backends/model-selection-admission";
import {
  cancelAgentRun,
  createDefaultAgentRunServiceDeps,
  getAgentRun,
  startAgentRun,
  type CancelResult,
  type RunOwner,
} from "./service";
import { agentRunRequestSchema, type AgentRunStatusResponse } from "./schemas";

const log = createLogger("agent-runs-route");

interface StartRunInput {
  backend: AgentBackendId;
  projectPath: string;
  projectName: string;
  sessionName: string;
  prompt: string;
  /** The session worktree — the anchor for returned reference-document paths. */
  worktreePath: string;
  /** Where the agent runs; defaults to the worktree, may be a subdirectory of it. */
  workingDirectory: string;
  timeoutMs: number;
  modelSelection: BackendModelSelection;
}

export interface AgentRunRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ sessionName: string; worktreePath: string } | null>;
  readConfig(): Promise<GlobalConfig>;
  admitModelSelection(input: {
    backend: AgentBackendId;
    projectPath: string;
    modelSelection: BackendModelSelection;
    config: GlobalConfig;
  }): Promise<ProjectModelSelectionValidation>;
  startRun(input: StartRunInput): { runId: string };
  getRun(runId: string, owner: RunOwner): AgentRunStatusResponse | null;
  cancelRun(runId: string, owner: RunOwner): CancelResult;
}

export function createAgentRunHandlers(deps: AgentRunRouteDeps) {
  async function resolveSession(
    params: Promise<Record<string, string>>,
  ): Promise<
    | {
        ok: true;
        projectPath: string;
        projectName: string;
        sessionName: string;
        worktreePath: string;
      }
    | { ok: false; response: Response }
  > {
    const { name, session } = await params;
    const projectName = name ?? "";
    const sessionName = session ?? "";

    const resolved = await resolveProjectSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (!resolved.ok) return resolved;
    const { projectPath, session: sessionState } = resolved.value;

    return {
      ok: true,
      projectPath,
      projectName,
      sessionName: sessionState.sessionName,
      worktreePath: sessionState.worktreePath,
    };
  }

  async function post(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const resolved = await resolveSession(params);
    if (!resolved.ok) return resolved.response;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON" } satisfies ApiError,
        { status: 400 },
      );
    }

    const parsed = agentRunRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid agent run payload",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      );
    }

    // An agent run IS a task run, so a backend that registers no task facet
    // has to be refused here — before anything is started — rather than
    // discovered when the registry has no runner to hand back (spec R15.2).
    const facetRefusal = backendFacetRefusalFor(parsed.data.backend, "tasks");
    if (facetRefusal !== null) {
      log.warn("agent-run.facet_unsupported", {
        backend: parsed.data.backend,
        projectName: resolved.projectName,
        sessionName: resolved.sessionName,
      });
      return NextResponse.json(
        { error: facetRefusal, code: GATED_BACKEND_FACET_ERROR_CODE },
        { status: 400 },
      );
    }

    const config = await deps.readConfig();

    let workingDirectory = resolved.worktreePath;
    if (parsed.data.workingDirectory !== undefined) {
      const inside = resolveInsideWorktree(
        resolved.worktreePath,
        parsed.data.workingDirectory,
      );
      if (inside === null) {
        return NextResponse.json(
          {
            error: "workingDirectory must resolve inside the session worktree",
            issues: [
              {
                path: "workingDirectory",
                message: "path escapes the session worktree",
              },
            ],
          },
          { status: 400 },
        );
      }
      workingDirectory = inside;
    }

    const defaults = resolveAgentBackendTurnDefaults({
      backend: parsed.data.backend,
      config,
      explicit: { modelSelection: parsed.data.modelSelection },
    });
    const timeoutMs = parsed.data.timeoutMs ?? defaults.timeoutMs;
    const admission = await deps.admitModelSelection({
      backend: parsed.data.backend,
      projectPath: resolved.projectPath,
      modelSelection: defaults.modelSelection,
      config,
    });
    if (!admission.ok) {
      log.warn("model_selection.rejected", {
        backend: parsed.data.backend,
        projectName: resolved.projectName,
        sessionName: resolved.sessionName,
        modelId: admission.modelId,
        code: admission.code,
        ...(admission.parameterId !== undefined
          ? { parameterId: admission.parameterId }
          : {}),
      });
      return NextResponse.json(
        {
          error: admission.message,
          code: admission.code,
          modelId: admission.modelId,
          ...(admission.parameterId !== undefined
            ? { parameterId: admission.parameterId }
            : {}),
        },
        { status: 400 },
      );
    }
    log.debug("model_selection.resolved", {
      backend: parsed.data.backend,
      projectName: resolved.projectName,
      sessionName: resolved.sessionName,
      modelId: admission.modelSelection.modelId,
      parameterIds: Object.keys(admission.modelSelection.parameters).sort(),
      sourceLayer:
        parsed.data.modelSelection === undefined
          ? "configured_default"
          : "agent_run_request",
    });

    const { runId } = deps.startRun({
      backend: parsed.data.backend,
      projectPath: resolved.projectPath,
      projectName: resolved.projectName,
      sessionName: resolved.sessionName,
      prompt: parsed.data.prompt,
      worktreePath: resolved.worktreePath,
      workingDirectory,
      timeoutMs,
      modelSelection: admission.modelSelection,
    });

    log.info("agent-run.created", {
      backend: parsed.data.backend,
      projectName: resolved.projectName,
      sessionName: resolved.sessionName,
      runId,
    });

    return NextResponse.json({ runId });
  }

  async function get(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const resolved = await resolveSession(params);
    if (!resolved.ok) return resolved.response;

    const { runId } = await params;
    const run = deps.getRun(runId ?? "", {
      projectName: resolved.projectName,
      sessionName: resolved.sessionName,
    });
    if (!run) {
      return notFound(`Agent run "${runId}" not found`);
    }

    return NextResponse.json(run);
  }

  async function cancel(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const resolved = await resolveSession(params);
    if (!resolved.ok) return resolved.response;

    const { runId } = await params;
    const result = deps.cancelRun(runId ?? "", {
      projectName: resolved.projectName,
      sessionName: resolved.sessionName,
    });
    if (!result.found) {
      return notFound(`Agent run "${runId}" not found`);
    }

    log.info("agent-run.cancel_requested", {
      projectName: resolved.projectName,
      sessionName: resolved.sessionName,
      runId,
    });

    return NextResponse.json({ ok: true, status: result.status });
  }

  return { POST: post, GET: get, CANCEL: cancel };
}

function defaultStartRun(input: StartRunInput): { runId: string } {
  const artifactRegistry = createSessionArtifactRegistryForProduction({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
  });
  const serviceDeps = createDefaultAgentRunServiceDeps({ artifactRegistry });
  return startAgentRun(
    {
      backend: input.backend,
      projectName: input.projectName,
      sessionName: input.sessionName,
      prompt: input.prompt,
      worktreePath: input.worktreePath,
      workingDirectory: input.workingDirectory,
      timeoutMs: input.timeoutMs,
      modelSelection: input.modelSelection,
    },
    serviceDeps,
  );
}

const defaultHandlers = createAgentRunHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  readConfig,
  admitModelSelection: admitConfiguredModelSelection,
  startRun: defaultStartRun,
  getRun: getAgentRun,
  cancelRun: cancelAgentRun,
});

/** POST /api/projects/[name]/sessions/[session]/agent-runs */
export const createAgentRunRoute = withTracing(defaultHandlers.POST);
/** GET /api/projects/[name]/sessions/[session]/agent-runs/[runId] */
export const getAgentRunStatusRoute = withTracing(defaultHandlers.GET);
/** POST /api/projects/[name]/sessions/[session]/agent-runs/[runId]/cancel */
export const cancelAgentRunRoute = withTracing(defaultHandlers.CANCEL);
