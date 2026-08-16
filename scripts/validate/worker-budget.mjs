/**
 * How many test workers this machine can actually hold.
 *
 * Worker parallelism is bounded by RAM, not by core count. Vitest's forks pool
 * spawns one full Node process per worker with no heap cap of its own; on a
 * high-core / low-RAM machine that fans out to N heavyweight processes at once,
 * which can exhaust RAM and swap during a full-suite run.
 *
 * This is the ONE owner of that budget. Both the vitest config (which sets the
 * default) and the validation launcher (which asks for a fixed worker count)
 * resolve through it. The launcher used to hard-code its count, so the busiest
 * run on the machine — validation — was the one path that ignored the budget;
 * a caller can now ask for less than the ceiling but never for more.
 */

/** Fraction of total RAM the Vitest process fleet may budget for its heaps. */
const RAM_BUDGET_FRACTION = 0.55;

/**
 * Floor for the RAM-derived ceiling. Below two workers a full-suite run takes
 * long enough to be its own problem, and a machine that cannot hold two is one
 * the suite cannot be run on at all.
 */
const MIN_WORKERS = 2;

const BYTES_PER_GB = 1024 ** 3;

/**
 * @param {object} input
 * @param {number} [input.requestedWorkers] Worker count the caller asked for.
 *   Treated as a request, not an instruction: it is clamped DOWN to the
 *   machine's ceiling and never raised up to it.
 * @param {number} input.coordinatorHeapMb Coordinator heap cap, in MB.
 * @param {number} input.workerHeapMb Per-worker heap cap, in MB.
 * @param {number} input.totalMemoryBytes Total machine RAM, `os.totalmem()`.
 * @param {number} input.availableParallelism `os.availableParallelism()`.
 * @returns {number} Workers to run.
 */
export function resolveWorkerBudget({
  requestedWorkers,
  coordinatorHeapMb,
  workerHeapMb,
  totalMemoryBytes,
  availableParallelism,
}) {
  const workerBudgetMb =
    (totalMemoryBytes / BYTES_PER_GB) * 1024 * RAM_BUDGET_FRACTION -
    coordinatorHeapMb;
  const affordableWorkers = Math.floor(workerBudgetMb / workerHeapMb);
  const ceiling = Math.max(
    MIN_WORKERS,
    Math.min(availableParallelism, affordableWorkers),
  );
  if (requestedWorkers === undefined) return ceiling;
  return Math.max(1, Math.min(requestedWorkers, ceiling));
}

/**
 * How many workers a run may ASK for, given the scope it was admitted under.
 *
 * A `paths` run is charged `base + perPath * tokens` by the validation
 * scheduler, while path tokens reach Vitest as substring filters: one token
 * such as `src/lib` can select hundreds of files. Running the wrapper's whole
 * fork pool for a one-token run would therefore oversubscribe RAM beside other
 * work admitted against that cheap price. Clamping the request to the token
 * count makes the declared price true by construction — a broad filter runs
 * slower on fewer forks instead of exceeding what it paid for.
 *
 * @param {object} input
 * @param {"full" | "changed" | "paths"} input.mode Scope the launcher runs.
 * @param {number} input.pathTokenCount Path tokens forwarded in `paths` mode.
 * @param {number} input.configuredWorkers Wrapper-owned pool size.
 * @returns {number} Workers to request from the machine budget.
 */
export function resolveScopedWorkerRequest({
  mode,
  pathTokenCount,
  configuredWorkers,
}) {
  if (mode !== "paths") return configuredWorkers;
  return Math.max(1, Math.min(pathTokenCount, configuredWorkers));
}
