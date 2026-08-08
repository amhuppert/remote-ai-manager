/**
 * Types for `worker-budget.mjs`. The implementation is plain ESM because the
 * validation launcher runs under bare `node`, with no TypeScript loader.
 */
export declare function resolveWorkerBudget(input: {
  requestedWorkers?: number;
  workerHeapMb: number;
  totalMemoryBytes: number;
  availableParallelism: number;
}): number;
