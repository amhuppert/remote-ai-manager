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
  validationRunRecordSchema,
  type ValidationRunRecord,
} from "@/lib/validation/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  createValidationRunsRepo,
  type ValidationRunsRepo,
} from "./validation-runs-repo";

let fixture: PersistenceFixture;
let repo: ValidationRunsRepo;

beforeEach(() => {
  fixture = createPersistenceFixture();
  repo = createValidationRunsRepo(fixture.db);
});

afterEach(() => {
  fixture.close();
});

/**
 * Every introspectable persisted key path populated with a distinctive
 * non-null value. Declared as a literal so tests can reference the concrete
 * (non-nullable-typed) timing/lease values when driving the mutation chain.
 */
const MAXIMAL = {
  runId: "vr-maximal",
  source: "agent_cli",
  commandName: "test-unit",
  cost: 8,
  queueOrder: 7,
  status: "passed",
  nonce: "nonce-0123456789abcdef",
  leaseToken: "lease-token-fedcba",
  leaseExpiresAt: "2026-08-05T10:03:00.000Z",
  processGroupPid: 54_321,
  projectPath: "/projects/app",
  worktreePath: "/projects/app/.worktrees/session-a",
  sessionName: "session-a",
  conversationId: "conv-42",
  workflowExecutionId: "exec-7",
  workflowContextId: "ctx-api",
  workflowRole: "implementer",
  submittedAt: "2026-08-05T10:00:00.000Z",
  startedAt: "2026-08-05T10:00:05.500Z",
  finishedAt: "2026-08-05T10:02:05.750Z",
  queueMs: 5_500,
  execMs: 120_250,
  requestedScope: "changed",
  effectiveScope: "full",
  scopedPathCount: 0,
  exitCode: 0,
  timedOut: false,
} as const;

function buildMaximalRecord(): ValidationRunRecord {
  return validationRunRecordSchema.parse(MAXIMAL);
}

function queuedRecord(
  overrides: Partial<ValidationRunRecord> = {},
): ValidationRunRecord {
  return validationRunRecordSchema.parse({
    ...MAXIMAL,
    runId: "vr-queued",
    status: "queued",
    processGroupPid: null,
    startedAt: null,
    finishedAt: null,
    queueMs: null,
    execMs: null,
    exitCode: null,
    timedOut: false,
    ...overrides,
  });
}

/**
 * Drive the maximal record into existence through the production mutation
 * chain (submit → admit → markStarted → renewLease → markPassed) rather than
 * a raw insert, so the durability contract also proves the focused mutations
 * collectively persist every field they own.
 */
function persistMaximalThroughLifecycle(record: ValidationRunRecord): void {
  repo.submit(
    validationRunRecordSchema.parse({
      ...record,
      status: "queued",
      processGroupPid: null,
      startedAt: null,
      finishedAt: null,
      queueMs: null,
      execMs: null,
      exitCode: null,
      timedOut: false,
      leaseExpiresAt: "2026-08-05T10:00:30.000Z",
    }),
  );
  expect(repo.admit(record.runId)).toBe(true);
  expect(
    repo.markStarted(record.runId, {
      startedAt: MAXIMAL.startedAt,
      queueMs: MAXIMAL.queueMs,
      processGroupPid: MAXIMAL.processGroupPid,
    }),
  ).toBe(true);
  expect(
    repo.renewLease(record.runId, MAXIMAL.leaseToken, MAXIMAL.leaseExpiresAt),
  ).toBe(true);
  expect(
    repo.markPassed(record.runId, {
      finishedAt: MAXIMAL.finishedAt,
      execMs: MAXIMAL.execMs,
      exitCode: MAXIMAL.exitCode,
    }),
  ).toBe(true);
}

describe("validation-runs-repo durability contract", () => {
  it("round-trips every persisted key path through the real mutation chain", async () => {
    await assertRoundTripDurability({
      label: "validation-runs",
      schema: validationRunRecordSchema,
      buildMaximalFixture: buildMaximalRecord,
      persist: (record) => {
        persistMaximalThroughLifecycle(record);
        return record;
      },
      // Post-restart reader: a second repo over the same DB proves the row
      // came back from SQLite, not from any in-memory state.
      reload: (expected) =>
        createValidationRunsRepo(fixture.db).findById(expected.runId),
      // No field policies: every schema field maps to a dedicated column.
      // queueMs/execMs are stored explicitly at their transitions (§12), not
      // derived on read, so the timing fields are part of the round-trip.
      fieldPolicies: {},
    });
  });
});

