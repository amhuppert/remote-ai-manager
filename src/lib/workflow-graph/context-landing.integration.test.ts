import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { defaultGitClient } from "@/lib/git/client";
import { createSessionGitLock } from "@/lib/shared/lock-retry";
import { createGraphWorkflowManager } from "./workflow-manager";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import {
  createContextLanding,
  type ContextLandingInput,
} from "./context-landing";
import { createLaneCommitter } from "./lane-committer";
import { createSoloContextCommitter } from "./solo-context-committer";
import { createJoinRunner } from "./join-runner";
import { createPerSessionMergeMutex } from "./per-session-merge-mutex";
import { createLaneDriftAuditor } from "./lane-drift";
import { SESSION_LANE_ID } from "./lane-identity";
import type { GraphMergeRunner } from "./graph-merge-runner";
import { expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createPersistenceGraphRepository } from "./testing/persistence-repository-fixture";
import { createWorkflowExecution } from "./test-fixtures";
import { recordLandingIntent } from "./route-runtime";
import { settleContextLanding, type LandingOutcome } from "./context-landing";

const NOW = "2026-09-07T12:00:00.000Z";
const LATER = "2026-09-07T12:01:00.000Z";

it("persists landing evidence once across repeated settlement and a fresh reader", async () => {
  const fixture = createPersistenceFixture();
  try {
    fixture.seedProject("/repo");
    fixture.seedSession("/repo", "session-1");
    const execution = createWorkflowExecution({ status: "running" });
    const context = execution.contextStates["context-plan"];
    if (!context) throw new Error("Missing landing fixture context");
    context.status = "completed";
    context.completedTaskCount = 1;
    context.laneId = "delivery";
    execution.executionLanes.delivery = {
      laneId: "delivery",
      kind: "worktree",
      status: "active",
      worktreePath: "/repo/.worktrees/session-1.delivery",
      branchName: "csm/session-1-delivery",
      includedContextIds: [],
      lastCommittingContextId: null,
      commitSnapshots: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const intent = recordLandingIntent(execution, "context-plan", {
      mode: "lane_commit",
      laneId: "delivery",
      baselineSha: "baseline",
      now: NOW,
    });
    if (!intent) throw new Error("Missing landing fixture intent");
    await fixture.store.mutateActiveGraphWorkflowExecution(
      "/repo",
      "session-1",
      "fixture.seed",
      () => ({
        kind: "commit",
        execution,
        events: [],
        value: undefined,
      }),
    );
    const repository = createPersistenceGraphRepository(fixture);
    const outcome: LandingOutcome = {
      kind: "committed",
      executionId: execution.id,
      contextId: "context-plan",
      intentToken: intent.token,
      destination: { mode: "lane", laneId: "delivery" },
      snapshot: {
        contextId: "context-plan",
        sha: "landed-sha",
        committedAt: NOW,
      },
    };
    const first = await repository.mutateActive(
      "/repo",
      "session-1",
      (current) => settleContextLanding(current, outcome),
    );
    expect(first.kind).toBe("changed");
    const row = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
      "/repo",
      "session-1",
    );
    expect(row?.contextStates["context-plan"]?.landingIntent).toMatchObject({
      state: "landed",
      evidence: "commit",
      headSha: "landed-sha",
    });
    expect(row?.executionLanes.delivery?.commitSnapshots).toEqual([
      outcome.snapshot,
    ]);
    const events = fixture.db
      .prepare("SELECT * FROM graph_workflow_events")
      .all();
    expect(events.length).toBeGreaterThan(0);
    const repeated = await repository.mutateActive(
      "/repo",
      "session-1",
      (current) =>
        settleContextLanding(current, {
          ...outcome,
          snapshot: { ...outcome.snapshot, committedAt: LATER },
        }),
    );
    expect(repeated.kind).toBe("unchanged");
    const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
      "/repo",
      "session-1",
    );
    expect(reloaded).toEqual(row);
    expect(
      fixture.db.prepare("SELECT * FROM graph_workflow_events").all(),
    ).toEqual(events);
  } finally {
    fixture.close();
  }
});

