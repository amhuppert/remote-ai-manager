import { describe, expect, it } from "vitest";
import { fromPromise } from "xstate";
import { mergeMachine } from "@/lib/workflows/merge/machine";
import type {
  ClassifyWorktreeInput,
  ClassifyWorktreeOutput,
  CommitResolutionInput,
  CommitResolutionOutput,
  GetCurrentBranchInput,
  GetCurrentBranchOutput,
  MergeMainInput,
  MergeMainOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
} from "@/lib/workflows/merge/actors";
import type { RunValidationInput, RunValidationOutput } from "@/lib/workflows/validation-fix/actors";
import type { LaneTarget } from "./schemas";
import { createLaneConflictActors, createSmartMergeIntegrator } from "./smart-merge-integrator";
import { createActor, toPromise } from "xstate";
import type { ResolveConflictsParams } from "@/lib/sessions/conflict-resolution";

const lane: LaneTarget = {
  projectPath: "/repo",
  sessionName: "session",
  laneId: "1-api",
  worktreePath: "/repo/.worktrees/session.1-api",
  branch: "csm/session-1-api",
  sessionWorktreePath: "/repo/.worktrees/session",
  sessionBranch: "csm/session",
};

/**
 * The Smart Merge machine with its Git and agent actors standing in, so the
 * integrator's own choices (inputs, its end before the machine's publication,
 * how outcomes read) run against the real state machine.
 */
function harness(options: {
  merge?: MergeMainOutput;
  resolution?: ResolveConflictsOutput;
  validation?: (input: RunValidationInput) => Promise<RunValidationOutput>;
  cleanup?: "aborted" | "kept" | "none";
}) {
  const calls = {
    merges: [] as MergeMainInput[],
    resolutions: [] as ResolveConflictsInput[],
    validations: [] as RunValidationInput[],
    aborted: [] as string[],
  };
  let cleanup: "aborted" | "kept" | "none" = options.cleanup ?? "aborted";
  const machine = mergeMachine.provide({
    actors: {
      getCurrentBranch: fromPromise<GetCurrentBranchOutput, GetCurrentBranchInput>(async () => ({
        branch: lane.branch,
      })),
      classifyWorktree: fromPromise<ClassifyWorktreeOutput, ClassifyWorktreeInput>(async () => ({ kind: "clean" })),
      mergeMain: fromPromise<MergeMainOutput, MergeMainInput>(async ({ input }) => {
        calls.merges.push(input);
        return options.merge ?? { status: "clean", conflictFiles: [] };
      }),
      resolveConflicts: fromPromise<ResolveConflictsOutput, ResolveConflictsInput>(async ({ input }) => {
        calls.resolutions.push(input);
        return options.resolution ?? { status: "resolved", conflicts: [] };
      }),
      commitResolution: fromPromise<CommitResolutionOutput, CommitResolutionInput>(async () => ({
        hash: "m1",
        committedBy: "orchestrator",
      })),
      runValidation: fromPromise<RunValidationOutput, RunValidationInput>(async ({ input }) => {
        calls.validations.push(input);
        return options.validation === undefined ? null : options.validation(input);
      }),
    },
  });
  const integrator = createSmartMergeIntegrator({
    machine,
    lanes: {
      async abortUnresolvedMerge(worktreePath) {
        calls.aborted.push(worktreePath);
        return cleanup;
      },
    },
    log: { info: () => {}, warn: () => {} },
  });
  const integrate = (checks: string[] = [], signal = new AbortController().signal) =>
    integrator.integrate({ lane, head: "h7", checks, cause: "run-1:publish:api:1", signal });
  return { integrate, calls, keep: () => (cleanup = "kept") };
}

