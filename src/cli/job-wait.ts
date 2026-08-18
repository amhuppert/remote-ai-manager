import {
  EXIT_OPERATION_FAILED,
  failure,
  type CliHost,
  type CliResult,
  type FailureInput,
} from "./shared";

/**
 * One owner for the "block until a server-side job finishes" policy
 * (docs/design/cc-cli/09 §5). A `--wait` loop is not a poll: it is a budget, a
 * parse-failure tolerance, a continuation command, and — for commands holding a
 * server-side lease — a cancellation path. Hand-rolling it per command is how
 * the four call sites drifted into four different contracts, one of which
 * converted an unreadable status body into an endless poll.
 *
 * A command supplies only what it alone knows: how to fetch its status, what
 * counts as terminal, and what to say when the budget runs out.
 */

/** Poll cadence when a spec names none. */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Consecutive unreadable status bodies tolerated before the wait fails. A
 * single blip is a transient the next poll clears; a streak means the CLI and
 * the server disagree about the response shape, and continuing to poll turns
 * that disagreement into a silent hang.
 */
const DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES = 3;

export type JobPollResult<S> =
  | { ok: true; status: S }
  | { ok: false; parseError: string };

export type JobClassification =
  | { terminal: false }
  | { terminal: true; result: CliResult };

export interface JobWaitSpec<S> {
  /**
   * Fetch one status. `parseError` is reserved for a body the command cannot
   * read — it is the channel the waiter counts. Every other refusal (404, auth,
   * connection) is a status the command's own `classify` terminates on, so its
   * exit class survives untouched.
   *
   * `remainingBudgetMs` is what is left of the wait when this poll starts: a
   * long-poll must cap its own transport deadline with it, or the request
   * outlives the budget the caller asked for.
   */
  poll(remainingBudgetMs: number): Promise<JobPollResult<S>>;
  classify(status: S): JobClassification;
  /** Client-side budget; the job itself is unbounded by it. */
  timeoutMs: number;
  /** MUST name the continuation command that recovers the still-running job. */
  onTimeout(elapsedMs: number): FailureInput;
  /** Transcript/db/log pointers appended to any failure the waiter authors. */
  forensics?(last: S | null): string[];
  /** Termination hook for a command that owns a cancellable server-side run. */
  onAbort?(signal: string): Promise<CliResult>;
  pollIntervalMs?: number;
  maxConsecutiveParseFailures?: number;
  /** Output mode for the failures the waiter authors, per `FailureInput`. */
  json: boolean;
}

/**
 * Attach forensic pointers to a failure so text and JSON carry the same facts:
 * stderr detail lines, and a `details.forensics` array for `--json` readers.
 * Exported so a command's own terminal failure can carry them in the same
 * shape the waiter uses.
 */
export function withForensics(
  input: FailureInput,
  lines: string[],
): FailureInput {
  if (lines.length === 0) return input;
  return {
    ...input,
    detail: [...(input.detail ? [input.detail] : []), ...lines].join("\n"),
    details: { ...(input.details ?? {}), forensics: lines },
  };
}

export async function awaitJob<S>(
  host: CliHost,
  spec: JobWaitSpec<S>,
): Promise<CliResult> {
  const now = host.now ?? Date.now;
  const pollIntervalMs = Math.max(
    1,
    spec.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const maxParseFailures = Math.max(
    1,
    spec.maxConsecutiveParseFailures ?? DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES,
  );

  let remainingBudgetMs = Math.max(0, spec.timeoutMs);
  let consecutiveParseFailures = 0;
  let lastStatus: S | null = null;
  let interrupted: string | null = null;

  const waiterFailure = (input: FailureInput): CliResult =>
    failure(withForensics(input, spec.forensics?.(lastStatus) ?? []));

  const abort = spec.onAbort;
  const removeSignalListener = abort
    ? host.onSignal?.((signal) => {
        interrupted = signal;
      })
    : undefined;

  try {
    for (;;) {
      const signal: string | null = interrupted;
      if (abort && signal !== null) return abort(signal);

      if (remainingBudgetMs === 0) {
        return waiterFailure(
          spec.onTimeout(spec.timeoutMs - remainingBudgetMs),
        );
      }

      const pollStartedAt = now();
      const polled = await spec.poll(remainingBudgetMs);
      remainingBudgetMs = Math.max(
        0,
        remainingBudgetMs - Math.max(0, now() - pollStartedAt),
      );

      if (polled.ok) {
        consecutiveParseFailures = 0;
        lastStatus = polled.status;
        const classified = spec.classify(polled.status);
        if (classified.terminal) return classified.result;
      } else {
        consecutiveParseFailures += 1;
        if (consecutiveParseFailures >= maxParseFailures) {
          return waiterFailure({
            exitCode: EXIT_OPERATION_FAILED,
            message: polled.parseError,
            json: spec.json,
          });
        }
      }

      // Charge at least the intended interval: an injected instant `sleep` must
      // spend the budget at the same rate a real one does, or a wait with a
      // fake clock never terminates.
      const sleepMs = Math.min(pollIntervalMs, remainingBudgetMs);
      const sleepStartedAt = now();
      await host.sleep(sleepMs);
      remainingBudgetMs = Math.max(
        0,
        remainingBudgetMs - Math.max(sleepMs, now() - sleepStartedAt),
      );
    }
  } finally {
    removeSignalListener?.();
  }
}
