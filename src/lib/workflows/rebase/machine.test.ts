import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise, toPromise } from "xstate";
import { rebaseMachine } from "./machine";
import type { RebaseInput } from "./types";
import type {
  GetCurrentBranchInput,
  GetCurrentBranchOutput,
  CheckTrackedChangesInput,
  CheckTrackedChangesOutput,
  ResolveOntoInput,
  ResolveOntoOutput,
  StartRebaseInput,
  ContinueRebaseInput,
  RebaseStepOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  AbortRebaseInput,
  AbortRebaseOutput,
} from "./actors";

function mockActor<TOut, TIn>(fn: (input: TIn) => Promise<TOut>) {
  return fromPromise<TOut, TIn>(async ({ input }) => fn(input));
}

const defaultInput: RebaseInput = {
  jobId: "rebase-001",
  projectPath: "/projects/app",
  projectName: "app",
  sessionName: "test-session",
  worktreePath: "/projects/app/.worktrees/test-session",
  branchName: "csm/test-session",
  onto: { kind: "local", branch: "main" },
};

interface Overrides {
  getCurrentBranch?: (
    i: GetCurrentBranchInput,
  ) => Promise<GetCurrentBranchOutput>;
  checkTrackedChanges?: (
    i: CheckTrackedChangesInput,
  ) => Promise<CheckTrackedChangesOutput>;
  resolveOnto?: (i: ResolveOntoInput) => Promise<ResolveOntoOutput>;
  startRebase?: (i: StartRebaseInput) => Promise<RebaseStepOutput>;
  continueRebase?: (i: ContinueRebaseInput) => Promise<RebaseStepOutput>;
  resolveConflicts?: (
    i: ResolveConflictsInput,
  ) => Promise<ResolveConflictsOutput>;
  abortRebase?: (i: AbortRebaseInput) => Promise<AbortRebaseOutput>;
}

function testMachine(o: Overrides = {}) {
  return rebaseMachine.provide({
    actors: {
      getCurrentBranch: mockActor(
        o.getCurrentBranch ??
          (async () => ({ branch: defaultInput.branchName })),
      ),
      checkTrackedChanges: mockActor(
        o.checkTrackedChanges ?? (async () => ({ hasChanges: false })),
      ),
      resolveOnto: mockActor(
        o.resolveOnto ?? (async () => ({ ref: "main", label: "main" })),
      ),
      startRebase: mockActor(
        o.startRebase ?? (async () => ({ status: "completed" })),
      ),
      continueRebase: mockActor(
        o.continueRebase ?? (async () => ({ status: "completed" })),
      ),
      resolveConflicts: mockActor(
        o.resolveConflicts ??
          (async () => ({ status: "resolved", conflicts: [] })),
      ),
      abortRebase: mockActor(o.abortRebase ?? (async () => undefined)),
    },
  });
}

async function run(o: Overrides = {}, input: RebaseInput = defaultInput) {
  const states: string[] = [];
  const actor = createActor(testMachine(o), { input });
  actor.subscribe((s) => states.push(String(s.value)));
  actor.start();
  const output = await toPromise(actor);
  return { output, states };
}

