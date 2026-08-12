/**
 * Shared literals used by both the Claude task runner and the client-imported
 * descriptor metadata.
 */

/**
 * Default per-turn inactivity bound for Claude turns and task runs. Single
 * source for the descriptor metadata literal and the task runner's fallback
 * when a request carries no explicit `stallTimeoutMs`.
 *
 * Evidence for having a bound at all (execution 2560164c): an unwatched Claude
 * implementer turn recorded no activity for 55 minutes and then failed as a
 * terminal SDK error, costing a 3h22m operator halt.
 *
 * Constraint on the value: a conversation turn that opted into
 * `waitForBackgroundTasks` — every graph-workflow implementer turn does — stays
 * legitimately silent while the settlement barrier holds it open, because
 * background-task notifications reach the SSE activity channel and not the
 * watchdog. The bound must therefore exceed
 * `DEFAULT_BACKGROUND_TASK_WAIT_TIMEOUT_MS` (conversation-runtime.ts), or the
 * abort lands mid-barrier where the turn already carries a result: it reads as
 * a completed turn with no abort reason, the settlement waiter reports no
 * timeout, and the iteration proceeds on unfinished background work.
 * `claude/conversation-runtime.test.ts` pins the ordering of the two numbers.
 */
export const CLAUDE_DEFAULT_STALL_TIMEOUT_MS = 35 * 60 * 1000;
