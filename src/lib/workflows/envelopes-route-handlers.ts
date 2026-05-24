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

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

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
