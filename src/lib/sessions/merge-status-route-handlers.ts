import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import {
  jsonError,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { getSession, mutateSession } from "@/lib/state-store";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSessionLifecycleGate } from "./lifecycle-gate";
import { sessionMergeStatusRequestSchema, type SessionState } from "./schemas";

const logger = createLogger("sessions.merge-status");

interface MergeStatusDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  mutateSession(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState) => void,
  ): Promise<void>;
}

export function createMergeStatusHandler(deps: MergeStatusDeps) {
  return async (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<Response> => {
    const { name = "", session = "" } = await context.params;
    const resolved = await resolveProjectSessionOr404(deps, name, session);
    if (!resolved.ok) return resolved.response;
    const body = await request.json().catch(() => null);
    const parsed = sessionMergeStatusRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError("merged (boolean) is required", 400);
    const { projectPath } = resolved.value;
    const sessionName = resolved.value.session.sessionName;
    try {
      await getSessionLifecycleGate().runExclusive(
        projectPath,
        sessionName,
        () =>
          deps.mutateSession(
            projectPath,
            sessionName,
            "setSessionMergeStatus",
            (row) => {
              row.finished = parsed.data.merged;
            },
          ),
      );
      logger.info("session.merge_status_changed", {
        projectPath,
        sessionName,
        merged: parsed.data.merged,
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update merge status";
      logger.error("session.merge_status_failed", {
        projectPath,
        sessionName,
        error: message,
      });
      return jsonError(message, 500);
    }
  };
}

export const PATCH = withTracing(
  createMergeStatusHandler({ resolveProjectPath, getSession, mutateSession }),
);
