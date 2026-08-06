import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import type {
  SpawnValidationParams,
  ValidationProcessHandle,
  ValidationRunOutcome,
} from "./process-runner";
import type { ValidationProcessIdentity } from "./recovery";
import { createValidationScheduler } from "./scheduler";
import { repoValidationConfigSchema } from "./schemas";
import {
  createValidationService,
  type ResolvedValidationCaller,
} from "./service";

interface ControllableRun {
  params: SpawnValidationParams;
  startConfirmed: boolean;
  complete(outcome: ValidationRunOutcome): void;
}

function createControllableRunner(onStart: () => void) {
  const spawns: SpawnValidationParams[] = [];
  const starts: string[] = [];
  const runs = new Map<string, ControllableRun>();
  const startWaiters: Array<{ count: number; resolve(): void }> = [];
  let nextPid = 7_000;

  function settleStartWaiters(): void {
    for (let index = startWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = startWaiters[index]!;
      if (starts.length < waiter.count) continue;
      startWaiters.splice(index, 1);
      waiter.resolve();
    }
  }

  return {
    spawns,
    starts,
    runs,
    whenStarted(count: number): Promise<void> {
      if (starts.length >= count) return Promise.resolve();
      return new Promise((resolve) => {
        startWaiters.push({ count, resolve });
      });
    },
    async spawn(params: SpawnValidationParams) {
      spawns.push(params);
      let settle!: (outcome: ValidationRunOutcome) => void;
      let settled = false;
      const outcome = new Promise<ValidationRunOutcome>((resolve) => {
        settle = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
      });
      const run: ControllableRun = {
        params,
        startConfirmed: false,
        complete(value) {
          if (!run.startConfirmed) {
            throw new Error(
              `run ${params.runId} completed before its start was confirmed`,
            );
          }
          settle(value);
        },
      };
      const handle: ValidationProcessHandle = {
        processGroupPid: nextPid++,
        confirmStart() {
          run.startConfirmed = true;
          starts.push(params.runId);
          onStart();
          settleStartWaiters();
        },
        wait: () => outcome,
        cancel: () => {
          settle({ kind: "cancelled", output: "" });
          return outcome;
        },
      };
      runs.set(params.runId, run);
      return { kind: "spawned" as const, handle };
    },
  };
}

