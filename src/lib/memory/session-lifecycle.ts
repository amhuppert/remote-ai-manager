import type { MemoryProjectSessionRef } from "./schemas";

/**
 * Whether a session incarnation is OVER: the one question the memory domain
 * asks of the session lifecycle (spec R10).
 *
 * Promotion candidacy is DERIVED from this rather than stored, so it cannot
 * drift from the lifecycle it describes. "Over" deliberately includes an
 * incarnation whose row is gone or whose name a later session has taken —
 * those notes are orphaned, which is precisely when a promotion decision is
 * still owed, so candidacy must not evaporate with the row.
 */
export interface MemorySessionIncarnationState {
  readonly createdAt: string;
  readonly finished: boolean;
}

export interface MemorySessionLifecycleDeps {
  findSession(
    projectPath: string,
    sessionName: string,
  ): Promise<MemorySessionIncarnationState | null>;
}

export interface MemorySessionLifecycleReader {
  isSessionIncarnationOver(ref: MemoryProjectSessionRef): Promise<boolean>;
}

export function createMemorySessionLifecycleReader(
  deps: MemorySessionLifecycleDeps,
): MemorySessionLifecycleReader {
  return {
    /**
     * Only one state means "still running": the exact incarnation is present
     * and unfinished. Absence is over, not unknown — a session row that is
     * gone, or replaced by a later session of the same name, describes an
     * incarnation that certainly is not running.
     */
    async isSessionIncarnationOver(ref) {
      const session = await deps.findSession(ref.projectPath, ref.sessionName);
      if (session === null || session.createdAt !== ref.sessionCreatedAt) {
        return true;
      }
      return session.finished;
    },
  };
}
