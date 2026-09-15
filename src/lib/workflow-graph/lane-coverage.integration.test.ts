import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultGitClient } from "@/lib/git/client";
import { prepareSquashMerge, publishPreparedMerge } from "@/lib/git/worktree";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createWorkflowExecution } from "./test-fixtures";
import { applyJoinProgress } from "./context-transitions";
import { isUpstreamVisibleToLane } from "./lane-readiness";
import {
  planContextJoin,
  planFinalPublishJoin,
  remainingSourceLanes,
  unpublishedContributions,
} from "./lane-join";
import { SESSION_LANE_ID } from "./lane-identity";
import type { GraphWorkflowExecutionJoinState } from "./schemas";

it("publishes actual files from three reciprocal stages and reloads confirmed coverage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cc-coverage-"));
  const fixture = createPersistenceFixture();
  const git = async (cwd: string, args: string[]) =>
    (await defaultGitClient.git(args, cwd)).stdout.trim();
  const now = () => "2026-09-15T12:00:00.000Z";
  try {
    await git(root, ["init", "--initial-branch=session"]);
    await git(root, ["config", "user.name", "CC test"]);
    await git(root, ["config", "user.email", "cc@example.test"]);
    await writeFile(path.join(root, "base.txt"), "base");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    let execution = createWorkflowExecution({ status: "running" });
    for (const context of execution.workingDefinition.executionContexts) {
      context.placement = {
        lane: context.id === "context-implement" ? "judge" : "worker",
        mode: "full",
      };
    }
    for (const laneId of ["worker", "judge", SESSION_LANE_ID]) {
      const directory =
        laneId === SESSION_LANE_ID ? root : path.join(root, laneId);
      const branchName = laneId === SESSION_LANE_ID ? "session" : laneId;
      if (laneId !== SESSION_LANE_ID)
        await git(root, [
          "worktree",
          "add",
          "-b",
          branchName,
          directory,
          "session",
        ]);
      execution.executionLanes[laneId] = {
        laneId,
        kind: laneId === SESSION_LANE_ID ? "session" : "worktree",
        status: "active",
        branchName,
        worktreePath: directory,
        includedContextIds: [],
        lastCommittingContextId: null,
        commitSnapshots: [],
        createdAt: now(),
        updatedAt: now(),
      };
    }
    fixture.seedProject(root);
    fixture.seedSession(root, "coverage");
    const persist = () =>
      fixture.graphWorkflowExecutions.setActive(
        root,
        "coverage",
        execution,
        now(),
      );
    let sequence = 0;
    const merge = async (join: GraphWorkflowExecutionJoinState) => {
      execution.joins[join.joinId] = join;
      const target = execution.executionLanes[join.targetLaneId]!;
      for (const sourceId of remainingSourceLanes(join)) {
        const source = execution.executionLanes[sourceId]!;
        const result = await prepareSquashMerge({
          projectPath: root,
          featureBranch: source.branchName,
          featureSha: await git(root, ["rev-parse", source.branchName]),
          targetBranch: target.branchName,
          targetSha: await git(root, ["rev-parse", target.branchName]),
          message: join.joinId,
          jobId: `join-${++sequence}`,
          forcePath: "plumbing",
        });
        expect(result.kind).not.toBe("conflicts");
        if (result.kind === "prepared") {
          const published = await publishPreparedMerge({
            projectPath: root,
            targetBranch: target.branchName,
            ...result,
            cleanTargetWorktreePath: target.worktreePath,
          });
          expect(published.kind).toBe("published");
        }
        execution = applyJoinProgress(execution, join.joinId, now(), {
          addMergedSourceLaneId: sourceId,
        });
        persist();
      }
      execution = applyJoinProgress(execution, join.joinId, now(), {
        status: "succeeded",
      });
      persist();
    };
    const contextIds = ["context-plan", "context-implement", "context-verify"];
    for (const [index, contextId] of contextIds.entries()) {
      const laneId = contextId === "context-implement" ? "judge" : "worker";
      const lane = execution.executionLanes[laneId]!;
      const state = execution.contextStates[contextId]!;
      const directory = lane.worktreePath!;
      await writeFile(
        path.join(directory, `${contextId}.txt`),
        `${contextId}\n`,
      );
      await git(directory, ["add", `${contextId}.txt`]);
      await git(directory, ["commit", "-m", contextId]);
      state.status = "completed";
      state.completedTaskCount = state.totalTaskCount;
      state.laneId = laneId;
      state.isolation = "worktree";
      lane.includedContextIds.push(contextId);
      persist();
      const nextContextId = contextIds[index + 1];
      if (nextContextId) {
        const targetLaneId =
          nextContextId === "context-implement" ? "judge" : "worker";
        expect(
          isUpstreamVisibleToLane(contextId, targetLaneId, execution),
        ).toBe(false);
        const planned = planContextJoin({
          execution,
          contextId: nextContextId,
          now,
          generateJoinId: () => `context-${index}`,
        });
        expect(planned).not.toBeNull();
        await merge(planned!);
        expect(
          isUpstreamVisibleToLane(contextId, targetLaneId, execution),
        ).toBe(true);
      }
    }
    expect(unpublishedContributions(execution)).toHaveLength(3);
    const final = planFinalPublishJoin({
      execution,
      sessionLaneId: SESSION_LANE_ID,
      now,
      generateJoinId: () => "final",
    });
    expect(final?.sourceLaneIds).toEqual(["worker"]);
    await merge(final!);
    const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
      root,
      "coverage",
    );
    expect(reloaded).not.toBeNull();
    expect(unpublishedContributions(reloaded!)).toEqual([]);
    expect(
      reloaded!.executionLanes[SESSION_LANE_ID]!.includedContextIds.sort(),
    ).toEqual([...contextIds].sort());
    for (const contextId of contextIds)
      expect(await readFile(path.join(root, `${contextId}.txt`), "utf8")).toBe(
        `${contextId}\n`,
      );
  } finally {
    fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
