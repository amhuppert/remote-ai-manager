/**
 * Workflow envelopes route handler logic — extracted for dependency injection.
 *
 * The route file delegates to these handlers, passing production deps. Tests
 * compose handlers with a fake project resolver and a real on-disk repository
 * via `createWorkflowEnvelopesRouteHandlers(deps)`.
 *
 * Active envelopes (`running`, `paused`) are returned by default. Terminal
 * envelopes (`completed`, `failed`) stay discoverable for history and are
 * included only when the request supplies `?includeTerminal=true`, mirroring
 * the integration plan's "discoverable for history but excluded from active
 * work" requirement.
 */
import { NextResponse } from "next/server";
import {
  refuseProjectSentinelSessionParam,
  resolveProjectOr404,
} from "@/lib/shared/route-resolution";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { createSessionWorkflowEnvelopeRepositoryForProduction } from "@/lib/workflows/primitives/default-session-workflow-envelope-store";
import type { ApiError } from "@/lib/api/errors";
import type { WorkflowEnvelopeRepository } from "@/lib/workflows/primitives/workflow-envelope-repository";

export interface WorkflowEnvelopesRouteContext {
  params: Promise<Record<string, string>>;
}

export interface WorkflowEnvelopesRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  createRepository: (input: {
    projectPath: string;
    sessionName: string;
  }) => Promise<WorkflowEnvelopeRepository> | WorkflowEnvelopeRepository;
}

const defaultDeps: WorkflowEnvelopesRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  createRepository: ({ projectPath, sessionName }) =>
    createSessionWorkflowEnvelopeRepositoryForProduction({
      projectPath,
      sessionName,
    }),
};

export function createWorkflowEnvelopesRouteHandlers(
  deps: WorkflowEnvelopesRouteDeps = defaultDeps,
) {
  async function GET(
    request: Request,
    context: WorkflowEnvelopesRouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const name = params["name"];
    const session = decodeURIComponent(params["session"] ?? "");
    if (!name || !session) {
      return NextResponse.json(
        { error: "Missing project name or session name" } satisfies ApiError,
        { status: 400 },
      );
    }

    // This route resolves the project itself rather than going through the
    // session resolution seam, so the seam's refusal never runs for it. Without
    // this guard the sentinel reaches the envelope repository as a session key
    // and the request succeeds for a session that does not exist (R1.2).
    const refusal = refuseProjectSentinelSessionParam(session, name);
    if (refusal) return refusal;

    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const url = new URL(request.url);
    const includeTerminal = url.searchParams.get("includeTerminal") === "true";

    try {
      const repo = await deps.createRepository({
        projectPath,
        sessionName: session,
      });
      const envelopes = includeTerminal
        ? await repo.listAll()
        : await repo.listActive();
      return NextResponse.json({ envelopes });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to read workflow envelopes";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }

  return { GET };
}

const defaultWorkflowEnvelopesHandlers = createWorkflowEnvelopesRouteHandlers();

export const listWorkflowEnvelopes = withTracing(
  defaultWorkflowEnvelopesHandlers.GET,
);
