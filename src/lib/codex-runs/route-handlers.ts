/**
 * Agent-facing codex-run job endpoints (docs/design/cc-cli/02 §3.3).
 *
 * - POST   /api/projects/[name]/sessions/[session]/codex-runs → { runId }
 * - GET    /api/projects/[name]/sessions/[session]/codex-runs/[runId] → status
 * - POST   /api/projects/[name]/sessions/[session]/codex-runs/[runId]/cancel
 *
 * Execution stays server-side: the run reuses the existing codex task runner,
 * config resolution, and artifact-registry document registration. The endpoints
 * are token-gated; the browser UI never calls them.
 */

import { NextResponse } from "next/server";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { readConfig } from "@/lib/config/loader";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveConfiguredTimeoutMs } from "@/lib/agent-backends/timeout";
import { createSessionArtifactRegistryForProduction } from "@/lib/workflows/primitives/default-session-artifact-registry";
import { resolveInsideWorktree } from "@/lib/sessions/reference-documents-route-handlers";
import type { ApiError } from "@/lib/api/errors";
import type { GlobalConfig } from "@/lib/config/schemas";
import {
  cancelCodexRun,
  createDefaultCodexRunServiceDeps,
  getCodexRun,
  startCodexRun,
  type CancelResult,
  type RunOwner,
} from "./service";
import { codexRunRequestSchema, type CodexRunStatusResponse } from "./schemas";

const log = createLogger("codex-runs-route");

interface StartRunInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  prompt: string;
  /** The session worktree — the anchor for returned reference-document paths. */
  worktreePath: string;
  /** Where codex runs; defaults to the worktree, may be a subdirectory of it. */
  workingDirectory: string;
  timeoutMs: number;
  model?: string;
  reasoningEffort?: import("@/lib/agent-backends/schemas").CodexReasoningEffort;
}

export interface CodexRunRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ sessionName: string; worktreePath: string } | null>;
  readConfig(): Promise<GlobalConfig>;
  startRun(input: StartRunInput): { runId: string };
  getRun(runId: string, owner: RunOwner): CodexRunStatusResponse | null;
  cancelRun(runId: string, owner: RunOwner): CancelResult;
}

export function createCodexRunHandlers(deps: CodexRunRouteDeps) {
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

    const projectPath = await deps.resolveProjectPath(projectName);
    if (!projectPath) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Project not found" } satisfies ApiError,
          { status: 404 },
        ),
      };
    }

    const sessionState = await deps.getSession(projectPath, sessionName);
    if (!sessionState) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Session not found" } satisfies ApiError,
          { status: 404 },
        ),
      };
    }

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

    const config = await deps.readConfig();
    if (config.codex?.enabled !== true) {
      return NextResponse.json(
        {
          error:
            "Codex is not enabled for this instance — enable it in the CC config to run codex jobs",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON" } satisfies ApiError,
        { status: 400 },
      );
    }

    const parsed = codexRunRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid codex run payload",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      );
    }

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

    const timeoutMs =
      parsed.data.timeoutMs ??
      resolveConfiguredTimeoutMs(config.codex.timeoutMs);
    const model = parsed.data.model ?? config.codex.model;
    const reasoningEffort =
      parsed.data.reasoning_effort ?? config.codex.reasoningEffort;

    const { runId } = deps.startRun({
      projectPath: resolved.projectPath,
      projectName: resolved.projectName,
      sessionName: resolved.sessionName,
      prompt: parsed.data.prompt,
      worktreePath: resolved.worktreePath,
      workingDirectory,
      timeoutMs,
      ...(model !== undefined ? { model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });

    log.info("codex-run.created", {
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
      return NextResponse.json(
        { error: `Codex run "${runId}" not found` } satisfies ApiError,
        { status: 404 },
      );
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
      return NextResponse.json(
        { error: `Codex run "${runId}" not found` } satisfies ApiError,
        { status: 404 },
      );
    }

    log.info("codex-run.cancel_requested", {
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
  const serviceDeps = createDefaultCodexRunServiceDeps({ artifactRegistry });
  return startCodexRun(
    {
      projectName: input.projectName,
      sessionName: input.sessionName,
      prompt: input.prompt,
      worktreePath: input.worktreePath,
      workingDirectory: input.workingDirectory,
      timeoutMs: input.timeoutMs,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.reasoningEffort !== undefined
        ? { reasoningEffort: input.reasoningEffort }
        : {}),
    },
    serviceDeps,
  );
}

const defaultHandlers = createCodexRunHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  readConfig,
  startRun: defaultStartRun,
  getRun: getCodexRun,
  cancelRun: cancelCodexRun,
});

/** POST /api/projects/[name]/sessions/[session]/codex-runs */
export const createCodexRun = withTracing(defaultHandlers.POST);
/** GET /api/projects/[name]/sessions/[session]/codex-runs/[runId] */
export const getCodexRunStatus = withTracing(defaultHandlers.GET);
/** POST /api/projects/[name]/sessions/[session]/codex-runs/[runId]/cancel */
export const cancelCodexRunRoute = withTracing(defaultHandlers.CANCEL);
