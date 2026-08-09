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
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createValidationRunsRepo,
  type ValidationRunsRepo,
} from "@/lib/state-store/validation-runs-repo";
import {
  createValidationRunHandleRegistry,
  createValidationScheduler,
  type ValidationRunSubmission,
  type ValidationScheduler,
} from "./scheduler";

let fixture: PersistenceFixture;
let repo: ValidationRunsRepo;
let scheduler: ValidationScheduler;

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-05T10:00:00.000Z"));
  fixture = createPersistenceFixture();
  repo = createValidationRunsRepo(fixture.db);
  scheduler = createValidationScheduler({
    repo,
    transact: (_label, fn) => fixture.db.transaction(fn)(),
  });
});

afterEach(() => {
  fixture.close();
  vi.useRealTimers();
});

let seq = 0;
function submission(
  overrides: Partial<ValidationRunSubmission> = {},
): ValidationRunSubmission {
  seq += 1;
  return {
    runId: `run-${seq}`,
    source: "agent_cli",
    commandName: "test",
    cost: 1,
    nonce: `nonce-${seq}`,
    leaseToken: null,
    leaseExpiresAt: null,
    projectPath: "/projects/app",
    worktreePath: "/projects/app/.worktrees/s1",
    sessionName: "s1",
    conversationId: null,
    workflowExecutionId: null,
    workflowContextId: null,
    workflowRole: null,
    requestedScope: "changed",
    effectiveScope: "full",
    scopedPathCount: 0,
    ...overrides,
  };
}

describe("weighted FIFO admission", () => {
  it("admits a fail-fast submission that fits into free capacity", () => {
    const decision = scheduler.submit(submission({ cost: 3 }), {
      wait: false,
      limit: 8,
    });

    expect(decision.kind).toBe("admitted");
    if (decision.kind !== "admitted") return;
    expect(decision.record.status).toBe("running");
    expect(repo.findRunning()).toHaveLength(1);
    expect(scheduler.snapshot().inUse).toBe(3);
  });

  it("rejects cost above the limit without creating a ledger row, including wait submissions", () => {
    const failFast = scheduler.submit(
      submission({ runId: "over-1", cost: 9 }),
      { wait: false, limit: 8 },
    );
    const waited = scheduler.submit(submission({ runId: "over-2", cost: 9 }), {
      wait: true,
      limit: 8,
    });

    expect(failFast).toEqual({
      kind: "cost_exceeds_limit",
      cost: 9,
      limit: 8,
    });
    expect(waited).toEqual({ kind: "cost_exceeds_limit", cost: 9, limit: 8 });
    expect(repo.findById("over-1")).toBeNull();
    expect(repo.findById("over-2")).toBeNull();
  });

  it("refuses a fail-fast submission when raw capacity is insufficient", () => {
    scheduler.submit(submission({ cost: 6 }), { wait: false, limit: 8 });

    const decision = scheduler.submit(submission({ cost: 3 }), {
      wait: false,
      limit: 8,
    });

    expect(decision).toEqual({
      kind: "capacity_unavailable",
      cost: 3,
      inUse: 6,
      limit: 8,
      queueDepth: 0,
      blockedByOlderWaiter: false,
    });
    expect(repo.findQueued()).toHaveLength(0);
  });

  it("queues a wait submission that does not fit and reports its position", () => {
    scheduler.submit(submission({ cost: 6 }), { wait: false, limit: 8 });

    const first = scheduler.submit(submission({ cost: 8 }), {
      wait: true,
      limit: 8,
    });
    const second = scheduler.submit(submission({ cost: 4 }), {
      wait: true,
      limit: 8,
    });

    expect(first.kind).toBe("queued");
    if (first.kind !== "queued") return;
    expect(first.position).toBe(0);
    expect(second.kind).toBe("queued");
    if (second.kind !== "queued") return;
    expect(second.position).toBe(1);
  });

  it("immediately admits a wait submission when the queue is empty and it fits", () => {
    const decision = scheduler.submit(submission({ cost: 8 }), {
      wait: true,
      limit: 8,
    });
    expect(decision.kind).toBe("admitted");
  });
});

