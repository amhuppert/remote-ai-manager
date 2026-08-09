import { describe, expect, it } from "vitest";
import { resolveWorkerBudget } from "./worker-budget.mjs";

const GB = 1024 ** 3;

/** The heap both the vitest config and the validation launcher size against. */
const WORKER_HEAP_MB = 1536;

describe("resolveWorkerBudget", () => {
  it("reserves coordinator memory before bounding workers by RAM", () => {
    // The 55% budget holds five 1.5 GB Node heaps. One belongs to the Vitest
    // coordinator, leaving four worker heaps.
    expect(
      resolveWorkerBudget({
        workerHeapMb: WORKER_HEAP_MB,
        totalMemoryBytes: 16 * GB,
        availableParallelism: 16,
      }),
    ).toBe(4);
  });

  it("bounds parallelism by core count when RAM is plentiful", () => {
    expect(
      resolveWorkerBudget({
        workerHeapMb: WORKER_HEAP_MB,
        totalMemoryBytes: 128 * GB,
        availableParallelism: 8,
      }),
    ).toBe(8);
  });

  it("keeps a two-worker floor on a machine whose RAM affords fewer", () => {
    expect(
      resolveWorkerBudget({
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
        workerHeapMb: WORKER_HEAP_MB,
        totalMemoryBytes: 16 * GB,
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
        workerHeapMb: WORKER_HEAP_MB * 2,
        totalMemoryBytes: 16 * GB,
        availableParallelism: 16,
      }),
    ).toBe(2);
  });
});
