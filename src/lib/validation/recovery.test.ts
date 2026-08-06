import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createValidationRunsRepo,
  type ValidationRunsRepo,
} from "@/lib/state-store/validation-runs-repo";
import type { ValidationRunRecord } from "./schemas";
import { spawnValidation } from "./process-runner";
import {
  createProcessGroupIdentity,
  createValidationAdmissionGate,
  reconcileValidationLedger,
  UnverifiableValidationGroupError,
} from "./recovery";

let fixture: PersistenceFixture;
let repo: ValidationRunsRepo;

beforeEach(() => {
  fixture = createPersistenceFixture();
  repo = createValidationRunsRepo(fixture.db);
});

afterEach(() => {
  fixture.close();
});

function record(
  overrides: Partial<ValidationRunRecord> & { runId: string },
): ValidationRunRecord {
  return {
    source: "agent_cli",
    commandName: "test",
    cost: 2,
    queueOrder: repo.nextQueueOrder(),
    status: "queued",
    nonce: `nonce-${overrides.runId}`,
    leaseToken: null,
    leaseExpiresAt: null,
    processGroupPid: null,
    projectPath: "/projects/app",
    worktreePath: "/projects/app/.worktrees/s1",
    sessionName: "s1",
    conversationId: null,
    workflowExecutionId: null,
    workflowContextId: null,
    workflowRole: null,
    submittedAt: "2026-08-05T09:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    queueMs: null,
    execMs: null,
    scoped: false,
    scopedPathCount: 0,
    exitCode: null,
    timedOut: false,
    ...overrides,
  };
}

function seedRunning(runId: string, processGroupPid: number): void {
  repo.submit(record({ runId }));
  repo.admit(runId);
  repo.markStarted(runId, {
    startedAt: "2026-08-05T09:00:01.000Z",
    queueMs: 1_000,
    processGroupPid,
  });
}

describe("reconcileValidationLedger", () => {
  it("kills only nonce-verified owned groups, marks every stale row interrupted, and survives a repo reload", async () => {
    seedRunning("run-owned", 111);
    seedRunning("run-dead", 222);
    seedRunning("run-recycled-pid", 333);
    repo.submit(record({ runId: "run-queued" }));
    // Admitted but never markStarted: the crash hit between spawn and pid
    // persistence. The runner's start barrier guarantees such a group never
    // released its workload and self-aborts on the closed pipe, so settling
    // the row with nothing to kill is sound — and there is no pid to probe.
    repo.submit(record({ runId: "run-preconfirm" }));
    repo.admit("run-preconfirm");
    // A finished run must be untouched by recovery.
    seedRunning("run-finished", 444);
    repo.markPassed("run-finished", {
      finishedAt: "2026-08-05T09:05:00.000Z",
      execMs: 1_000,
      exitCode: 0,
    });

    const killed: number[] = [];
    const probedPids: number[] = [];
    const result = await reconcileValidationLedger({
      repo,
      transact: (_label, fn) => fixture.db.transaction(fn)(),
      identity: {
        // Only pgid 111 is a live group whose leader carries the row's nonce;
        // 222 is dead and 333 is a recycled pid owned by someone else.
        classifyGroup: async (pgid) => {
          probedPids.push(pgid);
          return pgid === 111 ? "owned" : "not_ours";
        },
        killGroup: async (pgid) => {
          killed.push(pgid);
        },
      },
    });

    expect(killed).toEqual([111]);
    // The pid-less running row is settled without any identity probe.
    expect(probedPids.sort()).toEqual([111, 222, 333]);
    expect([...result.interruptedRunIds].sort()).toEqual([
      "run-dead",
      "run-owned",
      "run-preconfirm",
      "run-queued",
      "run-recycled-pid",
    ]);
    expect(result.killedProcessGroups).toEqual([111]);

    // Reload through a fresh repository over the same database: the verdicts
    // are durable, not in-memory bookkeeping.
    const reloaded = createValidationRunsRepo(fixture.db);
    for (const runId of [
      "run-owned",
      "run-dead",
      "run-recycled-pid",
      "run-queued",
      "run-preconfirm",
    ]) {
      expect(reloaded.findById(runId)?.status).toBe("interrupted");
    }
    expect(reloaded.findById("run-finished")?.status).toBe("passed");
    // Started rows keep their spawn→death execution timing; never-started
    // rows record none.
    expect(reloaded.findById("run-owned")?.execMs).not.toBeNull();
    expect(reloaded.findById("run-queued")?.execMs).toBeNull();
    expect(reloaded.findStaleActive()).toHaveLength(0);
  });

  it("reports a clean ledger without touching anything", async () => {
    const result = await reconcileValidationLedger({
      repo,
      transact: (_label, fn) => fixture.db.transaction(fn)(),
      identity: {
        classifyGroup: async () => {
          throw new Error("must not probe an empty ledger");
        },
        killGroup: async () => {
          throw new Error("must not kill on an empty ledger");
        },
      },
    });

    expect(result.interruptedRunIds).toEqual([]);
    expect(result.killedProcessGroups).toEqual([]);
  });

  it("fails closed instead of settling a row whose live group cannot be verified", async () => {
    seedRunning("run-owned", 111);
    seedRunning("run-orphaned", 555);

    const killed: number[] = [];
    const observedInterrupted: string[] = [];
    await expect(
      reconcileValidationLedger({
        repo,
        transact: (_label, fn) => fixture.db.transaction(fn)(),
        identity: {
          // pgid 555 is alive but its leader cannot be inspected — the
          // orphan-descendant case. Recovery must not pretend it is settled.
          classifyGroup: async (pgid) =>
            pgid === 111 ? "owned" : "unverifiable",
          killGroup: async (pgid) => {
            killed.push(pgid);
          },
        },
        onInterrupted: (runId) => {
          observedInterrupted.push(runId);
        },
      }),
    ).rejects.toBeInstanceOf(UnverifiableValidationGroupError);

    // The verifiable group was still terminated and its row settled…
    expect(killed).toEqual([111]);
    expect(observedInterrupted).toEqual(["run-owned"]);
    const reloaded = createValidationRunsRepo(fixture.db);
    expect(reloaded.findById("run-owned")?.status).toBe("interrupted");
    // …but the unverifiable row keeps its running status so the next
    // recovery pass retries it instead of releasing budget over a live group.
    expect(reloaded.findById("run-orphaned")?.status).toBe("running");
  });
});

