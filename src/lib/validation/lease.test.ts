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
  createValidationLeaseManager,
  type ValidationLeaseManager,
} from "./lease";
import {
  createValidationScheduler,
  type ValidationRunSubmission,
  type ValidationScheduler,
} from "./scheduler";

const LIMIT = 8;

let fixture: PersistenceFixture;
let repo: ValidationRunsRepo;
let scheduler: ValidationScheduler;
let manager: ValidationLeaseManager;
/** Interleaved kill/release call order, keyed by runId. */
let actions: string[];
/** Per-test hook to interleave state changes while a group-kill is awaited. */
let killRunImpl: (runId: string) => Promise<void>;

beforeEach(() => {
  seq = 0;
  actions = [];
  killRunImpl = async () => {};
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-05T10:00:00.000Z"));
  fixture = createPersistenceFixture();
  repo = createValidationRunsRepo(fixture.db);
  const transact = <T>(_label: string, fn: () => T): T =>
    fixture.db.transaction(fn)();
  scheduler = createValidationScheduler({ repo, transact });
  manager = createValidationLeaseManager({
    repo,
    transact,
    killRun: async (runId) => {
      actions.push(`kill:${runId}`);
      await killRunImpl(runId);
    },
    // Production-shaped release: the real scheduler performs the terminal
    // transition and capacity release the facade would.
    releaseInterrupted: (runId) => {
      actions.push(`release:${runId}`);
      scheduler.release(runId, { status: "interrupted" }, { limit: LIMIT });
    },
    ttlMs: 60_000,
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
    scoped: false,
    scopedPathCount: 0,
    ...overrides,
  };
}

function submitLeased(
  runId: string,
  opts: { cost?: number; wait?: boolean } = {},
): { token: string; expiresAt: string } {
  const lease = manager.issue();
  const decision = scheduler.submit(
    submission({
      runId,
      cost: opts.cost ?? 1,
      leaseToken: lease.token,
      leaseExpiresAt: lease.expiresAt,
    }),
    { wait: opts.wait ?? false, limit: LIMIT },
  );
  expect(["admitted", "queued"]).toContain(decision.kind);
  return lease;
}

describe("lease issuance", () => {
  it("issues opaque unique tokens with a ttl-relative expiry", () => {
    const first = manager.issue();
    const second = manager.issue();

    expect(first.token.length).toBeGreaterThanOrEqual(16);
    expect(second.token).not.toBe(first.token);
    expect(first.expiresAt).toBe("2026-08-05T10:01:00.000Z");
  });
});

describe("renewal on poll", () => {
  it("extends the persisted expiry only for the exact token holder", () => {
    const lease = submitLeased("run-renew");

    vi.advanceTimersByTime(30_000);
    const renewed = manager.renew("run-renew", lease.token);

    expect(renewed.renewed).toBe(true);
    expect(renewed.expiresAt).toBe("2026-08-05T10:01:30.000Z");
    expect(repo.findById("run-renew")?.leaseExpiresAt).toBe(
      "2026-08-05T10:01:30.000Z",
    );

    const stranger = manager.renew("run-renew", "not-the-token");
    expect(stranger.renewed).toBe(false);
    expect(repo.findById("run-renew")?.leaseExpiresAt).toBe(
      "2026-08-05T10:01:30.000Z",
    );
  });

  it("does not renew a terminal run", () => {
    const lease = submitLeased("run-done");
    scheduler.release(
      "run-done",
      { status: "passed", exitCode: 0 },
      { limit: LIMIT },
    );

    expect(manager.renew("run-done", lease.token).renewed).toBe(false);
  });
});

describe("owner-only cancel authorization", () => {
  it("authorizes only the exact token holder", () => {
    const lease = submitLeased("run-mine");

    expect(manager.authorizeCancel("run-mine", lease.token)).toBe("authorized");
    expect(manager.authorizeCancel("run-mine", "someone-elses-token")).toBe(
      "not_owner",
    );
  });

  it("distinguishes unknown, terminal, and system-owned runs", () => {
    expect(manager.authorizeCancel("missing", "tok")).toBe("not_found");

    const lease = submitLeased("run-ended");
    scheduler.release("run-ended", { status: "cancelled" }, { limit: LIMIT });
    expect(manager.authorizeCancel("run-ended", lease.token)).toBe(
      "already_terminal",
    );

    scheduler.submit(
      submission({ runId: "run-system", source: "smart_merge" }),
      {
        wait: false,
        limit: LIMIT,
      },
    );
    expect(manager.authorizeCancel("run-system", "any-token")).toBe(
      "system_owned",
    );
  });
});

describe("expiry sweep", () => {
  it("group-kills an expired running job before releasing it as interrupted", async () => {
    submitLeased("run-expired", { cost: 8 });
    scheduler.markStarted("run-expired", 4242);

    vi.advanceTimersByTime(61_000);
    const { expired } = await manager.sweepExpired();

    expect(expired.map((r) => r.runId)).toEqual(["run-expired"]);
    expect(actions).toEqual(["kill:run-expired", "release:run-expired"]);
    expect(repo.findById("run-expired")?.status).toBe("interrupted");
    expect(scheduler.snapshot().inUse).toBe(0);
  });

  it("dequeues an expired waiter without killing anything", async () => {
    // Fill capacity so the leased submission queues.
    scheduler.submit(submission({ runId: "hog", cost: 8 }), {
      wait: false,
      limit: LIMIT,
    });
    submitLeased("run-waiting", { cost: 4, wait: true });
    expect(repo.findById("run-waiting")?.status).toBe("queued");

    vi.advanceTimersByTime(61_000);
    const { expired } = await manager.sweepExpired();

    expect(expired.map((r) => r.runId)).toEqual(["run-waiting"]);
    expect(actions).toEqual(["release:run-waiting"]);
    expect(repo.findById("run-waiting")?.status).toBe("interrupted");
  });

  it("spares a run whose lease was renewed while an earlier expiry's group-kill was in flight", async () => {
    submitLeased("run-a");
    const leaseB = submitLeased("run-b");
    vi.advanceTimersByTime(61_000);

    // While run-a's group-kill is awaited, run-b's owner renews. The sweep
    // snapshot said run-b was expired; the renewal must still win.
    killRunImpl = async (runId) => {
      if (runId === "run-a") {
        expect(manager.renew("run-b", leaseB.token).renewed).toBe(true);
      }
    };

    const { expired } = await manager.sweepExpired();

    expect(expired.map((row) => row.runId)).toEqual(["run-a"]);
    expect(actions).toEqual(["kill:run-a", "release:run-a"]);
    expect(repo.findById("run-b")?.status).toBe("running");
  });

  it("group-kills an expired waiter that was admitted while an earlier kill was in flight", async () => {
    submitLeased("run-r", { cost: 8 });
    submitLeased("run-q", { cost: 8, wait: true });
    vi.advanceTimersByTime(61_000);

    // While run-r's group-kill is awaited, its capacity release pumps the
    // queue and the expired waiter starts running — exactly what the
    // production finalize continuation does. The sweep must kill the new
    // process, never release the row while its group lives.
    killRunImpl = async (runId) => {
      if (runId !== "run-r") return;
      scheduler.release("run-r", { status: "interrupted" }, { limit: LIMIT });
      const pumped = scheduler.pump({ limit: LIMIT });
      expect(pumped.admitted.map((row) => row.runId)).toEqual(["run-q"]);
      scheduler.markStarted("run-q", 777);
    };

    const { expired } = await manager.sweepExpired();

    expect(expired.map((row) => row.runId)).toEqual(["run-r", "run-q"]);
    expect(actions).toEqual([
      "kill:run-r",
      "release:run-r",
      "kill:run-q",
      "release:run-q",
    ]);
    expect(repo.findById("run-q")?.status).toBe("interrupted");
  });

  it("leaves unexpired and system-owned runs untouched", async () => {
    submitLeased("run-fresh", { cost: 1 });
    scheduler.submit(
      submission({
        runId: "run-system",
        source: "graph_script_validator",
        cost: 1,
      }),
      { wait: false, limit: LIMIT },
    );

    // Well past the ttl: the system-owned run has no lease to expire, and the
    // fresh run is renewed mid-way to stay alive.
    vi.advanceTimersByTime(45_000);
    const lease = repo.findById("run-fresh");
    expect(lease?.leaseToken).not.toBeNull();
    manager.renew("run-fresh", lease?.leaseToken ?? "");
    vi.advanceTimersByTime(45_000);

    const { expired } = await manager.sweepExpired();

    expect(expired).toHaveLength(0);
    expect(actions).toEqual([]);
    expect(repo.findById("run-fresh")?.status).toBe("running");
    expect(repo.findById("run-system")?.status).toBe("running");
  });
});
