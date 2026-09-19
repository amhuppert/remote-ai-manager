import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChildEnv } from "@/lib/shared/child-env";
import { computeCandidateTreeHash } from "@/lib/git/diff";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { resetContextStateToInitial } from "./context-transitions";
import {
  captureContextReviewOrigin,
  resolveContextReviewOrigin,
} from "./review-origin";
import { graphWorkflowExecutionSchema } from "./schemas";
import {
  createWorkflowExecution,
  makeValidatorAssignment,
  seedAssignment,
  makeStubValidatorContinuityService,
} from "./test-fixtures";
import { createValidatorRunner } from "./validator-runner";
import { resolveApprovalSnapshot } from "./approval-snapshot";
import { recordLandingIntent } from "./route-runtime";

const execFileAsync = promisify(execFile);
const CONTEXT = "context-implement";
const NOW = "2026-09-15T12:00:00.000Z";

describe("retained-work review origin", () => {
  let repo: string;
  let baselineSha: string;
  async function git(...args: string[]): Promise<string> {
    return (
      await execFileAsync("git", args, { cwd: repo, env: buildChildEnv() })
    ).stdout.trim();
  }
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "cc-review-origin-"));
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await writeFile(join(repo, "owned.ts"), "export const before = 1;\n");
    await writeFile(join(repo, "sibling.ts"), "export const sibling = 1;\n");
    await git("add", "-A");
    await git("commit", "--no-verify", "-m", "baseline");
    baselineSha = await git("rev-parse", "HEAD");
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it.each(["wholeTree", "owned"] as const)(
    "retains %s evidence through self-commit, reset and schema reload for both review surfaces",
    async (mode) => {
      let execution = createWorkflowExecution({ status: "running" });
      const definition = execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === CONTEXT,
      )!;
      definition.placement =
        mode === "owned"
          ? { lane: "impl", mode: "owned", ownedPaths: ["owned.ts"] }
          : { lane: "impl", mode: "full" };
      definition.contextValidator = {
        enabled: true,
        assignments: [seedAssignment(makeValidatorAssignment())],
      };
      const state = execution.contextStates[CONTEXT]!;
      state.laneId = "impl";
      state.worktreePath = repo;
      state.status = "running";
      expect(
        captureContextReviewOrigin(execution, CONTEXT, baselineSha, NOW),
      ).toBe(true);
      const origin = structuredClone(state.reviewOrigin);
      const firstIntent = recordLandingIntent(execution, CONTEXT, {
        mode: "lane_commit",
        laneId: "impl",
        now: NOW,
      });
      await writeFile(
        join(repo, "owned.ts"),
        "export const retainedSelfCommit = 2;\n",
      );
      await git("add", "owned.ts");
      await git("commit", "--no-verify", "-m", "self-authored work");
      execution.status = "paused";
      execution.contextStates = resetContextStateToInitial(execution, CONTEXT, {
        reason: "test retained-code reset",
      });
      expect(execution.contextStates[CONTEXT]!.reviewOrigin).toEqual(origin);
      execution = graphWorkflowExecutionSchema.parse(
        JSON.parse(JSON.stringify(execution)),
      );
      const resumed = execution.contextStates[CONTEXT]!;
      resumed.status = "running";
      resumed.laneId = "impl";
      resumed.worktreePath = repo;
      expect(
        captureContextReviewOrigin(
          execution,
          CONTEXT,
          await git("rev-parse", "HEAD"),
          NOW,
        ),
      ).toBe(false);
      const secondIntent = recordLandingIntent(execution, CONTEXT, {
        mode: "lane_commit",
        laneId: "impl",
        now: NOW,
      });
      expect(secondIntent.token).not.toBe(firstIntent.token);
      await writeFile(
        join(repo, "owned.ts"),
        "export const retainedSelfCommit = 2;\nexport const retry = 3;\n",
      );
      await writeFile(
        join(repo, "sibling.ts"),
        "export const unrelatedSibling = 4;\n",
      );

      const runner = createValidatorRunner({
        continuityService: makeStubValidatorContinuityService(),
        executionContract: createTestGraphExecutionContract(),
        resolveWorktreePath: async () => repo,
        resolveTimeoutMs: async () => 30_000,
        getProjectDisplayName: () => "test",
      });
      const rendered = await runner.renderRoundCommonSections({
        projectPath: repo,
        sessionName: "session",
        execution,
        context: execution.workingDefinition.executionContexts.find(
          (entry) => entry.id === CONTEXT,
        )!,
      });
      expect(rendered.diffScopeSection).toContain(
        "+export const retainedSelfCommit = 2;",
      );
      expect(rendered.diffScopeSection).toContain("+export const retry = 3;");
      if (mode === "owned")
        expect(rendered.diffScopeSection).not.toContain("unrelatedSibling");
      const scope = resumed.reviewOrigin!.candidateScope;
      const treeHash = (await computeCandidateTreeHash(repo, scope))!;
      expect(rendered.candidateTreeHash).toBe(treeHash);
      resumed.status = "awaiting_approval";
      resumed.pendingApproval = {
        conversationId: "reviewer",
        requestedAt: NOW,
        decision: null,
        approvalScope:
          scope.mode === "owned"
            ? {
                kind: "scoped",
                ownedPaths: [...scope.ownedPaths],
                treeHash,
                headSha: await git("rev-parse", "HEAD"),
              }
            : {
                kind: "whole_tree",
                treeHash,
                headSha: await git("rev-parse", "HEAD"),
              },
      };
      const approval = await resolveApprovalSnapshot({
        execution,
        contextId: CONTEXT,
        sessionWorktreePath: repo,
      });
      expect(approval.kind).toBe(mode === "owned" ? "scoped" : "whole_tree");
      if (approval.kind !== "scoped" && approval.kind !== "whole_tree")
        throw new Error("expected snapshot");
      expect(approval.snapshot.treeHash).toBe(treeHash);
      const patch = JSON.stringify(approval.snapshot.diff);
      expect(patch).toContain("retainedSelfCommit");
      expect(patch).toContain("retry");
      if (mode === "owned") expect(patch).not.toContain("unrelatedSibling");
      await writeFile(join(repo, "owned.ts"), "candidate drift\n");
      expect(
        (
          await resolveApprovalSnapshot({
            execution,
            contextId: CONTEXT,
            sessionWorktreePath: repo,
          })
        ).kind,
      ).toBe("drifted");
    },
  );

  it("does not invent a baseline for already-started work or reuse an origin on a different lane", () => {
    const execution = createWorkflowExecution();
    const state = execution.contextStates[CONTEXT]!;
    state.iterationCount = 1;
    expect(
      captureContextReviewOrigin(execution, CONTEXT, baselineSha, NOW),
    ).toBe(false);
    expect(resolveContextReviewOrigin(execution, CONTEXT).kind).toBe(
      "unavailable",
    );
    execution.contextStates = resetContextStateToInitial(execution, CONTEXT, {
      reason: "reset unknown retained work",
    });
    expect(execution.contextStates[CONTEXT]!.reviewOrigin).toBeNull();
    expect(
      captureContextReviewOrigin(execution, CONTEXT, baselineSha, NOW),
    ).toBe(false);
    execution.contextStates[CONTEXT] = state;
    state.iterationCount = 0;
    captureContextReviewOrigin(execution, CONTEXT, baselineSha, NOW);
    state.laneId = "replacement";
    expect(resolveContextReviewOrigin(execution, CONTEXT).kind).toBe(
      "unavailable",
    );
  });
});