describe("no barging / starvation resistance", () => {
  it("refuses fail-fast requests that fit raw capacity while an older waiter exists", () => {
    scheduler.submit(submission({ cost: 4 }), { wait: false, limit: 8 });
    scheduler.submit(submission({ runId: "big-waiter", cost: 8 }), {
      wait: true,
      limit: 8,
    });

    // A stream of cheap fail-fast requests fits into the 4 free units but
    // must never leapfrog the queued cost-8 waiter.
    for (let i = 0; i < 3; i += 1) {
      const decision = scheduler.submit(submission({ cost: 1 }), {
        wait: false,
        limit: 8,
      });
      expect(decision.kind).toBe("capacity_unavailable");
      if (decision.kind !== "capacity_unavailable") return;
      expect(decision.blockedByOlderWaiter).toBe(true);
    }
    expect(scheduler.snapshot().inUse).toBe(4);
    expect(repo.findQueued()).toHaveLength(1);
  });

  it("queues wait submissions behind an older waiter even when they fit", () => {
    scheduler.submit(submission({ runId: "active", cost: 4 }), {
      wait: false,
      limit: 8,
    });
    scheduler.submit(submission({ runId: "head", cost: 8 }), {
      wait: true,
      limit: 8,
    });

    const cheap = scheduler.submit(submission({ runId: "cheap", cost: 1 }), {
      wait: true,
      limit: 8,
    });
    expect(cheap.kind).toBe("queued");

    // Head still admitted first once capacity frees.
    scheduler.release("active", { status: "cancelled" }, { limit: 8 });
    const pumped = scheduler.pump({ limit: 8 });
    expect(pumped.admitted.map((r) => r.runId)).toEqual(["head"]);
  });

  it("admits from the head while it fits and never skips a large head", () => {
    const first = scheduler.submit(submission({ runId: "active", cost: 4 }), {
      wait: false,
      limit: 8,
    });
    expect(first.kind).toBe("admitted");
    scheduler.submit(submission({ runId: "big", cost: 8 }), {
      wait: true,
      limit: 8,
    });
    scheduler.submit(submission({ runId: "small", cost: 1 }), {
      wait: true,
      limit: 8,
    });

    scheduler.release(
      "active",
      { status: "passed", exitCode: 0 },
      { limit: 8 },
    );
    const pump1 = scheduler.pump({ limit: 8 });
    // Head (cost 8) fits after release; the small job behind it must NOT be
    // admitted alongside because 8 + 1 > 8.
    expect(pump1.admitted.map((r) => r.runId)).toEqual(["big"]);
    expect(scheduler.snapshot().inUse).toBe(8);

    scheduler.release("big", { status: "passed", exitCode: 0 }, { limit: 8 });
    const pump2 = scheduler.pump({ limit: 8 });
    expect(pump2.admitted.map((r) => r.runId)).toEqual(["small"]);
  });

  it("keeps sum of running costs within the limit across interleaved submissions", () => {
    const a = scheduler.submit(submission({ cost: 5 }), {
      wait: true,
      limit: 8,
    });
    const b = scheduler.submit(submission({ cost: 5 }), {
      wait: true,
      limit: 8,
    });

    expect(a.kind).toBe("admitted");
    expect(b.kind).toBe("queued");
    expect(scheduler.snapshot().inUse).toBe(5);
  });
});

describe("limit lowering", () => {
  it("leaves active work untouched and retires queued rows newly over the limit as cost_exceeds_limit", () => {
    scheduler.submit(submission({ runId: "active", cost: 8 }), {
      wait: false,
      limit: 8,
    });
    scheduler.submit(submission({ runId: "waiting-big", cost: 6 }), {
      wait: true,
      limit: 8,
    });
    scheduler.submit(submission({ runId: "waiting-small", cost: 2 }), {
      wait: true,
      limit: 8,
    });

    const pumped = scheduler.pump({ limit: 4 });

    expect(pumped.oversized.map((r) => r.runId)).toEqual(["waiting-big"]);
    // The durable verdict is a configuration error, not a cancellation:
    // the ledger row must say cost_exceeds_limit after a restart too.
    expect(repo.findById("waiting-big")?.status).toBe("cost_exceeds_limit");
    const reloaded = createValidationRunsRepo(fixture.db);
    expect(reloaded.findById("waiting-big")?.status).toBe("cost_exceeds_limit");
    // Active cost-8 work keeps running.
    expect(repo.findById("active")?.status).toBe("running");
    // The small waiter is not admitted while the running job exceeds the new
    // limit, but it stays queued rather than being cancelled.
    expect(pumped.admitted).toHaveLength(0);
    expect(repo.findById("waiting-small")?.status).toBe("queued");

    scheduler.release(
      "active",
      { status: "passed", exitCode: 0 },
      { limit: 4 },
    );
    const after = scheduler.pump({ limit: 4 });
    expect(after.admitted.map((r) => r.runId)).toEqual(["waiting-small"]);
  });
});

