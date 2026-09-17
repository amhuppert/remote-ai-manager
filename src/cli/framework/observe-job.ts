import { milliseconds, type Failure } from "cli-for-agents";
import type { Host } from "cli-for-agents/runtime";
import type { CcErrorCode } from "./context";
import { ccErrors } from "./family";

export type JobObservationPoll<T> =
  | { readonly kind: "pending" }
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "invalid" }
  | { readonly kind: "failure"; readonly failure: Failure<never, CcErrorCode> };

export type JobObservation<T> =
  | Exclude<JobObservationPoll<T>, { kind: "pending" }>
  | { readonly kind: "timeout" }
  | {
      readonly kind: "cancelled";
      readonly failure?: Failure<never, CcErrorCode>;
    };

export interface JobObserverOptions<T> {
  readonly clock: Pick<Host, "now" | "sleep">;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly maxInvalidResponses?: number;
  poll(input: { remainingMs: number }): Promise<JobObservationPoll<T>>;
  onCancel?(): Promise<Failure<never, CcErrorCode> | void>;
}

export async function observeJob<T>(
  options: JobObserverOptions<T>,
): Promise<JobObservation<T>> {
  const interval = Math.max(1, options.intervalMs ?? 1_000);
  const maxInvalid = Math.max(1, options.maxInvalidResponses ?? 3);
  let remainingMs = Math.max(0, options.timeoutMs);
  let invalidResponses = 0;
  const unexpected = (message: string): Failure<never, CcErrorCode> => ({
    ok: false,
    error: ccErrors.error("CC_OPERATION_FAILED", { message }),
  });
  const cancelled = async (): Promise<JobObservation<T>> => {
    try {
      const failure = await options.onCancel?.();
      return { kind: "cancelled", ...(failure ? { failure } : {}) };
    } catch {
      return {
        kind: "cancelled",
        failure: unexpected(
          "The cancellation request failed unexpectedly; inspect the durable job state.",
        ),
      };
    }
  };
  const interrupted = Symbol("interrupted");
  for (;;) {
    if (options.signal.aborted) return cancelled();
    if (remainingMs === 0) return { kind: "timeout" };
    const started = options.clock.now();
    let onAbort: (() => void) | undefined;
    const abort = new Promise<typeof interrupted>((resolve) => {
      onAbort = () => resolve(interrupted);
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
    let polled: JobObservationPoll<T> | typeof interrupted;
    try {
      polled = await Promise.race([options.poll({ remainingMs }), abort]);
    } catch {
      if (options.signal.aborted) return cancelled();
      return {
        kind: "failure",
        failure: unexpected(
          "Job polling failed unexpectedly; inspect the durable job state.",
        ),
      };
    } finally {
      if (onAbort) options.signal.removeEventListener("abort", onAbort);
    }
    if (polled === interrupted || options.signal.aborted) return cancelled();
    const elapsed = Math.max(0, options.clock.now() - started);
    remainingMs = Math.max(0, remainingMs - elapsed);
    if (polled.kind === "done" || polled.kind === "failure") return polled;
    invalidResponses = polled.kind === "invalid" ? invalidResponses + 1 : 0;
    if (invalidResponses >= maxInvalid) return { kind: "invalid" };
    const sleepMs = Math.min(Math.max(0, interval - elapsed), remainingMs);
    if (sleepMs > 0) {
      const sleepStarted = options.clock.now();
      try {
        await options.clock.sleep(milliseconds(sleepMs), options.signal);
      } catch {
        if (options.signal.aborted) return cancelled();
        return {
          kind: "failure",
          failure: unexpected(
            "The observation clock failed; inspect the durable job state.",
          ),
        };
      }
      remainingMs = Math.max(
        0,
        remainingMs - Math.max(sleepMs, options.clock.now() - sleepStarted),
      );
    }
  }
}

export function waitDurationMs(value: string): number | null {
  const matched = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!matched) return null;
  const unit = matched[2];
  const result =
    Number(matched[1]) *
    (unit === "ms"
      ? 1
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 1_000);
  return Number.isSafeInteger(result) ? result : null;
}
