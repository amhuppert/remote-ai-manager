import { describe, expect, it } from "vitest";
import {
  resolveScopedWorkerRequest,
  resolveWorkerBudget,
} from "./worker-budget.mjs";

const GB = 1024 ** 3;

/** The heap both the vitest config and the validation launcher size against. */
const WORKER_HEAP_MB = 1536;
const COORDINATOR_HEAP_MB = 3072;

describe("resolveWorkerBudget", () => {
  it("budgets the coordinator heap separately from worker heaps", () => {
    // The coordinator retains the full task graph and needs more heap than an
    // individual worker. The remaining 55% RAM budget holds three workers.
    expect(
      resolveWorkerBudget({
        coordinatorHeapMb: COORDINATOR_HEAP_MB,
        workerHeapMb: WORKER_HEAP_MB,
        totalMemoryBytes: 16 * GB,
        availableParallelism: 16,
      }),
    ).toBe(3);
  });

  it("bounds parallelism by core count when RAM is plentiful", () => {
    expect(
      resolveWorkerBudget({
        coordinatorHeapMb: COORDINATOR_HEAP_MB,
        workerHeapMb: WORKER_HEAP_MB,
        totalMemoryBytes: 128 * GB,
        availableParallelism: 8,
      }),
    ).toBe(8);
  });

  it("keeps a two-worker floor on a machine whose RAM affords fewer", () => {
    expect(
      resolveWorkerBudget({
        coordinatorHeapMb: COORDINATOR_HEAP_MB,
        workerHeapMb: WORKER_HEAP_MB,
        totalMemoryBytes: 4 * GB,
        availableParallelism: 8,
      }),
    ).toBe(2);
  });

  it("clamps a caller that asks for more workers than the machine can hold", () => {
    // The case this exists for: the validation launcher asked for a fixed eight
    // workers regardless of machine, so validation — the heaviest run on the
    // box — was the one path that ignored the budget the config computes.
    expect(
      resolveWorkerBudget({
        requestedWorkers: 8,
        coordinatorHeapMb: COORDINATOR_HEAP_MB,
        workerHeapMb: WORKER_HEAP_MB,
        totalMemoryBytes: 16 * GB,
        availableParallelism: 16,
      }),
    ).toBe(3);
  });

  it("honours a caller that asks for fewer workers than the budget allows", () => {
    // Clamping is one-directional: the budget is a ceiling, not a target, so a
    // caller that deliberately runs small is never inflated to fill it.
    expect(
      resolveWorkerBudget({
        requestedWorkers: 3,
        coordinatorHeapMb: COORDINATOR_HEAP_MB,
        workerHeapMb: WORKER_HEAP_MB,
        totalMemoryBytes: 128 * GB,
        availableParallelism: 16,
      }),
    ).toBe(3);
  });

  it("never returns less than one worker for an unusable request", () => {
    expect(
      resolveWorkerBudget({
        requestedWorkers: 0,
        coordinatorHeapMb: COORDINATOR_HEAP_MB,
        workerHeapMb: WORKER_HEAP_MB,
        totalMemoryBytes: 128 * GB,
        availableParallelism: 16,
      }),
    ).toBe(1);
  });

  it("shrinks the ceiling as the per-worker heap grows", () => {
    // Same machine, twice the heap per worker, so half the workers fit.
    expect(
      resolveWorkerBudget({
        coordinatorHeapMb: COORDINATOR_HEAP_MB,
        workerHeapMb: WORKER_HEAP_MB * 2,
        totalMemoryBytes: 16 * GB,
        availableParallelism: 16,
      }),
    ).toBe(2);
  });
});

/** Worker count the `test` wrapper asks for on this machine. */
const CONFIGURED_WORKERS = 8;

describe("resolveScopedWorkerRequest", () => {
  it("asks for one worker per forwarded path token", () => {
    // A `paths` run is charged base + perPath * tokens. Path tokens are
    // substring filters, so one token can match hundreds of files; without this
    // clamp a one-token run charged three units would still open the whole fork
    // pool beside other admitted work.
    expect(
      resolveScopedWorkerRequest({
        mode: "paths",
        pathTokenCount: 1,
        configuredWorkers: CONFIGURED_WORKERS,
      }),
    ).toBe(1);
    expect(
      resolveScopedWorkerRequest({
        mode: "paths",
        pathTokenCount: 5,
        configuredWorkers: CONFIGURED_WORKERS,
      }),
    ).toBe(5);
  });

  it("never asks for more than the wrapper's configured pool", () => {
    expect(
      resolveScopedWorkerRequest({
        mode: "paths",
        pathTokenCount: 12,
        configuredWorkers: CONFIGURED_WORKERS,
      }),
    ).toBe(CONFIGURED_WORKERS);
  });

  it("leaves full and changed runs at the configured pool", () => {
    // Only the paths scope is priced per token; the other scopes are charged
    // the wrapper's full weight and may use the whole pool.
    expect(
      resolveScopedWorkerRequest({
        mode: "full",
        pathTokenCount: 0,
        configuredWorkers: CONFIGURED_WORKERS,
      }),
    ).toBe(CONFIGURED_WORKERS);
    expect(
      resolveScopedWorkerRequest({
        mode: "changed",
        pathTokenCount: 0,
        configuredWorkers: CONFIGURED_WORKERS,
      }),
    ).toBe(CONFIGURED_WORKERS);
  });

  it("keeps at least one worker when no token survives", () => {
    expect(
      resolveScopedWorkerRequest({
        mode: "paths",
        pathTokenCount: 0,
        configuredWorkers: CONFIGURED_WORKERS,
      }),
    ).toBe(1);
  });
});
