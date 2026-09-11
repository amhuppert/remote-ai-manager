import { describe, expect, it } from "vitest";
import {
  resolveScopedWorkerRequest,
  resolveWorkerBudget,
} from "./worker-budget.mjs";

const GB = 1024 ** 3;

/**
 * The measured resident footprints both the vitest config and the validation
 * launcher size against (2026-09-11 full-suite samples with headroom): a fork
 * peaks near 0.67 GB and the coordinator near 1.1 GB. Heap caps stay separate
 * as per-process runaway guards and no longer drive the count.
 */
const WORKER_FOOTPRINT_MB = 768;
const COORDINATOR_FOOTPRINT_MB = 1280;

describe("resolveWorkerBudget", () => {
  it("budgets the coordinator footprint separately from worker footprints", () => {
    // The coordinator retains the full task graph and is larger than a fork.
    // The remaining 55% RAM budget on a 16 GB host holds ten forks, so the
    // measured four-fork request is never clamped there.
    expect(
      resolveWorkerBudget({
        coordinatorFootprintMb: COORDINATOR_FOOTPRINT_MB,
        workerFootprintMb: WORKER_FOOTPRINT_MB,
        totalMemoryBytes: 16 * GB,
        availableParallelism: 16,
      }),
    ).toBe(10);
  });

  it("bounds parallelism by core count when RAM is plentiful", () => {
    expect(
      resolveWorkerBudget({
        coordinatorFootprintMb: COORDINATOR_FOOTPRINT_MB,
        workerFootprintMb: WORKER_FOOTPRINT_MB,
        totalMemoryBytes: 128 * GB,
        availableParallelism: 8,
      }),
    ).toBe(8);
  });

  it("keeps a two-worker floor on a machine whose RAM affords fewer", () => {
    expect(
      resolveWorkerBudget({
        coordinatorFootprintMb: COORDINATOR_FOOTPRINT_MB,
        workerFootprintMb: WORKER_FOOTPRINT_MB,
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
        coordinatorFootprintMb: COORDINATOR_FOOTPRINT_MB,
        workerFootprintMb: WORKER_FOOTPRINT_MB,
        totalMemoryBytes: 8 * GB,
        availableParallelism: 16,
      }),
    ).toBe(4);
  });

  it("honours a caller that asks for fewer workers than the budget allows", () => {
    // Clamping is one-directional: the budget is a ceiling, not a target, so a
    // caller that deliberately runs small is never inflated to fill it.
    expect(
      resolveWorkerBudget({
        requestedWorkers: 3,
        coordinatorFootprintMb: COORDINATOR_FOOTPRINT_MB,
        workerFootprintMb: WORKER_FOOTPRINT_MB,
        totalMemoryBytes: 128 * GB,
        availableParallelism: 16,
      }),
    ).toBe(3);
  });

  it("never returns less than one worker for an unusable request", () => {
    expect(
      resolveWorkerBudget({
        requestedWorkers: 0,
        coordinatorFootprintMb: COORDINATOR_FOOTPRINT_MB,
        workerFootprintMb: WORKER_FOOTPRINT_MB,
        totalMemoryBytes: 128 * GB,
        availableParallelism: 16,
      }),
    ).toBe(1);
  });

  it("shrinks the ceiling as the per-worker footprint grows", () => {
    // Same machine, twice the footprint per worker, so half the workers fit.
    expect(
      resolveWorkerBudget({
        coordinatorFootprintMb: COORDINATOR_FOOTPRINT_MB,
        workerFootprintMb: WORKER_FOOTPRINT_MB * 2,
        totalMemoryBytes: 16 * GB,
        availableParallelism: 16,
      }),
    ).toBe(5);
  });
});

/** Worker count the `test` wrapper asks for on this machine. */
const CONFIGURED_WORKERS = 4;

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
        pathTokenCount: 3,
        configuredWorkers: CONFIGURED_WORKERS,
      }),
    ).toBe(3);
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

  it("leaves changed runs at the configured pool", () => {
    // Changed scope is charged the wrapper's full weight and may use the whole
    // pool because it covers a bounded dependency slice rather than the whole
    // corpus.
    expect(
      resolveScopedWorkerRequest({
        mode: "changed",
        pathTokenCount: 0,
        configuredWorkers: CONFIGURED_WORKERS,
      }),
    ).toBe(CONFIGURED_WORKERS);
  });

  it("leaves full runs at the configured pool", () => {
    // Full scope measured fastest at the same four forks the wrapper configures
    // (2026-09-11: 12.6 min at four against 15.4 min at three, no gain at six),
    // so nothing below the configured pool is reserved for the coordinator.
    expect(
      resolveScopedWorkerRequest({
        mode: "full",
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