describe("admission gate", () => {
  it("starts closed and releases waiters only when opened", async () => {
    const gate = createValidationAdmissionGate();
    expect(gate.isOpen()).toBe(false);

    const order: string[] = [];
    const waiter = gate.whenOpen().then(() => {
      order.push("opened");
    });
    order.push("before-open");

    gate.open();
    await waiter;

    expect(gate.isOpen()).toBe(true);
    expect(order).toEqual(["before-open", "opened"]);
    // Re-awaiting after open resolves immediately.
    await gate.whenOpen();
  });
});

describe("createProcessGroupIdentity (live processes)", () => {
  let projectDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-validation-project-"));
    worktreeDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-validation-worktree-"),
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  it("verifies a live group by its argv nonce marker, never the bare pid", async () => {
    const scriptPath = path.join(projectDir, "scripts/check.sh");
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, "#!/bin/sh\nsleep 300\n");
    chmodSync(scriptPath, 0o755);

    const result = await spawnValidation({
      runId: "run-identity",
      nonce: "identity-nonce",
      commandName: "check",
      command: "scripts/check.sh",
      cost: 1,
      projectPath: projectDir,
      worktreePath: worktreeDir,
      sessionName: "s1",
      branchName: "csm/s1",
      scopeArgs: "forbid",
      scopePaths: [],
      timeoutMs: 60_000,
      killGraceMs: 250,
      pollMs: 25,
    });
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    const pgid = result.handle.processGroupPid;

    const identity = createProcessGroupIdentity({
      killGraceMs: 250,
      pollMs: 25,
    });
    await expect(identity.classifyGroup(pgid, "identity-nonce")).resolves.toBe(
      "owned",
    );
    // Same live pid with a different run's nonce: not ours to kill.
    await expect(
      identity.classifyGroup(pgid, "some-other-nonce"),
    ).resolves.toBe("not_ours");

    await identity.killGroup(pgid);
    await expect(identity.classifyGroup(pgid, "identity-nonce")).resolves.toBe(
      "not_ours",
    );
    await result.handle.wait();
  }, 15_000);
});