it.each([
  "lane_committed",
  "solo_committed",
  "lane_adopted",
  "solo_adopted",
  "lane_no_changes",
  "solo_no_changes",
  "read_only",
  "missing_lane",
] as const)(
  "lands %s through the service with Git evidence and repeat-safe persistence",
  async (mode) => {
    const root = await mkdtemp(
      path.join(process.cwd(), ".cc/temp/context-landing-"),
    );
    const fixture = createPersistenceFixture();
    try {
      const git = async (...args: string[]) =>
        (await defaultGitClient.git(args, root)).stdout.trim();
      await git("init", "--initial-branch=lane-shared", ".");
      await git("config", "user.name", "Command Center");
      await git("config", "user.email", "engine@command-center.test");
      await writeFile(path.join(root, "work.txt"), "baseline\n");
      await git("add", "-A");
      await git("commit", "-m", "baseline");
      const baseline = await git("rev-parse", "HEAD");
      if (
        mode.endsWith("committed") ||
        mode.endsWith("adopted") ||
        mode === "read_only"
      ) {
        await writeFile(path.join(root, "work.txt"), "changed\n");
      }
      if (mode.endsWith("adopted")) {
        await git("add", "-A");
        await git("commit", "-m", "agent-authored work");
      }
      fixture.seedProject(root);
      fixture.seedSession(root, "session-1", {
        worktreePath: root,
        branchName: "lane-shared",
      });
      const execution = createWorkflowExecution({ status: "running" });
      const context = execution.contextStates["context-plan"];
      const definition = execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-plan",
      );
      if (!context || !definition) throw new Error("Missing landing context");
      const solo = mode.startsWith("solo");
      context.status = "completed";
      context.completedTaskCount = 1;
      context.isolation = solo ? "session" : "worktree";
      context.worktreePath = root;
      context.branchName = "lane-shared";
      context.laneId = solo ? null : "delivery";
      context.reservedOwnership = {
        mode: mode === "read_only" ? "readOnly" : "full",
        canonicalPrefixes: [],
      };
      if (mode === "read_only")
        definition.placement = { lane: "delivery", mode: "readOnly" };
      if (!solo)
        execution.executionLanes.delivery = {
          laneId: "delivery",
          kind: "worktree",
          status: "active",
          worktreePath: root,
          branchName: "lane-shared",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: NOW,
          updatedAt: NOW,
        };
      recordLandingIntent(execution, "context-plan", {
        mode: solo ? "solo_commit" : "lane_commit",
        laneId: context.laneId,
        worktreePath: root,
        baselineSha: baseline,
        now: NOW,
      });
      await fixture.store.mutateActiveGraphWorkflowExecution(
        root,
        "session-1",
        "fixture.seed",
        () => ({
          kind: "commit",
          execution,
          events: [],
          value: undefined,
        }),
      );
      const repository = createPersistenceGraphRepository(fixture);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        executionContract: createTestGraphExecutionContract(),
        getSession: fixture.store.getSession,
        loadDefinition: async () => null,
        abortConversation: () => {},
        abortExecutionLoop: () => {},
        retireLaneConversation: () => {},
        stopExecutionLaneDevServers: async () => {},
      });
      const mergeMutex = createPerSessionMergeMutex();
      const sessionGitLock = createSessionGitLock({
        acquireSessionLock: () => () => {},
      });
      const mergeRunner: GraphMergeRunner = {
        run: async () => {
          throw new Error("Commit modes cannot dispatch a merge");
        },
      };
      const service = createContextLanding({
        executionRepository: repository,
        recordPendingHaltReason: manager.recordPendingHaltReason,
        getSession: fixture.store.getSession,
        mergeMutex,
        sessionGitLock,
        laneCommitter: createLaneCommitter(),
        soloContextCommitter: createSoloContextCommitter(),
        joinRunner: createJoinRunner({
          mergeRunner,
          mergeMutex,
          sessionGitLock,
        }),
        laneDriftAuditor: createLaneDriftAuditor(),
      });
      const input: ContextLandingInput = {
        projectPath: root,
        projectName: "landing",
        sessionName: "session-1",
        executionId: execution.id,
        contextId: "context-plan",
        preTurnHeadSha: baseline,
        target: solo
          ? { isolation: "session" }
          : {
              isolation: "worktree",
              worktreePath: root,
              branchName: "lane-shared",
              laneId: mode === "missing_lane" ? null : "delivery",
            },
      };
      if (mode === "missing_lane") {
        await expect(service.land(input)).rejects.toThrow(
          /worktree.*assigned lane/i,
        );
        expect(await git("rev-parse", "HEAD")).toBe(baseline);
        return;
      }
      const first = await service.land(input);
      const expectedKind =
        mode === "read_only"
          ? "read_only"
          : mode.endsWith("no_changes")
            ? "no_changes"
            : mode.endsWith("adopted")
              ? "adopted"
              : "committed";
      expect(first.outcome.kind).toBe(expectedKind);
      const head = await git("rev-parse", "HEAD");
      const read = () =>
        createGraphWorkflowExecutionsRepo(fixture.db).getActive(
          root,
          "session-1",
        );
      const row = read();
      const events = fixture.db
        .prepare("SELECT * FROM graph_workflow_events")
        .all();
      if (mode === "read_only") {
        expect(head).toBe(baseline);
        expect(await git("status", "--porcelain")).toContain("work.txt");
        expect(events).toEqual([]);
      } else {
        expect(row?.contextStates["context-plan"]?.landingIntent?.state).toBe(
          "landed",
        );
        if (expectedKind === "committed" || expectedKind === "adopted") {
          const laneId = solo ? SESSION_LANE_ID : "delivery";
          expect(row?.executionLanes[laneId]?.commitSnapshots).toHaveLength(1);
          const recordedSha =
            row?.executionLanes[laneId]?.commitSnapshots[0]?.sha;
          if (!recordedSha) throw new Error("Missing recorded commit SHA");
          expect(await git("rev-parse", recordedSha)).toBe(head);
          const message = await git("log", "-1", "--format=%B");
          if (expectedKind === "committed")
            expect(message).toContain("Landing-Intent:");
          else expect(message).not.toContain("Landing-Intent:");
        }
      }
      if (expectedKind === "committed" || expectedKind === "adopted") {
        await writeFile(
          path.join(root, "followup.txt"),
          "work outside the completed context\n",
        );
      }
      await service.land(input);
      expect(await git("rev-parse", "HEAD")).toBe(head);
      if (expectedKind === "committed" || expectedKind === "adopted")
        expect(await git("status", "--porcelain")).toContain("followup.txt");
      expect(read()).toEqual(row);
      expect(
        fixture.db.prepare("SELECT * FROM graph_workflow_events").all(),
      ).toEqual(events);
    } finally {
      fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
