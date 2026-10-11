/**
 * The grammar of a lane id: a name safe to splice into a git branch name and a
 * worktree path.
 */

const LANE_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Why `laneId` is unsafe to splice into a git branch name and a filesystem
 * path, or null when it is safe.
 *
 * The reason is RETURNED rather than thrown so definition validation can locate
 * an illegal authored lane name on the context that declared it, while the
 * provisioning callers keep the throwing form below. Lane ids and per-context
 * ids share these constraints — a single-context lane's id is its context id —
 * so this one grammar covers both.
 */
export function laneIdViolation(laneId: string): string | null {
  if (!LANE_ID_PATTERN.test(laneId)) {
    return "must match /^[A-Za-z0-9_.-]+$/";
  }
  if (laneId.startsWith(".") || laneId.startsWith("-")) {
    return "must not start with '.' or '-'";
  }
  if (laneId.includes("..")) {
    return "must not contain '..'";
  }
  if (laneId.endsWith(".") || laneId.endsWith("-")) {
    return "must not end with '.' or '-'";
  }
  if (laneId.endsWith(".lock")) {
    return "must not end with '.lock'";
  }
  return null;
}

/** Throws unless a lane id is safe to splice into a git branch name and a filesystem path. */
export function validateLaneId(laneId: string): void {
  const violation = laneIdViolation(laneId);
  if (violation !== null) {
    throw new Error(`Invalid laneId ${JSON.stringify(laneId)}: ${violation}`);
  }
}
