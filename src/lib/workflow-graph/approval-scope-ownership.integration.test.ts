/**
 * R15.2 — the human approval surface over ONE real shared lane worktree.
 *
 * Context A (owns `a/`) parks at its approval gate while context B keeps working
 * and then LANDS in the same worktree. The claim the approval surface has to
 * make good on is that the human decides on the candidate the gate froze:
 *
 *  - the payload carries A's owned paths and none of B's,
 *  - it is byte-identical after B writes and after B lands,
 *  - a change inside A's OWN ownership is drift, and drift renders no patch.
 *
 * Read through the production reader (`resolveApprovalSnapshot` with its default
 * git deps) against real git, so what is proven is the wiring rather than a
 * rehearsal of it.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetDiffCacheForTesting,
  computeCandidateTreeHash,
} from "@/lib/git/diff";
import { defaultGitClient } from "@/lib/git/client";
import { buildChildEnv } from "@/lib/shared/child-env";
import { resolveApprovalSnapshot } from "./approval-snapshot";
import { candidateScopeForPlacement } from "./validation-diff-scope";
import { createGraphWorkflowValidationRoundService } from "./validation-services";
import { createWorkflowExecution } from "./test-fixtures";
import type { ContextPlacement } from "./definition-schemas";
import type { GraphWorkflowExecution } from "./schemas";

const execFileAsync = promisify(execFile);

const CONTEXT_ID = "context-implement";
const OWNED_BY_A: ContextPlacement = {
  lane: "impl",
  mode: "owned",
  ownedPaths: ["a"],
};
const FULL_ACCESS: ContextPlacement = { lane: "solo", mode: "full" };

describe("scoped approval snapshot over a shared lane worktree", () => {
  let worktreePath: string;
  let reviewBaselineSha: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: worktreePath,
      env: buildChildEnv(),
    });
    return stdout;
  }

  /** The production freeze path, reading real git in the lane worktree. */
  const roundService = createGraphWorkflowValidationRoundService({
    getSession: async () => null,
    readHeadSha: (path) =>
      defaultGitClient
        .git(["rev-parse", "HEAD"], path)
        .then((result) => result.stdout.trim() || null)
        .catch(() => null),
    computeCandidateIdentity: (path, scope) =>
      computeCandidateTreeHash(path, scope),
  });

  function parkedExecution(
    placement: ContextPlacement,
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution({ status: "running" });
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === CONTEXT_ID,
    );
    if (!context) throw new Error("fixture context missing");
    context.placement = placement;
    context.humanApprovalGate = { enabled: true };

    const contextState = execution.contextStates[CONTEXT_ID];
    if (!contextState) throw new Error("fixture context state missing");
    contextState.status = "awaiting_approval";
    contextState.worktreePath = worktreePath;
    contextState.isolation = "worktree";
    contextState.laneId = "impl";
    contextState.reviewOrigin = {
      laneId: "impl",
      baselineSha: reviewBaselineSha,
      candidateScope:
        placement.mode === "full"
          ? { mode: "wholeTree" }
          : {
              mode: "owned",
              ownedPaths:
                placement.mode === "owned" ? [...placement.ownedPaths] : [],
            },
      capturedAt: "2026-09-15T12:00:00.000Z",
    };
    contextState.pendingApproval = {
      conversationId: "conv-approval",
      requestedAt: "2026-08-08T09:00:00.000Z",
      decision: null,
      approvalScope: { kind: "whole_tree" },
    };
    return execution;
  }

  /** Freeze exactly the way entering the gate does, and stamp the record. */
  async function freezeGate(
    execution: GraphWorkflowExecution,
    placement: ContextPlacement,
  ): Promise<void> {
    const scope = candidateScopeForPlacement(placement);
    const tree = await roundService.resolveCandidateTree({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: CONTEXT_ID,
      candidateScope: scope,
      executionTarget: {
        worktreePath,
        branchName: "csm/session-1-lane-impl",
        isolation: "worktree",
        laneId: "impl",
      },
    });
    if (tree.kind !== "resolved") {
      throw new Error(`candidate unresolved: ${tree.reason}`);
    }
    const pending = execution.contextStates[CONTEXT_ID]?.pendingApproval;
    if (!pending) throw new Error("fixture missing pending approval");
    pending.approvalScope =
      scope.mode === "wholeTree"
        ? {
            kind: "whole_tree",
            treeHash: tree.candidateTreeHash,
            headSha: tree.headSha,
          }
        : {
            kind: "scoped",
            ownedPaths: [...scope.ownedPaths],
            treeHash: tree.candidateTreeHash,
            headSha: tree.headSha,
          };
  }

  function readApprovalView(execution: GraphWorkflowExecution) {
    return resolveApprovalSnapshot({
      execution,
      contextId: CONTEXT_ID,
      // Deliberately NOT the lane worktree: a payload that fell back here would
      // be reading a different tree than the one the context worked in.
      sessionWorktreePath: "/nonexistent-session-worktree",
    });
  }

  beforeEach(async () => {
    _resetDiffCacheForTesting();
    worktreePath = await mkdtemp(join(tmpdir(), "cc-approval-lane-"));
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await mkdir(join(worktreePath, "a"), { recursive: true });
    await mkdir(join(worktreePath, "b"), { recursive: true });
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 1;\n",
    );
    await writeFile(
      join(worktreePath, "b", "sibling.ts"),
      "export const b = 1;\n",
    );
    await git("add", "-A");
    await git("commit", "-m", "lane base");
    reviewBaselineSha = (await git("rev-parse", "HEAD")).trim();
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it("stays byte-identical while a sibling writes and then lands", async () => {
    const execution = parkedExecution(OWNED_BY_A);
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );
    await writeFile(
      join(worktreePath, "a", "added.ts"),
      "export const c = 3;\n",
    );
    await freezeGate(execution, OWNED_BY_A);

    const atPark = await readApprovalView(execution);
    expect(atPark.kind).toBe("scoped");
    if (atPark.kind !== "scoped") throw new Error("expected a scoped payload");
    const changedPaths = atPark.snapshot.diff.files.map((f) => f.filePath);
    expect(changedPaths).toEqual(
      expect.arrayContaining(["a/owned.ts", "a/added.ts"]),
    );
    expect(changedPaths.some((path) => path.startsWith("b/"))).toBe(false);

    // B is mid-turn in the shared worktree, in its own paths.
    await writeFile(
      join(worktreePath, "b", "sibling.ts"),
      "export const b = 2;\n",
    );
    await writeFile(
      join(worktreePath, "b", "added.ts"),
      "export const d = 4;\n",
    );
    expect(await readApprovalView(execution)).toEqual(atPark);

    // B LANDS: HEAD moves under A's standing gate.
    await git("add", "b");
    await git("commit", "-m", "sibling lands");
    expect(await readApprovalView(execution)).toEqual(atPark);
  });

  it("refuses to render once A's own owned paths move", async () => {
    const execution = parkedExecution(OWNED_BY_A);
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );
    await freezeGate(execution, OWNED_BY_A);
    const frozenScope =
      execution.contextStates[CONTEXT_ID]?.pendingApproval?.approvalScope;
    const frozen =
      frozenScope?.kind === "scoped" ? frozenScope.treeHash : undefined;

    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 3;\n",
    );

    const drifted = await readApprovalView(execution);
    expect(drifted.kind).toBe("drifted");
    if (drifted.kind !== "drifted") throw new Error("expected drift");
    expect(drifted.frozenTreeHash).toBe(frozen);
    expect(drifted.observedTreeHash).not.toBe(frozen);
  });

  it("resolves A's approval view while B leaves a path git cannot index", async () => {
    const execution = parkedExecution(OWNED_BY_A);
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );
    await freezeGate(execution, OWNED_BY_A);

    // Mid-turn state a sibling can legitimately produce in its own paths, and
    // that staging the whole shared worktree aborts on.
    const nested = join(worktreePath, "b", "nested");
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init", "-q"], {
      cwd: nested,
      env: buildChildEnv(),
    });
    await writeFile(join(nested, "x.ts"), "export const x = 1;\n");

    const resolution = await readApprovalView(execution);
    expect(resolution.kind).toBe("scoped");
    if (resolution.kind !== "scoped") throw new Error("expected scoped");
    expect(resolution.snapshot.diff.files.map((f) => f.filePath)).toEqual([
      "a/owned.ts",
    ]);
  });

  it("leaves a full-access member on the whole-tree approval view", async () => {
    const execution = parkedExecution(FULL_ACCESS);
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );
    await freezeGate(execution, FULL_ACCESS);

    expect(await readApprovalView(execution)).toMatchObject({
      kind: "whole_tree",
      contextId: CONTEXT_ID,
      snapshot: { diff: { files: [{ filePath: "a/owned.ts" }] } },
    });
  });
});
