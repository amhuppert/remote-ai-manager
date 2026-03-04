import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, mutateSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import {
  sendEvent,
  hasActiveWorkflow,
} from "@/lib/workflows/ralph-loop/workflow-manager";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST — Abort a running or paused workflow */
export const POST = withTracing(async (_request, { params }) => {
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

  if (
    !session.workflow ||
    (session.workflow.status !== "running" &&
      session.workflow.status !== "paused")
  ) {
    return NextResponse.json(
      {
        error: "Workflow must be running or paused to abort",
      } satisfies ApiError,
      { status: 409 },
    );
  }

  if (hasActiveWorkflow(projectPath, sessionName)) {
    // Actor exists — send ABORT event (transitions to aborted final state)
    sendEvent(projectPath, sessionName, { type: "ABORT" });
  } else {
    // No actor (paused after server restart) — mark as aborted directly
    await mutateSession(projectPath, sessionName, "workflow.abort", (sess) => {
      if (!sess.workflow) return;
      sess.workflow.status = "aborted";
      sess.workflow.haltReason = { type: "aborted" };
      sess.workflow.completedAt = new Date().toISOString();
    });
  }

  return NextResponse.json({ status: "aborted" });
});
