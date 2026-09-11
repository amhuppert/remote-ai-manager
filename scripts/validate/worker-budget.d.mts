/**
 * Types for `worker-budget.mjs`. The implementation is plain ESM because the
 * validation launcher runs under bare `node`, with no TypeScript loader.
 */
export declare const TEST_WORKERS: number;
export declare const WORKER_FOOTPRINT_MB: number;
export declare const COORDINATOR_FOOTPRINT_MB: number;

export declare function resolveWorkerBudget(input: {
  requestedWorkers?: number;
  coordinatorFootprintMb: number;
  workerFootprintMb: number;
  totalMemoryBytes: number;
  availableParallelism: number;
}): number;

export declare function resolveScopedWorkerRequest(input: {
  mode: "full" | "changed" | "related" | "paths";
  pathTokenCount: number;
  configuredWorkers: number;
}): number;
