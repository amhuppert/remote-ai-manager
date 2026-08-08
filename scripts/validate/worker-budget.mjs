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

/** Fraction of total RAM the worker fleet may budget for its heaps. */
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
 * @param {number} input.workerHeapMb Per-worker heap cap, in MB.
 * @param {number} input.totalMemoryBytes Total machine RAM, `os.totalmem()`.
 * @param {number} input.availableParallelism `os.availableParallelism()`.
 * @returns {number} Workers to run.
 */
export function resolveWorkerBudget({
  requestedWorkers,
  workerHeapMb,
  totalMemoryBytes,
  availableParallelism,
}) {
  const affordableWorkers = Math.floor(
    ((totalMemoryBytes / BYTES_PER_GB) * RAM_BUDGET_FRACTION) /
      (workerHeapMb / 1024),
  );
  const ceiling = Math.max(
    MIN_WORKERS,
    Math.min(availableParallelism, affordableWorkers),
  );
  if (requestedWorkers === undefined) return ceiling;
  return Math.max(1, Math.min(requestedWorkers, ceiling));
}
