import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, mutateSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import { createInitialCircuitBreakerState } from "@/lib/ralph-loop/circuit-breaker";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const startWorkflowSchema = z.object({
  objective: z.string().min(1).optional(),
});

/** POST — Start a new workflow (creates in planning status) */
export const POST = withTracing(async (request, { params }) => {
  const resolvedParams = await params;
  const name = resolvedParams["name"] ?? "";
  const sessionSlug = resolvedParams["session"] ?? "";
  const sessionName = decodeURIComponent(sessionSlug);

  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const session = await getSession(projectPath, sessionName);
  if (!session) {
    return NextResponse.json(
      { error: "Session not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  if (session.workflow) {
    return NextResponse.json(
      { error: "Session already has a workflow" } satisfies ApiError,
      { status: 409 },
    );
  }

  let body: z.infer<typeof startWorkflowSchema>;
  try {
    body = startWorkflowSchema.parse(await request.json());
  } catch {
    body = {};
  }

  const workflow = await mutateSession(
    projectPath,
    sessionName,
    "workflow.create",
    (sess) => {
      const now = new Date().toISOString();
      sess.workflow = {
        status: "planning",
        objective: body.objective ?? "",
        fixPlan: [],
        config: {
          maxIterations: 20,
          iterationTimeoutMs: 3_600_000,
          circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
        },
        circuitBreaker: createInitialCircuitBreakerState(),
        iterations: [],
        haltReason: null,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        totalCostUsd: 0,
        totalDurationMs: 0,
      };
      return sess.workflow;
    },
  );

  return NextResponse.json({ workflow }, { status: 201 });
});

/** GET — Get current workflow state */
export const GET = withTracing(async (_request, { params }) => {
  const resolvedParams = await params;
  const name = resolvedParams["name"] ?? "";
  const sessionSlug = resolvedParams["session"] ?? "";
  const sessionName = decodeURIComponent(sessionSlug);

  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const session = await getSession(projectPath, sessionName);
  if (!session) {
    return NextResponse.json(
      { error: "Session not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  return NextResponse.json({ workflow: session.workflow ?? null });
});