describe("rebaseMachine", () => {
  it("clean rebase completes and reports the target label", async () => {
    const { output, states } = await run({
      resolveOnto: async () => ({ ref: "deadbeef", label: "origin/main" }),
    });

    expect(output.status).toBe("completed");
    expect(output.error).toBeNull();
    expect(output.ontoLabel).toBe("origin/main");
    expect(states).toEqual([
      "verifyingBranch",
      "checkingClean",
      "resolvingOnto",
      "rebasing",
      "completed",
    ]);
  });

  it("fails fast on a dirty worktree without touching the rebase", async () => {
    const startRebase = vi.fn(async () => ({ status: "completed" as const }));
    const { output, states } = await run({
      checkTrackedChanges: async () => ({ hasChanges: true }),
      startRebase,
    });

    expect(output.status).toBe("failed");
    expect(output.error).toMatch(/uncommitted changes/i);
    expect(startRebase).not.toHaveBeenCalled();
    expect(states).not.toContain("resolvingOnto");
  });

  it("fails when the worktree is on the wrong branch", async () => {
    const { output } = await run({
      getCurrentBranch: async () => ({ branch: "some-other-branch" }),
    });

    expect(output.status).toBe("failed");
    expect(output.error).toMatch(/some-other-branch/);
  });

  it("resolves a single conflict, continues, and completes", async () => {
    const resolveConflicts = vi.fn(
      async (_i: ResolveConflictsInput): Promise<ResolveConflictsOutput> => ({
        status: "resolved",
        conflicts: [],
      }),
    );
    const { output, states } = await run({
      startRebase: async () => ({
        status: "conflicts",
        conflictFiles: ["a.ts"],
      }),
      continueRebase: async () => ({ status: "completed" }),
      resolveConflicts,
    });

    expect(output.status).toBe("completed");
    expect(resolveConflicts).toHaveBeenCalledTimes(1);
    expect(resolveConflicts.mock.calls[0]?.[0]?.conflictFiles).toEqual([
      "a.ts",
    ]);
    expect(states).toContain("resolvingConflicts");
    expect(states).toContain("continuingRebase");
  });

  it("loops through multiple conflicting commits until the rebase concludes", async () => {
    let continueCalls = 0;
    const resolveConflicts = vi.fn(
      async (_i: ResolveConflictsInput): Promise<ResolveConflictsOutput> => ({
        status: "resolved",
        conflicts: [],
      }),
    );
    const { output } = await run({
      startRebase: async () => ({
        status: "conflicts",
        conflictFiles: ["a.ts"],
      }),
      continueRebase: async () => {
        continueCalls += 1;
        // first continue hits the next commit's conflict, second finishes
        return continueCalls === 1
          ? { status: "conflicts", conflictFiles: ["b.ts"] }
          : { status: "completed" };
      },
      resolveConflicts,
    });

    expect(output.status).toBe("completed");
    expect(resolveConflicts).toHaveBeenCalledTimes(2);
    expect(resolveConflicts.mock.calls[1]?.[0]?.conflictFiles).toEqual([
      "b.ts",
    ]);
  });

  it("aborts and restores when automatic resolution fails", async () => {
    const abortRebase = vi.fn(async () => undefined);
    const { output, states } = await run({
      startRebase: async () => ({
        status: "conflicts",
        conflictFiles: ["a.ts"],
      }),
      resolveConflicts: async () => ({
        status: "failed",
        conflicts: [],
        partialConflicts: [
          { file: "a.ts", description: "", resolution: "", rationale: "" },
        ],
      }),
      abortRebase,
    });

    expect(output.status).toBe("failed");
    expect(abortRebase).toHaveBeenCalledTimes(1);
    expect(output.error).toMatch(/a\.ts/);
    expect(output.error).toMatch(/aborted/i);
    expect(output.conflictFiles).toEqual(["a.ts"]);
    expect(states).toContain("abortingRebase");
  });

  it("aborts when the resolve/continue loop exceeds the round cap", async () => {
    const abortRebase = vi.fn(async () => undefined);
    const { output } = await run(
      {
        startRebase: async () => ({
          status: "conflicts",
          conflictFiles: ["a.ts"],
        }),
        // every continue re-conflicts, so the loop can never converge
        continueRebase: async () => ({
          status: "conflicts",
          conflictFiles: ["a.ts"],
        }),
        abortRebase,
      },
      { ...defaultInput, maxConflictRounds: 1 },
    );

    expect(output.status).toBe("failed");
    expect(abortRebase).toHaveBeenCalledTimes(1);
    expect(output.error).toMatch(/resolution rounds/i);
  });
});