describe("Smart Merge lane integration", () => {
  it("merges the captured session head into the lane and runs the lane's checks there, without publishing", async () => {
    const h = harness({});
    expect(await h.integrate(["typecheck", "test"])).toEqual({ kind: "integrated" });
    expect(h.calls.merges).toEqual([{ worktreePath: lane.worktreePath, targetBranch: "h7" }]);
    expect(h.calls.validations).toEqual([
      expect.objectContaining({
        worktreePath: lane.worktreePath,
        branchName: lane.branch,
        targetBranch: "h7",
        selection: { mode: "only", commands: ["typecheck", "test"] },
      }),
    ]);
  });

  it("has the resolver agent settle conflicts as a fresh task, then checks the result", async () => {
    const h = harness({ merge: { status: "conflicts", conflictFiles: ["src/shared.ts"] } });
    expect(await h.integrate(["typecheck"])).toEqual({ kind: "integrated" });
    expect(h.calls.resolutions).toEqual([
      expect.objectContaining({
        worktreePath: lane.worktreePath,
        conflictFiles: ["src/shared.ts"],
        agentTurnDispatch: "fresh-run",
        resolutionContext: expect.stringContaining(lane.sessionBranch),
      }),
    ]);
    expect(h.calls.resolutions[0]?.conversationId).toBeUndefined();
    expect(h.calls.validations).toHaveLength(1);
  });

  it("fails with the reason, and leaves no merge in progress, when the resolver cannot settle the conflicts", async () => {
    const h = harness({
      merge: { status: "conflicts", conflictFiles: ["src/shared.ts"] },
      resolution: { status: "unresolved", error: "Both sides rewrote the same function" },
    });
    const result = await h.integrate();
    expect(result).toEqual({
      kind: "failed",
      detail: expect.stringContaining("src/shared.ts"),
    });
    expect(result.kind === "failed" ? result.detail : "").toContain("Both sides rewrote the same function");
    expect(h.calls.aborted).toEqual([lane.worktreePath]);
  });

  it("fails with the check's reason when the checks cannot be made to pass", async () => {
    const h = harness({
      validation: async () => {
        throw new Error("typecheck failed: 2 errors");
      },
    });
    expect(await h.integrate(["typecheck"])).toEqual({
      kind: "failed",
      detail: expect.stringContaining("typecheck failed: 2 errors"),
    });
  });

  it("skips validation when the lane has no publication checks", async () => {
    const h = harness({});
    expect(await h.integrate([])).toEqual({ kind: "integrated" });
    expect(h.calls.validations).toEqual([]);
  });

  it("undoes its own merge when the resolver cannot run at all, so a retry needs no manual Git", async () => {
    const h = harness({
      merge: { status: "conflicts", conflictFiles: ["src/shared.ts"] },
      resolution: {
        status: "infrastructure",
        failure: { kind: "backend_error", message: "The provider is unreachable", retryable: true },
      },
    });
    const result = await h.integrate();
    expect(result).toMatchObject({ kind: "failed" });
    expect(h.calls.aborted).toEqual([lane.worktreePath]);
  });

  it("keeps a resolution it could not confirm and tells the owner to commit it", async () => {
    const h = harness({
      merge: { status: "conflicts", conflictFiles: ["src/shared.ts"] },
      resolution: { status: "unresolved", error: "Markers could not be read" },
      cleanup: "kept",
    });
    const result = await h.integrate();
    expect(result.kind === "failed" ? result.detail : "").toMatch(/commit/);
    expect(result.kind === "failed" ? result.detail : "").toMatch(/in progress/);
  });

  it("starts nothing once its caller has stopped", async () => {
    const h = harness({});
    const controller = new AbortController();
    controller.abort();
    expect(await h.integrate([], controller.signal)).toEqual({
      kind: "failed",
      detail: expect.stringContaining("Stopped"),
    });
    expect(h.calls.merges).toEqual([]);
  });

  it("has the lane's resolver run as a fresh task that stops with its caller, never in a conversation", async () => {
    const received: ResolveConflictsParams[] = [];
    const actors = createLaneConflictActors({
      async resolveConflicts(params) {
        received.push(params);
        return { status: "resolved", conflicts: [] };
      },
      async analyzeConflicts() {
        return { status: "analyzed", conflicts: [] };
      },
    });
    const actor = createActor(actors.resolveConflicts, {
      input: { worktreePath: lane.worktreePath, projectPath: "/repo", sessionName: "session", conversationId: "owner-1" },
    });
    actor.start();
    expect(await toPromise(actor)).toEqual({ status: "resolved", conflicts: [] });
    expect(received).toEqual([
      expect.objectContaining({ worktreePath: lane.worktreePath, agentTurnDispatch: "fresh-run", signal: expect.any(AbortSignal) }),
    ]);
    expect(received[0]?.conversationId).toBeUndefined();
  });
});
