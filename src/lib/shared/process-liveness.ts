/**
 * Whether a same-host process with `pid` is still alive. `process.kill(pid, 0)`
 * delivers no signal but raises ESRCH when no such process exists; any other
 * failure (e.g. EPERM) proves the process exists, so it counts as alive.
 *
 * Used by the startup sweeps (background jobs, agent runs) to distinguish rows
 * orphaned by a dead worker process from work still live in another worker
 * sharing the same file-backed DB.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ESRCH") {
      return false;
    }
    return true;
  }
}
