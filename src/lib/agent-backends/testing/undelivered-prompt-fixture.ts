/**
 * Test-only fixture: constructs the exact error the Claude adapter throws when
 * a prompt never reached the backend before the QuerySession ended. The error
 * carries both the neutral delivery-safety mark (so the retry wrapper's
 * `isPromptNotDeliveredFailure` guard passes) and the `promptNotDelivered`
 * code (so the descriptor's failure classifier returns `retryable: true`) —
 * the two independent facts an undelivered-prompt retry requires. Lives inside
 * the backend seam (like `codex-stale-resume-fixture`) so integration tests
 * above the seam reproduce the adapter's real failure without deep-importing
 * its internals. Never runs in production.
 */

import {
  QUERY_SESSION_ERROR_CODES,
  tagQuerySessionError,
} from "../claude/query-session-errors";

export function makeUndeliveredPromptFailure(
  message = "QuerySession ended before prompt delivery",
): Error {
  return tagQuerySessionError(
    new Error(message),
    QUERY_SESSION_ERROR_CODES.promptNotDelivered,
  );
}
