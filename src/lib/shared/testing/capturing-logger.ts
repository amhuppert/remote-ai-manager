import type { Logger, LogLevel } from "@/lib/logging";

export interface CapturedLogEntry {
  level: LogLevel;
  message: string;
  fields: Record<string, unknown>;
}

export interface CapturingLogger extends Logger {
  readonly entries: readonly CapturedLogEntry[];
  /** Every field VALUE emitted so far, flattened — what a log reader would see. */
  allFieldValues(): unknown[];
}

/**
 * A `Logger` that records what production code actually emitted.
 *
 * Structured-log fields are a public identity surface (R1.3): a value that must
 * not escape internal adapters must not appear here either. The module-level
 * logger writes to a file sink with no injectable seam, so a leak into a log
 * field is invisible to tests unless the sink is a dependency — which is why
 * handlers under that requirement take their logger through deps.
 */
export function createCapturingLogger(): CapturingLogger {
  const entries: CapturedLogEntry[] = [];
  const record =
    (level: LogLevel) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, fields: fields ?? {} });
    };

  return {
    entries,
    allFieldValues() {
      return entries.flatMap((entry) => Object.values(entry.fields));
    },
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}