describe("validation-runs-repo lifecycle transitions", () => {
  it("round-trips nullable scopes on an ambiguous legacy row", () => {
    repo.submit(
      queuedRecord({
        runId: "vr-legacy",
        requestedScope: null,
        effectiveScope: null,
      }),
    );

    expect(repo.findById("vr-legacy")).toMatchObject({
      requestedScope: null,
      effectiveScope: null,
    });
  });

  it("admit moves only a queued row to running, exactly once", () => {
    repo.submit(queuedRecord());

    expect(repo.admit("vr-queued")).toBe(true);
    expect(repo.findById("vr-queued")?.status).toBe("running");
    expect(repo.admit("vr-queued")).toBe(false);
    expect(repo.admit("vr-missing")).toBe(false);
  });

  it("markStarted records spawn timing only on a running row", () => {
    repo.submit(queuedRecord());
    expect(
      repo.markStarted("vr-queued", {
        startedAt: MAXIMAL.startedAt,
        queueMs: 100,
        processGroupPid: 111,
      }),
    ).toBe(false);

    repo.admit("vr-queued");
    expect(
      repo.markStarted("vr-queued", {
        startedAt: MAXIMAL.startedAt,
        queueMs: 100,
        processGroupPid: 111,
      }),
    ).toBe(true);

    const row = repo.findById("vr-queued");
    expect(row?.startedAt).toBe(MAXIMAL.startedAt);
    expect(row?.queueMs).toBe(100);
    expect(row?.processGroupPid).toBe(111);
  });

  it("renewLease extends expiry only for the exact token holder", () => {
    repo.submit(queuedRecord());

    expect(
      repo.renewLease("vr-queued", "wrong-token", "2026-08-05T11:00:00.000Z"),
    ).toBe(false);
    expect(repo.findById("vr-queued")?.leaseExpiresAt).toBe(
      MAXIMAL.leaseExpiresAt,
    );

    expect(
      repo.renewLease(
        "vr-queued",
        MAXIMAL.leaseToken,
        "2026-08-05T11:00:00.000Z",
      ),
    ).toBe(true);
    expect(repo.findById("vr-queued")?.leaseExpiresAt).toBe(
      "2026-08-05T11:00:00.000Z",
    );
  });

  it("a lease-exempt system-owned run persists null lease data", () => {
    repo.submit(
      queuedRecord({
        runId: "vr-system",
        source: "graph_lane_merge",
        leaseToken: null,
        leaseExpiresAt: null,
        sessionName: null,
        conversationId: null,
        workflowRole: null,
      }),
    );

    const row = repo.findById("vr-system");
    expect(row?.leaseToken).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.sessionName).toBeNull();
    expect(
      repo.renewLease("vr-system", "any-token", "2026-08-05T11:00:00.000Z"),
    ).toBe(false);
  });

  it("marks failed with a null exit code for a spawn error", () => {
    repo.submit(queuedRecord());
    repo.admit("vr-queued");

    expect(
      repo.markFailed("vr-queued", {
        finishedAt: MAXIMAL.finishedAt,
        execMs: null,
        exitCode: null,
      }),
    ).toBe(true);

    const row = repo.findById("vr-queued");
    expect(row?.status).toBe("failed");
    expect(row?.exitCode).toBeNull();
    expect(row?.timedOut).toBe(false);
  });

  it("markTimedOut is the only transition that sets the timedOut flag", () => {
    repo.submit(queuedRecord());
    repo.admit("vr-queued");
    repo.markStarted("vr-queued", {
      startedAt: MAXIMAL.startedAt,
      queueMs: 10,
      processGroupPid: 222,
    });

    expect(
      repo.markTimedOut("vr-queued", {
        finishedAt: MAXIMAL.finishedAt,
        execMs: 600_000,
        exitCode: null,
      }),
    ).toBe(true);

    const row = repo.findById("vr-queued");
    expect(row?.status).toBe("timed_out");
    expect(row?.timedOut).toBe(true);
    expect(row?.execMs).toBe(600_000);
  });

  it("cancels a still-queued row with no execution timing", () => {
    repo.submit(queuedRecord());

    expect(
      repo.markCancelled("vr-queued", {
        finishedAt: MAXIMAL.finishedAt,
        execMs: null,
      }),
    ).toBe(true);

    const row = repo.findById("vr-queued");
    expect(row?.status).toBe("cancelled");
    expect(row?.startedAt).toBeNull();
    expect(row?.execMs).toBeNull();
  });

  it("marks a queued row cost_exceeds_limit, but never a running one", () => {
    repo.submit(queuedRecord());

    expect(
      repo.markCostExceedsLimit("vr-queued", {
        finishedAt: MAXIMAL.finishedAt,
      }),
    ).toBe(true);

    // Reload through a fresh repo over the same DB: the configuration-error
    // verdict must be durable, not in-memory bookkeeping.
    const reloaded = createValidationRunsRepo(fixture.db).findById("vr-queued");
    expect(reloaded?.status).toBe("cost_exceeds_limit");
    expect(reloaded?.finishedAt).toBe(MAXIMAL.finishedAt);
    expect(reloaded?.execMs).toBeNull();

    // Running work is never disturbed by a limit change.
    repo.submit(queuedRecord({ runId: "vr-running" }));
    repo.admit("vr-running");
    expect(
      repo.markCostExceedsLimit("vr-running", {
        finishedAt: MAXIMAL.finishedAt,
      }),
    ).toBe(false);
    expect(repo.findById("vr-running")?.status).toBe("running");
  });

  it("marks interrupted during recovery and retains the row", () => {
    repo.submit(queuedRecord());
    repo.admit("vr-queued");

    expect(
      repo.markInterrupted("vr-queued", { finishedAt: MAXIMAL.finishedAt }),
    ).toBe(true);
    expect(repo.findById("vr-queued")?.status).toBe("interrupted");
  });

  it("markInterrupted preserves execution timing for a run that had started", () => {
    repo.submit(queuedRecord());
    repo.admit("vr-queued");
    repo.markStarted("vr-queued", {
      startedAt: MAXIMAL.startedAt,
      queueMs: 100,
      processGroupPid: 333,
    });

    expect(
      repo.markInterrupted("vr-queued", { finishedAt: MAXIMAL.finishedAt }),
    ).toBe(true);

    // Reload through a fresh repo over the same DB: the timing must come back
    // from SQLite, not any in-memory state.
    const reloaded = createValidationRunsRepo(fixture.db).findById("vr-queued");
    expect(reloaded?.status).toBe("interrupted");
    expect(reloaded?.finishedAt).toBe(MAXIMAL.finishedAt);
    expect(reloaded?.execMs).toBe(MAXIMAL.execMs);
    expect(reloaded?.exitCode).toBeNull();
    expect(reloaded?.timedOut).toBe(false);
  });

  it("markInterrupted keeps execMs null for a never-started queued row", () => {
    repo.submit(queuedRecord());

    expect(
      repo.markInterrupted("vr-queued", { finishedAt: MAXIMAL.finishedAt }),
    ).toBe(true);

    const reloaded = createValidationRunsRepo(fixture.db).findById("vr-queued");
    expect(reloaded?.status).toBe("interrupted");
    expect(reloaded?.startedAt).toBeNull();
    expect(reloaded?.execMs).toBeNull();
  });

  it("terminal rows are immutable and retained — no further transition succeeds", () => {
    repo.submit(queuedRecord());
    repo.admit("vr-queued");
    repo.markPassed("vr-queued", {
      finishedAt: MAXIMAL.finishedAt,
      execMs: 5,
      exitCode: 0,
    });

    expect(repo.admit("vr-queued")).toBe(false);
    expect(
      repo.markCancelled("vr-queued", {
        finishedAt: MAXIMAL.finishedAt,
        execMs: null,
      }),
    ).toBe(false);
    expect(
      repo.markInterrupted("vr-queued", { finishedAt: MAXIMAL.finishedAt }),
    ).toBe(false);

    const row = repo.findById("vr-queued");
    expect(row?.status).toBe("passed");
    expect(row?.finishedAt).toBe(MAXIMAL.finishedAt);
  });
});

