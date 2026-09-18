export interface RestartReadinessDeps {
  read(signal: AbortSignal): Promise<{ status: number }>;
  now(): number;
  wait(ms: number): Promise<void>;
}
/** Read-only startup observation; never resubmits an interrupted mutation. */
export async function waitForRestartApi(deps: RestartReadinessDeps) {
  const deadline = deps.now() + 10_000;
  for (
    let attempts = 1;
    attempts <= 40 && deps.now() < deadline;
    attempts += 1
  ) {
    let status: number | null = null;
    try {
      status = (
        await deps.read(AbortSignal.timeout(Math.max(1, deadline - deps.now())))
      ).status;
    } catch {
      // Restart can invalidate a pooled socket before the first new API read.
    }
    if (status === 200) return { attempts, status };
    if (status !== null && status >= 400 && status < 500)
      throw new Error(`restarted API refused read: HTTP ${status}`);
    const remaining = deadline - deps.now();
    if (remaining > 0) await deps.wait(Math.min(250, remaining));
  }
  throw new Error("restarted API did not become healthy within 10000ms");
}