describe("ValidationService shared global budget", () => {
  it("enforces limit 4 across CLI, graph, merge, and restart paths", async () => {
    const fixture = createPersistenceFixture();
    try {
      const repo = createValidationRunsRepo(fixture.db);
      const transact = <T>(_label: string, fn: () => T): T =>
        fixture.db.transaction(fn)();
      let nowMs = Date.parse("2026-08-05T12:00:00.000Z");
      const now = () => new Date(nowMs);
      const scheduler = createValidationScheduler({ repo, transact, now });
      const activeCostSnapshots: number[] = [];
      const runner = createControllableRunner(() => {
        activeCostSnapshots.push(scheduler.snapshot().inUse);
      });
      const repoValidation = repoValidationConfigSchema.parse({
        commands: {
          heavy: { command: "scripts/validate/heavy.sh", cost: 3 },
          format: { command: "scripts/validate/format.sh", cost: 1 },
          oversized: { command: "scripts/validate/oversized.sh", cost: 5 },
        },
        preMerge: ["heavy"],
      });
      const identity: ValidationProcessIdentity = {
        classifyGroup: async () => "not_ours",
        killGroup: async () => {},
      };
      const sessionCaller: ResolvedValidationCaller = {
        kind: "session",
        worktreePath: "/projects/app/.worktrees/session-1",
        sessionName: "session-1",
        branchName: "csm/session-1",
        targetBranch: "main",
      };
      const otherSessionCaller: ResolvedValidationCaller = {
        kind: "session",
        worktreePath: "/projects/other/.worktrees/session-2",
        sessionName: "session-2",
        branchName: "csm/session-2",
        targetBranch: "main",
      };
      const disabledLaneCaller: ResolvedValidationCaller = {
        kind: "graph_lane",
        worktreePath: "/projects/app/.worktrees/session-1.lane-api",
        sessionName: "session-1",
        branchName: "csm/session-1-lane-api",
        targetBranch: "csm/session-1",
        executionId: "execution-1",
        contextId: "api",
        role: "implementer",
        allowedCommands: [],
        scriptGateCommands: ["format"],
      };
      let id = 0;
      const service = createValidationService({
        repo,
        transact,
        scheduler,
        runner: { spawn: (params) => runner.spawn(params) },
        resolver: {
          resolveCaller: async (ref) =>
            ref.conversationId === "conv-disabled"
              ? disabledLaneCaller
              : ref.projectPath === "/projects/other"
                ? otherSessionCaller
                : sessionCaller,
        },
        config: {
          readRepoValidation: async () => repoValidation,
          readGlobal: async () => ({
            concurrencyLimit: 4,
            defaultTimeoutMs: 600_000,
          }),
        },
        identity,
        publish: () => ({ delivered: true }),
        now,
        ids: {
          runId: () => `shared-run-${++id}`,
          nonce: () => `shared-nonce-${id}`,
        },
      });

      const disabled = await service.submit({
        source: "agent_cli",
        commandName: "format",
        caller: {
          projectPath: "/projects/app",
          sessionName: "session-1",
          conversationId: "conv-disabled",
        },
      });
      expect(disabled).toMatchObject({
        kind: "not_started",
        result: { kind: "skipped_by_policy" },
      });
      if (
        disabled.kind === "not_started" &&
        disabled.result.kind === "skipped_by_policy"
      ) {
        expect(disabled.result.message).toContain(
          "handled by the script validator",
        );
      }
      expect(runner.spawns).toHaveLength(0);
      expect(createValidationRunsRepo(fixture.db).findStaleActive()).toEqual(
        [],
      );

      const oversizedFailFast = await service.submit({
        source: "agent_cli",
        commandName: "oversized",
        wait: false,
        caller: {
          projectPath: "/projects/app",
          sessionName: "session-1",
          conversationId: "conv-cli",
        },
      });
      expect(oversizedFailFast).toMatchObject({
        kind: "not_started",
        result: {
          kind: "cost_exceeds_limit",
          name: "oversized",
          cost: 5,
          limit: 4,
        },
      });
      const oversizedWait = await service.submit({
        source: "agent_cli",
        commandName: "oversized",
        wait: true,
        caller: {
          projectPath: "/projects/app",
          sessionName: "session-1",
          conversationId: "conv-cli",
        },
      });
      expect(oversizedWait).toMatchObject({
        kind: "not_started",
        result: {
          kind: "cost_exceeds_limit",
          name: "oversized",
          cost: 5,
          limit: 4,
        },
      });
      expect(runner.spawns).toHaveLength(0);
      expect(createValidationRunsRepo(fixture.db).findStaleActive()).toEqual(
        [],
      );

      const cli = await service.submit({
        source: "agent_cli",
        commandName: "heavy",
        caller: {
          projectPath: "/projects/app",
          sessionName: "session-1",
          conversationId: "conv-cli",
        },
      });
      expect(cli).toMatchObject({
        kind: "accepted",
        status: "running",
      });
      if (cli.kind !== "accepted") return;
      const cliDone = service.waitForCompletion(cli.runId);

      const busyFailFast = await service.submit({
        source: "agent_cli",
        commandName: "heavy",
        wait: false,
        caller: {
          projectPath: "/projects/other",
          sessionName: "session-2",
          conversationId: "conv-other",
        },
      });
      expect(busyFailFast).toMatchObject({
        kind: "not_started",
        result: {
          kind: "capacity_unavailable",
          cost: 3,
          inUse: 3,
          limit: 4,
          queueDepth: 0,
          blockedByOlderWaiter: false,
        },
      });
      expect(runner.spawns).toHaveLength(1);

      const waitingCli = await service.submit({
        source: "agent_cli",
        commandName: "heavy",
        wait: true,
        caller: {
          projectPath: "/projects/other",
          sessionName: "session-2",
          conversationId: "conv-other",
        },
      });
      expect(waitingCli).toMatchObject({
        kind: "accepted",
        status: "queued",
        position: 0,
      });
      if (waitingCli.kind !== "accepted") return;
      const waitingCliDone = service.waitForCompletion(waitingCli.runId);

      const graphGate = await service.submitSystem({
        source: "graph_script_validator",
        command: { kind: "registered", name: "heavy" },
        projectPath: "/projects/app",
        workflow: { executionId: "execution-1", contextId: "api" },
        target: {
          worktreePath: "/projects/app/.worktrees/session-1.lane-api",
          sessionName: "session-1",
          branchName: "csm/session-1-lane-api",
          targetBranch: "csm/session-1",
          contextId: "api",
        },
      });
      expect(graphGate).toMatchObject({
        kind: "accepted",
        status: "queued",
        position: 1,
      });
      if (graphGate.kind !== "accepted") return;
      const graphGateDone = service.waitForCompletion(graphGate.runId);

      const merge = await service.submitSystem({
        source: "smart_merge",
        command: { kind: "registered", name: "format" },
        projectPath: "/projects/app",
        target: {
          worktreePath: "/projects/app/.worktrees/session-1",
          sessionName: "session-1",
          branchName: "csm/session-1",
          targetBranch: "main",
        },
      });
      expect(merge).toMatchObject({
        kind: "accepted",
        status: "queued",
        position: 2,
      });
      if (merge.kind !== "accepted") return;
      const mergeDone = service.waitForCompletion(merge.runId);

      activeCostSnapshots.push(scheduler.snapshot().inUse);
      expect(scheduler.snapshot()).toEqual({ inUse: 3, queueDepth: 3 });
      expect(runner.starts).toEqual([cli.runId]);
      expect(
        createValidationRunsRepo(fixture.db)
          .findStaleActive()
          .map(({ runId, source, cost, status }) => ({
            runId,
            source,
            cost,
            status,
          })),
      ).toEqual([
        {
          runId: cli.runId,
          source: "agent_cli",
          cost: 3,
          status: "running",
        },
        {
          runId: waitingCli.runId,
          source: "agent_cli",
          cost: 3,
          status: "queued",
        },
        {
          runId: graphGate.runId,
          source: "graph_script_validator",
          cost: 3,
          status: "queued",
        },
        {
          runId: merge.runId,
          source: "smart_merge",
          cost: 1,
          status: "queued",
        },
      ]);

      const waitingCliStart = runner.whenStarted(2);
      nowMs += 1_000;
      runner.runs.get(cli.runId)?.complete({
        kind: "exited",
        exitCode: 0,
        output: "cli passed",
      });
      await expect(cliDone).resolves.toMatchObject({ kind: "passed" });
      await waitingCliStart;

      expect(runner.starts).toEqual([cli.runId, waitingCli.runId]);
      expect(scheduler.snapshot()).toEqual({ inUse: 3, queueDepth: 2 });

      const queuedStarts = runner.whenStarted(4);
      nowMs += 1_000;
      runner.runs.get(waitingCli.runId)?.complete({
        kind: "exited",
        exitCode: 0,
        output: "waiting CLI passed",
      });
      await expect(waitingCliDone).resolves.toMatchObject({ kind: "passed" });
      await queuedStarts;

      expect(runner.starts).toEqual([
        cli.runId,
        waitingCli.runId,
        graphGate.runId,
        merge.runId,
      ]);
      expect(scheduler.snapshot()).toEqual({ inUse: 4, queueDepth: 0 });

      nowMs += 2_000;
      runner.runs.get(graphGate.runId)?.complete({
        kind: "exited",
        exitCode: 0,
        output: "graph gate passed",
      });
      runner.runs.get(merge.runId)?.complete({
        kind: "exited",
        exitCode: 0,
        output: "merge passed",
      });
      await expect(graphGateDone).resolves.toMatchObject({ kind: "passed" });
      await expect(mergeDone).resolves.toMatchObject({ kind: "passed" });
      activeCostSnapshots.push(scheduler.snapshot().inUse);

      expect(Math.max(...activeCostSnapshots)).toBeLessThanOrEqual(4);
      expect(scheduler.snapshot()).toEqual({ inUse: 0, queueDepth: 0 });
      const reloadedRepo = createValidationRunsRepo(fixture.db);
      expect(reloadedRepo.findById(cli.runId)).toMatchObject({
        status: "passed",
        execMs: 1_000,
      });
      expect(reloadedRepo.findById(graphGate.runId)).toMatchObject({
        source: "graph_script_validator",
        status: "passed",
        queueMs: 2_000,
        execMs: 2_000,
      });
      expect(reloadedRepo.findById(merge.runId)).toMatchObject({
        source: "smart_merge",
        status: "passed",
        queueMs: 2_000,
        execMs: 2_000,
      });

      const stale = await service.submit({
        source: "agent_cli",
        commandName: "heavy",
        caller: {
          projectPath: "/projects/app",
          sessionName: "session-1",
          conversationId: "conv-restart",
        },
      });
      expect(stale).toMatchObject({ kind: "accepted", status: "running" });
      if (stale.kind !== "accepted") return;
      // Leave the confirmed run unresolved: the fresh service below represents
      // a server process that lost every in-memory handle during a crash.
      const stalePid = createValidationRunsRepo(fixture.db).findById(
        stale.runId,
      )?.processGroupPid;
      expect(stalePid).toEqual(expect.any(Number));

      const restartRepo = createValidationRunsRepo(fixture.db);
      const restartScheduler = createValidationScheduler({
        repo: restartRepo,
        transact,
        now,
      });
      const restartRunner = createControllableRunner(() => {
        activeCostSnapshots.push(restartScheduler.snapshot().inUse);
      });
      const killedProcessGroups: number[] = [];
      let announceKill!: () => void;
      const killEntered = new Promise<void>((resolve) => {
        announceKill = resolve;
      });
      let releaseKill!: () => void;
      const killReleased = new Promise<void>((resolve) => {
        releaseKill = resolve;
      });
      let restartId = 0;
      const restartedService = createValidationService({
        repo: restartRepo,
        transact,
        scheduler: restartScheduler,
        runner: { spawn: (params) => restartRunner.spawn(params) },
        resolver: { resolveCaller: async () => sessionCaller },
        config: {
          readRepoValidation: async () => repoValidation,
          readGlobal: async () => ({
            concurrencyLimit: 4,
            defaultTimeoutMs: 600_000,
          }),
        },
        identity: {
          classifyGroup: async (processGroupPid) =>
            processGroupPid === stalePid ? "owned" : "not_ours",
          killGroup: async (processGroupPid) => {
            killedProcessGroups.push(processGroupPid);
            announceKill();
            await killReleased;
          },
        },
        publish: () => ({ delivered: true }),
        now,
        ids: {
          runId: () => `restart-run-${++restartId}`,
          nonce: () => `restart-nonce-${restartId}`,
        },
      });

      let restartSubmissionDecided = false;
      const restartSubmissionPromise = restartedService
        .submit({
          source: "agent_cli",
          commandName: "heavy",
          caller: {
            projectPath: "/projects/app",
            sessionName: "session-1",
            conversationId: "conv-after-restart",
          },
        })
        .then((submission) => {
          restartSubmissionDecided = true;
          return submission;
        });
      await killEntered;
      expect(restartSubmissionDecided).toBe(false);
      expect(restartRunner.spawns).toHaveLength(0);
      expect(
        createValidationRunsRepo(fixture.db).findById(stale.runId)?.status,
      ).toBe("running");

      releaseKill();
      const afterRestart = await restartSubmissionPromise;
      expect(afterRestart).toMatchObject({
        kind: "accepted",
        status: "running",
      });
      expect(killedProcessGroups).toEqual([stalePid]);
      const recoveredRepo = createValidationRunsRepo(fixture.db);
      expect(recoveredRepo.findById(stale.runId)).toMatchObject({
        status: "interrupted",
        execMs: expect.any(Number),
      });
      if (afterRestart.kind !== "accepted") return;
      const afterRestartDone = restartedService.waitForCompletion(
        afterRestart.runId,
      );
      restartRunner.runs.get(afterRestart.runId)?.complete({
        kind: "exited",
        exitCode: 0,
        output: "post-restart passed",
      });
      await expect(afterRestartDone).resolves.toMatchObject({ kind: "passed" });
      expect(Math.max(...activeCostSnapshots)).toBeLessThanOrEqual(4);
    } finally {
      fixture.close();
    }
  });
});
