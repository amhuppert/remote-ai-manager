/**
 * Every bounded interval in the Cursor worker's life (spec D1, D3, D9).
 *
 * They live in one module because both ends read them: the supervisor states
 * the worker's lifetime bounds in the `init` frame, and the worker applies them
 * once it has one — but a worker whose parent dies before `init` arrives still
 * has to reap itself, so the same constants are its pre-handshake defaults.
 * Split across two files they would drift, and a drifted bound is an orphan
 * process.
 */

/**
 * Conversation idle eviction, following Claude's `DEFAULT_IDLE_TTL_MS`
 * five-minute precedent (`claude/query-session.ts`). No framework sweeper
 * exists, so this adapter owns the bound on both sides: the supervisor reaps,
 * and the worker self-terminates if the supervisor never does.
 */
export const CURSOR_WORKER_IDLE_TTL_MS = 5 * 60 * 1000;

/**
 * How often the worker checks that its parent is still alive. IPC disconnect
 * covers the ordinary parent death; this poll covers the cases where the
 * channel outlives the process that owns it.
 */
export const CURSOR_WORKER_PARENT_POLL_INTERVAL_MS = 1_000;

/**
 * The worker's own teardown window: how long cancellation and disposal may each
 * take before it signals its process group, and how long the group has after SIGTERM
 * before SIGKILL. Deliberately short — this path only runs when the parent is
 * already gone, so there is nobody left to report progress to.
 */
export const CURSOR_WORKER_TERMINATION_GRACE_MS = 2_000;

/**
 * Per-turn inactivity bound. A run that forwards no frame for this long is
 * presumed hung and settles as a bounded typed stall failure rather than
 * holding the conversation open indefinitely. Matches Codex's 20-minute
 * conversation stall bound: the longest legitimate quiet gap on either backend
 * is a single long shell tool call, and both run the same host commands.
 */
export const CURSOR_TURN_STALL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Cancellation settlement bound. After the native cancel is sent, the turn
 * waits this long for the worker's own settlement before resolving aborted on
 * its own — one terminal outcome either way, never an open promise.
 */
export const CURSOR_CANCEL_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Billed-usage fetch bound. The worker asks the provider for billed usage once
 * after each turn settles and on the parent's demand; a fetch that has not
 * answered inside this window is reported as failed so a slow billing service
 * can delay a turn's settlement by at most this much and never hold it open.
 */
export const CURSOR_BILLING_QUERY_TIMEOUT_MS = 10_000;

/**
 * Late-settlement re-fetch schedule, parent side. After a turn whose billed
 * cost had not landed, the runtime asks again at these delays while its worker
 * is alive; the list's length is the bound on attempts per turn. Provider cost
 * is documented as lagging "briefly", so the schedule front-loads.
 */
export const CURSOR_BILLING_RETRY_DELAYS_MS: readonly number[] = [
  5_000, 20_000, 60_000,
];

/**
 * Task-path settlement window. A task closes its runtime right after the turn
 * and would never see a late settlement, so when the provider has not priced
 * the turn yet the runner waits, polling at these delays, for at most the
 * timeout. Past it the task's cost stays unknown — never estimated.
 */
export const CURSOR_TASK_BILLING_SETTLE_TIMEOUT_MS = 12_000;
export const CURSOR_TASK_BILLING_SETTLE_DELAYS_MS: readonly number[] = [
  2_000, 4_000, 6_000,
];

/**
 * Credential verification bound (D3 layer 2): `Cursor.me` must answer inside
 * this window or the worker reports a bounded timeout rather than hanging the
 * handshake.
 */
export const CURSOR_CREDENTIAL_PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * How long the worker waits for the credential frame after `init` before
 * reporting a missing credential. The supervisor sends it immediately, so this
 * only fires when the parent stalled or died mid-handshake.
 */
export const CURSOR_WORKER_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Supervisor-side spawn-to-ready bound: process start, SDK load, and credential
 * verification together. Larger than the credential bound it contains, because
 * the SDK's lazy chunks load first.
 */
export const CURSOR_SUPERVISOR_READY_TIMEOUT_MS = 45_000;

export const CURSOR_ATTACH_TIMEOUT_MS = 45_000;

/**
 * Teardown ladder rungs (D9). Native cancellation first, then disposal and an
 * orderly exit, then the ownership-guarded process-group escalation.
 */
export const CURSOR_TEARDOWN_CANCEL_GRACE_MS = 10_000;
export const CURSOR_TEARDOWN_EXIT_GRACE_MS = 10_000;
export const CURSOR_TEARDOWN_TERM_GRACE_MS = 5_000;
export const CURSOR_TEARDOWN_KILL_CONFIRM_MS = 5_000;

/** Poll interval for every "is this process group gone yet" probe loop. */
export const CURSOR_TEARDOWN_PROBE_INTERVAL_MS = 50;
