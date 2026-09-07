import { createLogger } from "@/lib/logging";

const logger = createLogger("agent-backends.runtime-shutdown");

/** The signal registration this hook needs, narrowed so tests can supply it. */
export interface ShutdownSignalSource {
  once(
    signal: "SIGINT" | "SIGTERM",
    listener: () => void | Promise<void>,
  ): void;
}

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Closes every registered conversation runtime when the server is signalled.
 *
 * Next.js exposes no shutdown counterpart to `register` (see its
 * instrumentation reference), and Command Center runs under `next start` with
 * no custom server, so a process signal is the only place this can hang.
 *
 * Deliberately does NOT call `process.exit`: `next start` installs its own
 * SIGINT/SIGTERM handling to drain in-flight requests, and forcing an exit here
 * would truncate that. The consequence is that this close is best-effort — if
 * the runtime shuts the process down before the awaited teardown settles, the
 * remaining runtimes die with the parent instead of closing in order. Backends
 * whose work outlives the server must not rely on this alone; the Cursor worker,
 * for instance, self-terminates on parent death within a bounded interval.
 *
 * The listener nonetheless awaits the close rather than detaching it. Node does
 * not await a signal listener, so awaiting buys nothing from `process` itself;
 * it makes the teardown observable to any caller that supplies its own source,
 * and keeps "the handler is still running" true for exactly as long as a
 * runtime is still closing.
 */
export function installRuntimeShutdownHook(
  drainConversations: () => Promise<void>,
  source: ShutdownSignalSource = process,
): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    source.once(signal, async () => {
      try {
        await drainConversations();
        logger.info("runtime_shutdown.closed", { signal });
      } catch (err: unknown) {
        logger.error("runtime_shutdown.failed", {
          signal,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
}
