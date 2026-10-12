import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import {
  jsonError,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { getSession, mutateSession } from "@/lib/state-store";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  assertNoCurrentRun,
  CurrentRunError,
  type CurrentRun,
} from "@/lib/runs/session-guard";
import {
  closeCoreBackgroundWork,
  currentRuns,
  sessionBackgroundWork,
} from "@/lib/supervision/handles";
import {
  backgroundWorkRefusal,
  type BackgroundWorkRefusal,
  type SessionBackgroundWork,
} from "@/lib/workflows/merge/background-work-guard";
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
  /** The session's runs that have not finished; marking it merged waits for every one. */
  currentRuns(projectPath: string, sessionName: string): readonly CurrentRun[];
  /** The session's conversations whose background work marking it merged must not pass (design C5b §5). */
  sessionBackgroundWork(
    projectPath: string,
    sessionName: string,
  ): readonly SessionBackgroundWork[];
  /**
   * Runs the mark with the session closed to new background work until the
   * finished flag is written; existing work is the mark's to refuse.
   */
  closeBackgroundWork<T>(
    scope: { projectPath: string; sessionName: string },
    commit: () => Promise<T>,
    options: { end: "merged"; stop: false },
  ): Promise<T>;
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
      const write = () =>
        deps.mutateSession(
          projectPath,
          sessionName,
          "setSessionMergeStatus",
          (row) => {
            row.finished = parsed.data.merged;
          },
        );
      const refusal = await getSessionLifecycleGate().runExclusive(
        projectPath,
        sessionName,
        async (): Promise<BackgroundWorkRefusal | null> => {
          if (!parsed.data.merged) {
            await write();
            return null;
          }
          assertNoCurrentRun(
            deps.currentRuns(projectPath, sessionName),
            "marking this session merged",
          );
          // Like a merge, a mark refuses background work; and none may start between
          // this read and the finished flag, which keeps any later custody out.
          return deps.closeBackgroundWork(
            { projectPath, sessionName },
            async () => {
              const refused = backgroundWorkRefusal(
                deps.sessionBackgroundWork(projectPath, sessionName),
                "marking this session merged",
              );
              if (refused === null) await write();
              return refused;
            },
            { end: "merged", stop: false },
          );
        },
      );
      if (refusal !== null) {
        logger.warn("session.merge_status_background_work_refused", {
          projectPath,
          sessionName,
          conversationId: refusal.conversationId,
        });
        return NextResponse.json(
          {
            error: refusal.message,
            code: refusal.code,
            details: { conversationId: refusal.conversationId },
          },
          { status: 409 },
        );
      }
      logger.info("session.merge_status_changed", {
        projectPath,
        sessionName,
        merged: parsed.data.merged,
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof CurrentRunError)
        return NextResponse.json(
          { error: err.message, code: err.code, details: err.details },
          { status: err.statusCode },
        );
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
  createMergeStatusHandler({
    resolveProjectPath,
    getSession,
    mutateSession,
    currentRuns,
    sessionBackgroundWork,
    closeBackgroundWork: closeCoreBackgroundWork,
  }),
);
