/**
 * Per-turn inactivity (stall) watchdog.
 *
 * A turn that produces NO backend activity for `stallTimeoutMs` is presumed
 * hung (incident: a codex model turn that emitted zero thread events for
 * 9h37m while the process stayed alive). The owner of the turn's
 * AbortController creates one watchdog per turn, touches it on every backend
 * event, and cancels it when the turn settles. Unlike a whole-turn timeout,
 * a turn that keeps producing events never trips it — only dead air does.
 *
 * `stallTimeoutMs <= 0` disables the watchdog (mirrors the safety-net
 * timeout's "0 means unbounded" convention).
 */

export interface StallWatchdog {
  /** Record backend activity: resets the inactivity deadline. */
  touch(): void;
  /** True once the stall deadline elapsed and `onStall` ran. */
  fired(): boolean;
  /** Disarm permanently (turn settled). Idempotent. */
  cancel(): void;
}

const DISABLED_WATCHDOG: StallWatchdog = {
  touch: () => {},
  fired: () => false,
  cancel: () => {},
};

export function createStallWatchdog(input: {
  stallTimeoutMs: number;
  onStall: () => void;
}): StallWatchdog {
  if (input.stallTimeoutMs <= 0) return DISABLED_WATCHDOG;

  let fired = false;
  let cancelled = false;
  let handle: ReturnType<typeof setTimeout> | null = null;

  const arm = (): void => {
    handle = setTimeout(() => {
      handle = null;
      fired = true;
      input.onStall();
    }, input.stallTimeoutMs);
  };

  const disarm = (): void => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  };

  arm();

  return {
    touch: () => {
      if (fired || cancelled) return;
      disarm();
      arm();
    },
    fired: () => fired,
    cancel: () => {
      cancelled = true;
      disarm();
    },
  };
}
