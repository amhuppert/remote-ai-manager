import type { StateMigration } from "./types";

/**
 * Collapse the retired session creation modes onto `normal`. The creation-mode
 * enum no longer carries `fast` (renamed to `normal`) or `focus` (removed); the
 * informational post-creation `focus` value is mapped too so stale rows stay
 * readable instead of tripping the read-validation quarantine. This is enum
 * value hygiene only — no alignment state is derived from old focus sessions and
 * no other session data is touched. Idempotent: the predicate matches nothing on
 * a second run, so a crash-before-ledger replay converges.
 */
export const fastToNormal: StateMigration = {
  name: "0004-fast-to-normal",
  up: async ({ context }) => {
    context.db
      .prepare(
        `UPDATE sessions SET creation_mode = 'normal'
          WHERE creation_mode IN ('fast', 'focus')`,
      )
      .run();
  },
};
