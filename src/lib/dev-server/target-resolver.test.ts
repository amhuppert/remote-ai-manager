import { describe, expect, it, vi } from "vitest";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { SeatWorkplace } from "@/lib/execution-context/host";
import type { SupervisedSeatWorkplace } from "@/lib/supervision/supervision";
import {
  createDevServerTargetResolver,
  type DevServerTargetResolverDeps,
} from "./target-resolver";

const SESSION_WORKTREE = "/repos/project/.worktrees/session";
const LANE_WORKTREE = "/repos/project/.worktrees/session.lane";

function session() {
  return sessionStateSchema.parse({
    sessionName: "s1",
    worktreePath: SESSION_WORKTREE,
    branchName: "session-branch",
    targetBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
  });
}

function seat(workplace: SeatWorkplace): SupervisedSeatWorkplace {
  return {
    projectPath: "/repos/project",
    sessionName: "s1",
    contextId: "run-1.api",
    workplace,
  };
}

const seats: Record<string, SupervisedSeatWorkplace> = {
  "lane-seat": seat({
    kind: "current",
    runId: "run-1",
    role: "implementer",
    worktreePath: LANE_WORKTREE,
    branch: "csm/s1-api",
    validationAccess: [],
  }),
  "session-seat": seat({
    kind: "current",
    runId: "run-1",
    role: "implementer",
    worktreePath: SESSION_WORKTREE,
    branch: null,
    validationAccess: [],
  }),
  "cancelled-seat": seat({
    kind: "refused",
    reason: "Context run-1.api has finished",
  }),
};

function makeDeps(
  overrides: Partial<DevServerTargetResolverDeps> = {},
): DevServerTargetResolverDeps {
  return {
    getSession: vi.fn(async () => session()),
    directoryExists: vi.fn(async (candidate) => candidate === LANE_WORKTREE),
    seatWorkplace: async (conversationId) => seats[conversationId] ?? null,
    ...overrides,
  };
}

function input(target: { kind: "session" }) {
  return {
    projectName: "project",
    projectPath: "/repos/project",
    sessionName: "s1",
    target,
  } as const;
}

describe("DevServerTargetResolver", () => {
  it("resolves an ordinary request to the addressed session worktree", async () => {
    const resolver = createDevServerTargetResolver(makeDeps());

    await expect(resolver.resolve(input({ kind: "session" }))).resolves.toEqual(
      {
        kind: "session",
        worktreePath: SESSION_WORKTREE,
        branchName: "session-branch",
        isolation: "session",
        executionId: null,
        contextId: null,
        laneId: null,
      },
    );
  });

  it("refuses a run seat working in a lane, which the session's dev servers do not serve", async () => {
    const resolver = createDevServerTargetResolver(makeDeps());

    await expect(
      resolver.resolve({ ...input({ kind: "session" }), caller: "lane-seat" }),
    ).rejects.toMatchObject({
      code: "RUN_LANE_NOT_SERVED",
      status: 409,
      message: expect.stringContaining(LANE_WORKTREE),
    });
    for (const caller of ["owner", "session-seat"])
      await expect(
        resolver.resolve({ ...input({ kind: "session" }), caller }),
      ).resolves.toMatchObject({ worktreePath: SESSION_WORKTREE });
  });

  it("refuses a run seat its context no longer places, rather than serving it the session", async () => {
    const resolver = createDevServerTargetResolver(makeDeps());

    await expect(
      resolver.resolve({
        ...input({ kind: "session" }),
        caller: "cancelled-seat",
      }),
    ).rejects.toMatchObject({
      code: "RUN_SEAT_NOT_CURRENT",
      status: 409,
      message: "Context run-1.api has finished",
    });
  });
});
