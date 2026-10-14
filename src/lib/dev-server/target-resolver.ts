import path from "node:path";
import { stat } from "node:fs/promises";
import { createLogger } from "@/lib/logging";
import { getSession } from "@/lib/state-store";
import type { SessionState } from "@/lib/sessions/schemas";

import { supervisedSeatWorkplace } from "@/lib/supervision/handles";
import type { SupervisedSeatWorkplace } from "@/lib/supervision/supervision";
import type { DevServerTargetRef } from "./schemas";

const logger = createLogger("dev-server-target-resolver");

export type DevServerTargetErrorCode =
  | "INVALID_DEV_SERVER_TARGET"
  | "SESSION_NOT_FOUND"
  | "RUN_LANE_NOT_SERVED"
  | "RUN_SEAT_NOT_CURRENT";

export class DevServerTargetError extends Error {
  constructor(
    readonly code: DevServerTargetErrorCode,
    message: string,
    readonly status: number,
    readonly instruction?: string,
  ) {
    super(message);
    this.name = "DevServerTargetError";
  }
}

export interface ResolvedDevServerTarget {
  kind: DevServerTargetRef["kind"];
  worktreePath: string;
  branchName: string;
  isolation: "session" | "worktree";
  executionId: string | null;
  contextId: string | null;
  laneId: string | null;
}

export interface DevServerTargetResolverInput {
  projectName: string;
  projectPath: string;
  sessionName: string;
  target: DevServerTargetRef;
  /** The calling conversation, when an agent names itself. */
  caller?: string | null;
}

export interface DevServerTargetResolver {
  resolve(
    input: DevServerTargetResolverInput,
  ): Promise<ResolvedDevServerTarget>;
}

export interface DevServerTargetResolverDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  directoryExists(candidate: string): Promise<boolean>;
  /** Where a run seat works, or null for any other conversation. */
  seatWorkplace(
    conversationId: string,
  ): Promise<SupervisedSeatWorkplace | null>;
}

const defaultDeps: DevServerTargetResolverDeps = {
  getSession,
  seatWorkplace: async (conversationId) =>
    supervisedSeatWorkplace(conversationId),
  async directoryExists(candidate) {
    try {
      return (await stat(candidate)).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * The session's dev servers serve a run seat only while it is current and
 * works in the session worktree. Lane dev servers would outlive the lane:
 * nothing stops them when it is removed.
 */
function refuseUnservedSeat(seat: SupervisedSeatWorkplace): void {
  const { workplace } = seat;
  if (workplace.kind === "refused")
    throw new DevServerTargetError(
      "RUN_SEAT_NOT_CURRENT",
      workplace.reason,
      409,
    );
  if (workplace.branch !== null)
    throw new DevServerTargetError(
      "RUN_LANE_NOT_SERVED",
      `Dev servers run the session worktree; your work for context "${seat.contextId}" is in its lane at ${workplace.worktreePath}, which no dev server serves.`,
      409,
      "Check the work in your lane with what your briefing allows, or ask your owner with `cctl ask` if it needs a running app.",
    );
}

export function parseDevServerTarget(request: Request): DevServerTargetRef {
  const params = new URL(request.url).searchParams;
  if (params.has("executionId") || params.has("contextId"))
    throw new DevServerTargetError(
      "INVALID_DEV_SERVER_TARGET",
      "Graph workflow targets are no longer supported",
      400,
    );
  return { kind: "session" };
}

export function createDevServerTargetResolver(
  deps: DevServerTargetResolverDeps = defaultDeps,
): DevServerTargetResolver {
  return {
    async resolve(input) {
      const { projectName, projectPath, sessionName, target } = input;
      try {
        const session = await deps.getSession(projectPath, sessionName);
        if (!session) {
          throw new DevServerTargetError(
            "SESSION_NOT_FOUND",
            `Session "${sessionName}" was not found.`,
            404,
          );
        }

        let resolved: ResolvedDevServerTarget;
        {
          const seat = input.caller
            ? await deps.seatWorkplace(input.caller)
            : null;
          if (seat !== null) refuseUnservedSeat(seat);
          resolved = {
            kind: "session",
            worktreePath: path.resolve(session.worktreePath),
            branchName: session.branchName,
            isolation: "session",
            executionId: null,
            contextId: null,
            laneId: null,
          };
        }

        logger.debug("dev-server.target.resolved", {
          projectName,
          sessionName,
          targetKind: resolved.kind,
          executionId: resolved.executionId,
          contextId: resolved.contextId,
          laneId: resolved.laneId,
          isolation: resolved.isolation,
          worktreePath: resolved.worktreePath,
        });
        return resolved;
      } catch (error) {
        if (error instanceof DevServerTargetError) {
          logger.warn("dev-server.target.rejected", {
            projectName,
            sessionName,
            targetKind: target.kind,
            executionId: null,
            contextId: null,
            code: error.code,
          });
        }
        throw error;
      }
    },
  };
}

export const devServerTargetResolver = createDevServerTargetResolver();