describe("release", () => {
  const verdicts = [
    { name: "passed", verdict: { status: "passed", exitCode: 0 } },
    { name: "failed", verdict: { status: "failed", exitCode: 1 } },
    { name: "timed_out", verdict: { status: "timed_out", exitCode: null } },
    { name: "cancelled", verdict: { status: "cancelled" } },
    { name: "interrupted", verdict: { status: "interrupted" } },
  ] as const;

  for (const { name, verdict } of verdicts) {
    it(`releases capacity on the ${name} terminal path and guards double release`, () => {
      const decision = scheduler.submit(
        submission({ runId: `run-${name}`, cost: 8 }),
        { wait: false, limit: 8 },
      );
      expect(decision.kind).toBe("admitted");
      scheduler.markStarted(`run-${name}`, 4242);
      expect(scheduler.snapshot().inUse).toBe(8);

      const released = scheduler.release(`run-${name}`, verdict, { limit: 8 });
      expect(released).toBe(true);
      expect(scheduler.snapshot().inUse).toBe(0);
      expect(repo.findById(`run-${name}`)?.status).toBe(name);

      const again = scheduler.release(`run-${name}`, verdict, { limit: 8 });
      expect(again).toBe(false);
    });
  }

  it("releases a spawn-error run (failed with null exit code, never started)", () => {
    scheduler.submit(submission({ runId: "spawn-err", cost: 4 }), {
      wait: false,
      limit: 8,
    });

    const released = scheduler.release(
      "spawn-err",
      { status: "failed", exitCode: null },
      { limit: 8 },
    );

    expect(released).toBe(true);
    const row = repo.findById("spawn-err");
    expect(row?.status).toBe("failed");
    expect(row?.exitCode).toBeNull();
    expect(row?.execMs).toBeNull();
    expect(scheduler.snapshot().inUse).toBe(0);
  });
});

describe("timing accounting", () => {
  it("records submittedAt/startedAt/finishedAt and keeps queueMs and execMs separate", () => {
    scheduler.submit(submission({ runId: "timed", cost: 2 }), {
      wait: false,
      limit: 8,
    });

    vi.advanceTimersByTime(5_000);
    const started = scheduler.markStarted("timed", 777);
    expect(started).toEqual({
      startedAt: "2026-08-05T10:00:05.000Z",
      queueMs: 5_000,
    });

    vi.advanceTimersByTime(2_500);
    scheduler.release("timed", { status: "passed", exitCode: 0 }, { limit: 8 });

    const row = repo.findById("timed");
    expect(row?.submittedAt).toBe("2026-08-05T10:00:00.000Z");
    expect(row?.startedAt).toBe("2026-08-05T10:00:05.000Z");
    expect(row?.finishedAt).toBe("2026-08-05T10:00:07.500Z");
    expect(row?.queueMs).toBe(5_000);
    expect(row?.execMs).toBe(2_500);
    expect(row?.processGroupPid).toBe(777);
  });

  it("guards markStarted against a second call and unknown runs", () => {
    scheduler.submit(submission({ runId: "once", cost: 1 }), {
      wait: false,
      limit: 8,
    });
    expect(scheduler.markStarted("once", 1)).not.toBeNull();
    expect(scheduler.markStarted("once", 2)).toBeNull();
    expect(scheduler.markStarted("missing", 3)).toBeNull();
  });
});

describe("process handle registry", () => {
  it("keeps handles in memory keyed by runId with take semantics", () => {
    const registry = createValidationRunHandleRegistry<{ pid: number }>();
    registry.attach("r1", { pid: 10 });
    registry.attach("r2", { pid: 20 });

    expect(registry.get("r1")).toEqual({ pid: 10 });
    expect(
      registry
        .list()
        .map((e) => e.runId)
        .sort(),
    ).toEqual(["r1", "r2"]);
    expect(registry.take("r1")).toEqual({ pid: 10 });
    expect(registry.get("r1")).toBeNull();
    expect(registry.take("r1")).toBeNull();
    expect(registry.list()).toHaveLength(1);
  });
});
