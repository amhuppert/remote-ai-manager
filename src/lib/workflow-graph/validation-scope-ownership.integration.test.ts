import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
/**
 * R15.1 — the whole scoped-validation path over ONE real shared worktree.
 *
 * Two enveloped contexts occupy the same lane worktree: A owns `a/`, B owns `b/`.
 * The units are covered elsewhere; what this file proves is that the three places
 * that must agree actually do, on the same bytes, through the production wiring:
 *
 *  - the FREEZE (`createGraphWorkflowValidationRoundService` over real git),
 *  - the RE-READ that decides whether the round still owns its candidate
 *    (`candidateIdentityMatches`),
 *  - the RENDERING a validator turn is handed (`renderRoundCommonSections`).
 *
 * A sibling writing and then LANDING its own paths mid-round is the case that
 * distinguishes a scoped identity from a whole-tree one: HEAD moves and the shared
 * worktree changes, while nothing context A owns does.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDiffCacheForTesting } from "@/lib/git/diff";
import { buildChildEnv } from "@/lib/shared/child-env";
import { createGraphWorkflowValidationRoundService } from "./validation-services";
import { createValidatorRunner } from "./validator-runner";
import {
  candidateIdentityMatches,
  describeCandidateDrift,
  freezeValidationCandidate,
  type ValidationCandidateTreeResolution,
} from "./validation-round";
import { candidateScopeForPlacement } from "./validation-diff-scope";
import {
  createWorkflowExecution,
  makeValidatorAssignment,
  seedAssignment,
  makeStubValidatorContinuityService,
} from "./test-fixtures";
import { computeCandidateTreeHash } from "@/lib/git/diff";
import { defaultGitClient } from "@/lib/git/client";
import type { ContextPlacement } from "./definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationCandidate,
} from "./schemas";

const execFileAsync = promisify(execFile);

const OWNED_BY_A: ContextPlacement = {
  lane: "impl",
  mode: "owned",
  ownedPaths: ["a"],
};
const OWNED_BY_B: ContextPlacement = {
  lane: "impl",
  mode: "owned",
  ownedPaths: ["b"],
};
const FULL_ACCESS: ContextPlacement = { lane: "solo", mode: "full" };

describe("scoped candidate identity and rendering over a shared lane worktree", () => {
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

  function executionWithPlacement(
    contextId: string,
    placement: ContextPlacement,
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution({ status: "running" });
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === contextId,
    );
    if (!context) throw new Error(`fixture context ${contextId} missing`);
    context.placement = placement;
    execution.contextStates[contextId]!.reviewOrigin = {
      laneId: execution.contextStates[contextId]!.laneId,
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
    context.contextValidator = {
      enabled: true,
      assignments: [seedAssignment(makeValidatorAssignment({ id: "general" }))],
    };
    return execution;
  }

  async function observe(
    execution: GraphWorkflowExecution,
    contextId: string,
    placement: ContextPlacement,
  ): Promise<GraphWorkflowValidationCandidate> {
    const tree: ValidationCandidateTreeResolution =
      await roundService.resolveCandidateTree({
        projectPath: "/repo",
        sessionName: "session-1",
        contextId,
        candidateScope: candidateScopeForPlacement(placement),
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
    return freezeValidationCandidate({
      tree,
      taskStates: execution.taskStates,
      contextId,
    });
  }

  /** What a validator turn for `contextId` is actually handed. */
  async function renderFor(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): Promise<{ diffScopeSection: string; candidateTreeHash: string | null }> {
    const runner = createValidatorRunner({
      continuityService: makeStubValidatorContinuityService(),
      executionContract: createTestGraphExecutionContract(),
      resolveWorktreePath: async () => worktreePath,
      resolveTimeoutMs: async () => 30_000,
      getProjectDisplayName: () => "repo",
    });
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === contextId,
    );
    if (!context) throw new Error(`fixture context ${contextId} missing`);
    return runner.renderRoundCommonSections({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context,
      executionTarget: {
        worktreePath,
        branchName: "csm/session-1-lane-impl",
        isolation: "worktree",
        laneId: "impl",
      },
    });
  }

  beforeEach(async () => {
    _resetDiffCacheForTesting();
    worktreePath = await mkdtemp(join(tmpdir(), "cc-shared-lane-"));
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

  it("shows A only its own changes and survives B writing and landing mid-round", async () => {
    const execution = executionWithPlacement("context-plan", OWNED_BY_A);

    // A does its work.
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );
    await writeFile(
      join(worktreePath, "a", "added.ts"),
      "export const c = 3;\n",
    );
    const frozen = await observe(execution, "context-plan", OWNED_BY_A);
    expect(frozen.identityScope).toBe("owned");

    // B is mid-turn in the same worktree, in its own paths.
    await writeFile(
      join(worktreePath, "b", "sibling.ts"),
      "export const b = 2;\n",
    );
    await writeFile(
      join(worktreePath, "b", "added.ts"),
      "export const d = 4;\n",
    );

    const rendered = await renderFor(execution, "context-plan");

    // Exactly A's owned-path changes reach A's validators.
    expect(rendered.diffScopeSection).toContain("a/owned.ts");
    expect(rendered.diffScopeSection).toContain("a/added.ts");
    expect(rendered.diffScopeSection).not.toContain("b/sibling.ts");
    expect(rendered.diffScopeSection).not.toContain("b/added.ts");
    // The bytes shown came from the candidate the round froze.
    expect(rendered.candidateTreeHash).toBe(frozen.candidateTreeHash);

    // B keeps writing, then LANDS: HEAD moves under A's open round.
    await writeFile(
      join(worktreePath, "b", "sibling.ts"),
      "export const b = 3;\n",
    );
    await git("add", "b");
    await git("commit", "-m", "sibling lands");

    const reread = await observe(execution, "context-plan", OWNED_BY_A);
    expect(reread.headSha).not.toBe(frozen.headSha);
    expect(candidateIdentityMatches(frozen, reread)).toBe(true);
    expect(describeCandidateDrift(frozen, reread)).toBe("");

    // And the rendering is still the frozen one, after the sibling landed.
    const rerendered = await renderFor(execution, "context-plan");
    expect(rerendered.candidateTreeHash).toBe(frozen.candidateTreeHash);
    expect(rerendered.diffScopeSection).not.toContain("b/sibling.ts");
  });

  it("freezes and renders A's round while B is writing its own paths at that moment", async () => {
    const execution = executionWithPlacement("context-plan", OWNED_BY_A);
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );

    // B's turn is genuinely IN FLIGHT: files inside B's ownership appear, change,
    // and vanish while A's freeze and A's validator rendering read the worktree —
    // not merely before them, which any whole-tree read could also survive.
    let churning = true;
    const churn = (async () => {
      for (let round = 0; churning; round++) {
        const transient = join(worktreePath, "b", `churn-${round % 8}.ts`);
        await writeFile(transient, `export const t = ${round};\n`);
        await writeFile(
          join(worktreePath, "b", "sibling.ts"),
          `export const b = ${round};\n`,
        );
        await rm(transient, { force: true });
      }
    })();

    try {
      const frozen = await observe(execution, "context-plan", OWNED_BY_A);
      for (let turn = 0; turn < 6; turn++) {
        const rendered = await renderFor(execution, "context-plan");
        expect(rendered.candidateTreeHash).toBe(frozen.candidateTreeHash);
        expect(rendered.diffScopeSection).toContain("a/owned.ts");
        expect(rendered.diffScopeSection).not.toContain("sibling.ts");
        expect(rendered.diffScopeSection).not.toContain("churn-");

        const reread = await observe(execution, "context-plan", OWNED_BY_A);
        expect(candidateIdentityMatches(frozen, reread)).toBe(true);
      }
    } finally {
      churning = false;
      await churn;
    }
  });

  it("resolves A's candidate when B leaves a path git cannot index", async () => {
    const execution = executionWithPlacement("context-plan", OWNED_BY_A);
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );
    // Mid-turn state a sibling can legitimately produce in its own paths, and
    // that staging the whole shared worktree aborts on.
    const nested = join(worktreePath, "b", "nested");
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init", "-q"], {
      cwd: nested,
      env: buildChildEnv(),
    });
    await writeFile(join(nested, "x.ts"), "export const x = 1;\n");

    const frozen = await observe(execution, "context-plan", OWNED_BY_A);
    const rendered = await renderFor(execution, "context-plan");

    expect(rendered.candidateTreeHash).toBe(frozen.candidateTreeHash);
    expect(rendered.diffScopeSection).toContain("a/owned.ts");
    expect(rendered.diffScopeSection).not.toContain("nested");
    expect(
      candidateIdentityMatches(
        frozen,
        await observe(execution, "context-plan", OWNED_BY_A),
      ),
    ).toBe(true);
  });

  it("still calls a change inside A's own ownership drift", async () => {
    const execution = executionWithPlacement("context-plan", OWNED_BY_A);
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );
    const frozen = await observe(execution, "context-plan", OWNED_BY_A);

    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 3;\n",
    );

    const reread = await observe(execution, "context-plan", OWNED_BY_A);
    expect(candidateIdentityMatches(frozen, reread)).toBe(false);
    expect(describeCandidateDrift(frozen, reread)).toBe("candidateTreeHash");
  });

  it("gives B a diff of its own paths and nothing of A's", async () => {
    const execution = executionWithPlacement("context-implement", OWNED_BY_B);
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );
    await writeFile(
      join(worktreePath, "b", "sibling.ts"),
      "export const b = 2;\n",
    );

    const rendered = await renderFor(execution, "context-implement");

    expect(rendered.diffScopeSection).toContain("b/sibling.ts");
    expect(rendered.diffScopeSection).not.toContain("a/owned.ts");
  });

  it("keeps the whole-tree diff and HEAD-sensitive identity for a full-access member", async () => {
    const execution = executionWithPlacement("context-plan", FULL_ACCESS);
    await writeFile(
      join(worktreePath, "a", "owned.ts"),
      "export const a = 2;\n",
    );
    await writeFile(
      join(worktreePath, "b", "sibling.ts"),
      "export const b = 2;\n",
    );

    const frozen = await observe(execution, "context-plan", FULL_ACCESS);
    expect(frozen.identityScope).toBe("wholeTree");

    const rendered = await renderFor(execution, "context-plan");
    expect(rendered.diffScopeSection).toContain("a/owned.ts");
    expect(rendered.diffScopeSection).toContain("b/sibling.ts");
    expect(rendered.candidateTreeHash).toBe(frozen.candidateTreeHash);

    // A full-access member holds its lane alone, so the base commit moving IS a
    // move of the candidate it is reviewing.
    await git("add", "-A");
    await git("commit", "-m", "landed");
    const reread = await observe(execution, "context-plan", FULL_ACCESS);
    expect(candidateIdentityMatches(frozen, reread)).toBe(false);
    expect(describeCandidateDrift(frozen, reread)).toContain("headSha");
  });
});
