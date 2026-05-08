import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createActor } from "xstate";
import {
  runGraphContextSquashMerge,
  graphContextSquashMergeActor,
} from "./graph-context-squash-merge-actor";
import type {
  SquashMergeInput,
  SquashMergeOutput,
} from "@/lib/workflows/merge/actors";

const baseInput: SquashMergeInput = {
  projectPath: "/proj",
  branchName: "csm/test-session-context-a",
  message: "Merge: context-a",
  sessionName: "test-session",
  targetBranch: "csm/test-session",
  targetWorktreePath: "/proj/.worktrees/test-session",
};

function makeDeps(overrides: {
  squashMerge?: (
    mergePath: string,
    branchName: string,
    message: string,
    targetBranch: string,
  ) => Promise<{ mergeHash: string }>;
  acquireProjectLock?: (projectPath: string) => () => void;
  retryMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}) {
  return {
    squashMerge:
      overrides.squashMerge ?? vi.fn(async () => ({ mergeHash: "merge-abc" })),
    acquireProjectLock: overrides.acquireProjectLock ?? vi.fn(() => () => {}),
    retryMs: overrides.retryMs ?? 5,
    maxWaitMs: overrides.maxWaitMs ?? 1_000,
    sleep: overrides.sleep,
  };
}

describe("runGraphContextSquashMerge (graph variant)", () => {
  it("calls squashMerge once with the resolved merge path, branch, message, and target", async () => {
    const squashSpy = vi.fn(async () => ({ mergeHash: "merge-xyz" }));
    const deps = makeDeps({ squashMerge: squashSpy });

    const result = await runGraphContextSquashMerge(deps, baseInput);

    expect(result).toEqual({ mergeHash: "merge-xyz" });
    expect(squashSpy).toHaveBeenCalledTimes(1);
    expect(squashSpy).toHaveBeenCalledWith(
      baseInput.targetWorktreePath,
      baseInput.branchName,
      baseInput.message,
      baseInput.targetBranch,
    );
  });

  it("falls back to projectPath as merge path when targetWorktreePath is null", async () => {
    const squashSpy = vi.fn(async () => ({ mergeHash: "merge-1" }));
    const deps = makeDeps({ squashMerge: squashSpy });

    await runGraphContextSquashMerge(deps, {
      ...baseInput,
      targetWorktreePath: null,
    });

    expect(squashSpy).toHaveBeenCalledWith(
      baseInput.projectPath,
      baseInput.branchName,
      baseInput.message,
      baseInput.targetBranch,
    );
  });

  it("acquires the project lock with retry and releases it in finally", async () => {
    const release = vi.fn();
    let attempt = 0;
    const acquire = vi.fn(() => {
      attempt += 1;
      if (attempt < 3) {
        throw new Error("project busy");
      }
      return release;
    });

    const deps = makeDeps({ acquireProjectLock: acquire });
    await runGraphContextSquashMerge(deps, baseInput);

    expect(acquire).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the project lock when squashMerge throws", async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const squashErr = new Error("squash failed");
    const deps = makeDeps({
      acquireProjectLock: acquire,
      squashMerge: async () => {
        throw squashErr;
      },
    });

    await expect(runGraphContextSquashMerge(deps, baseInput)).rejects.toBe(
      squashErr,
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("throws if the project lock never frees within maxWaitMs", async () => {
    const acquire = vi.fn(() => {
      throw new Error("project busy");
    });

    const deps = makeDeps({
      acquireProjectLock: acquire,
      retryMs: 2,
      maxWaitMs: 30,
    });

    await expect(runGraphContextSquashMerge(deps, baseInput)).rejects.toThrow(
      /Another merge is in progress|Timed out/i,
    );
  });

  it("never references session-finalizing helpers in the source file", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(
      path.join(here, "graph-context-squash-merge-actor.ts"),
      "utf8",
    );

    // Strip block and line comments — comments may legitimately mention the
    // helper names (e.g. "does NOT invoke setSessionFinished"). What we want
    // to guarantee is that *code* never references them.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code).not.toMatch(/setSessionFinished/);
    expect(code).not.toMatch(/stopAllForSession/);
    expect(code).not.toMatch(/retargetOrphanedChildren/);
    expect(code).not.toMatch(/@\/lib\/state\b/);
    expect(code).not.toMatch(/@\/lib\/dev-server-registry\b/);
    expect(code).not.toMatch(/@\/lib\/sessions\b/);
  });
});

describe("graphContextSquashMergeActor (XState fromPromise actor)", () => {
  it("exposes a fromPromise actor that the merge machine can `provide`", () => {
    const actor = createActor(graphContextSquashMergeActor, {
      input: baseInput,
    });

    expect(typeof actor.start).toBe("function");
    expect(typeof actor.subscribe).toBe("function");
  });

  it("returns the SquashMergeOutput shape from the runtime function", async () => {
    const deps = makeDeps({
      squashMerge: async () => ({ mergeHash: "shape-check" }),
    });

    const out: SquashMergeOutput = await runGraphContextSquashMerge(
      deps,
      baseInput,
    );

    expect(out.mergeHash).toBe("shape-check");
  });
});

describe("graphContextSquashMergeActor — session-finalization side effects", () => {
  it("never calls setSessionFinished, stopAllForSession, or retargetOrphanedChildren (runtime spies)", async () => {
    const stateModule = await import("@/lib/state");
    const devServerModule = await import("@/lib/dev-server-registry");
    const sessionsModule = await import("@/lib/sessions");

    const setFinishedSpy = vi.spyOn(stateModule, "setSessionFinished");
    const stopAllSpy = vi.spyOn(devServerModule, "stopAllForSession");
    const retargetSpy = vi.spyOn(sessionsModule, "retargetOrphanedChildren");

    try {
      const deps = makeDeps({
        squashMerge: async () => ({ mergeHash: "no-side-effects" }),
      });
      await runGraphContextSquashMerge(deps, baseInput);

      expect(setFinishedSpy).not.toHaveBeenCalled();
      expect(stopAllSpy).not.toHaveBeenCalled();
      expect(retargetSpy).not.toHaveBeenCalled();
    } finally {
      setFinishedSpy.mockRestore();
      stopAllSpy.mockRestore();
      retargetSpy.mockRestore();
    }
  });

  it("does not invoke session-finalization helpers when squashMerge throws", async () => {
    const stateModule = await import("@/lib/state");
    const devServerModule = await import("@/lib/dev-server-registry");
    const sessionsModule = await import("@/lib/sessions");

    const setFinishedSpy = vi.spyOn(stateModule, "setSessionFinished");
    const stopAllSpy = vi.spyOn(devServerModule, "stopAllForSession");
    const retargetSpy = vi.spyOn(sessionsModule, "retargetOrphanedChildren");

    try {
      const deps = makeDeps({
        squashMerge: async () => {
          throw new Error("boom");
        },
      });

      await expect(runGraphContextSquashMerge(deps, baseInput)).rejects.toThrow(
        "boom",
      );

      expect(setFinishedSpy).not.toHaveBeenCalled();
      expect(stopAllSpy).not.toHaveBeenCalled();
      expect(retargetSpy).not.toHaveBeenCalled();
    } finally {
      setFinishedSpy.mockRestore();
      stopAllSpy.mockRestore();
      retargetSpy.mockRestore();
    }
  });
});
