import { describe, expect, it, vi } from "vitest";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
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

function execution() {
  const value = graphWorkflowExecutionSchema.parse(
    buildMaximalGraphWorkflowExecution(),
  );
  value.id = "execution-1";
  value.contextStates["ctx-1"]!.status = "running";
  value.contextStates["ctx-1"]!.cleanupStatus = "not-applicable";
  value.contextStates["ctx-1"]!.laneId = "lane-1";
  value.executionLanes["lane-1"]!.worktreePath = LANE_WORKTREE;
  value.executionLanes["lane-1"]!.branchName = "lane-branch";
  return value;
}

function makeDeps(
  overrides: Partial<DevServerTargetResolverDeps> = {},
): DevServerTargetResolverDeps {
  return {
    getSession: vi.fn(async () => session()),
    getActiveGraphWorkflowExecution: vi.fn(async () => execution()),
    directoryExists: vi.fn(async (candidate) => candidate === LANE_WORKTREE),
    ...overrides,
  };
}

function input(
  target:
    | { kind: "session" }
    | {
        kind: "workflow-context";
        executionId: string;
        contextId: string;
      },
) {
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

  it("resolves an exact active workflow context through the canonical execution target", async () => {
    const resolver = createDevServerTargetResolver(makeDeps());

    await expect(
      resolver.resolve(
        input({
          kind: "workflow-context",
          executionId: "execution-1",
          contextId: "ctx-1",
        }),
      ),
    ).resolves.toEqual({
      kind: "workflow-context",
      worktreePath: LANE_WORKTREE,
      branchName: "lane-branch",
      isolation: "worktree",
      executionId: "execution-1",
      contextId: "ctx-1",
      laneId: "lane-1",
    });
  });

  it("rejects a stale execution claim without falling back to the session", async () => {
    const resolver = createDevServerTargetResolver(makeDeps());

    await expect(
      resolver.resolve(
        input({
          kind: "workflow-context",
          executionId: "stale-execution",
          contextId: "ctx-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_NOT_ACTIVE" });
  });

  it("rejects an unknown context without falling back to the session", async () => {
    const resolver = createDevServerTargetResolver(makeDeps());

    await expect(
      resolver.resolve(
        input({
          kind: "workflow-context",
          executionId: "execution-1",
          contextId: "missing",
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTEXT_NOT_FOUND" });
  });

  it("rejects a context whose lane worktree is being removed", async () => {
    const unavailable = execution();
    unavailable.contextStates["ctx-1"]!.cleanupStatus = "pending";
    const resolver = createDevServerTargetResolver(
      makeDeps({
        getActiveGraphWorkflowExecution: vi.fn(async () => unavailable),
      }),
    );

    await expect(
      resolver.resolve(
        input({
          kind: "workflow-context",
          executionId: "execution-1",
          contextId: "ctx-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_WORKTREE_UNAVAILABLE" });
  });

  it("rejects an unprovisioned context instead of accepting canonical session fallback", async () => {
    const unprovisioned = execution();
    unprovisioned.contextStates["ctx-1"]!.status = "ready";
    unprovisioned.contextStates["ctx-1"]!.laneId = null;
    unprovisioned.contextStates["ctx-1"]!.worktreePath = null;
    unprovisioned.contextStates["ctx-1"]!.branchName = null;
    const resolver = createDevServerTargetResolver(
      makeDeps({
        getActiveGraphWorkflowExecution: vi.fn(async () => unprovisioned),
      }),
    );

    await expect(
      resolver.resolve(
        input({
          kind: "workflow-context",
          executionId: "execution-1",
          contextId: "ctx-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_WORKTREE_UNAVAILABLE" });
  });

  it("rejects a resolved workflow path that no longer exists", async () => {
    const resolver = createDevServerTargetResolver(
      makeDeps({ directoryExists: vi.fn(async () => false) }),
    );

    await expect(
      resolver.resolve(
        input({
          kind: "workflow-context",
          executionId: "execution-1",
          contextId: "ctx-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_WORKTREE_UNAVAILABLE" });
  });
});