describe("validation-runs-repo queue and reconciliation queries", () => {
  it("nextQueueOrder starts at zero and increments past the maximum", () => {
    expect(repo.nextQueueOrder()).toBe(0);
    repo.submit(queuedRecord({ runId: "vr-1", queueOrder: 0 }));
    repo.submit(queuedRecord({ runId: "vr-2", queueOrder: 5 }));
    expect(repo.nextQueueOrder()).toBe(6);
  });

  it("findQueued returns strict FIFO order by queueOrder", () => {
    repo.submit(queuedRecord({ runId: "vr-b", queueOrder: 2 }));
    repo.submit(queuedRecord({ runId: "vr-a", queueOrder: 1 }));
    repo.submit(queuedRecord({ runId: "vr-c", queueOrder: 3 }));
    repo.admit("vr-a");

    expect(repo.findQueued().map((r) => r.runId)).toEqual(["vr-b", "vr-c"]);
    expect(repo.findRunning().map((r) => r.runId)).toEqual(["vr-a"]);
  });

  it("findStaleActive surfaces queued and running rows but never terminal ones", () => {
    repo.submit(queuedRecord({ runId: "vr-q", queueOrder: 1 }));
    repo.submit(queuedRecord({ runId: "vr-r", queueOrder: 2 }));
    repo.submit(queuedRecord({ runId: "vr-t", queueOrder: 3 }));
    repo.admit("vr-r");
    repo.admit("vr-t");
    repo.markPassed("vr-t", {
      finishedAt: MAXIMAL.finishedAt,
      execMs: 5,
      exitCode: 0,
    });

    expect(repo.findStaleActive().map((r) => r.runId)).toEqual([
      "vr-q",
      "vr-r",
    ]);
  });
});
