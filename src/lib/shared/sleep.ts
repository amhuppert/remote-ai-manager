/**
 * Resolve after `ms` milliseconds. The one shared setTimeout-promise so the
 * dozens of inline `new Promise((resolve) => setTimeout(resolve, ms))`
 * expressions collapse to a single import.
 *
 * This is a fire-and-forget delay: the returned promise cannot be cancelled
 * and the timer is not `unref`'d. Callers that need cancellation should race
 * this against an abort signal at the call site; callers that must not keep a
 * process alive should use their own `unref`'d timer.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
