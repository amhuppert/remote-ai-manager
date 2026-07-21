import type { Logger } from "@/lib/logging";

/**
 * Byte threshold above which a single serialized SQLite TEXT/JSON column is
 * flagged as oversized. 256 KiB (`262144`) — an order of magnitude above the
 * largest healthy blob we persist (a debounced machine snapshot resume token, a
 * bounded MCP/capability runtime map) and well below the multi-MB rows the
 * 2026-07 audit found dragging through every enumeration. A column crossing this
 * is either a growth bug or a blob that belongs in a sidecar/child table; either
 * way we want it as a ranked log finding within days, not a p95 post-mortem two
 * weeks later.
 */
export const ROW_COLUMN_SIZE_WARN_BYTES = 262144;

export interface RowColumnSizeFinding {
  readonly table: string;
  readonly column: string;
  /** Row identity for the log finding (conversation / session / execution id). */
  readonly id: string;
  /** Persisted UTF-8 size of the column value. */
  readonly bytes: number;
  readonly thresholdBytes: number;
}

/**
 * Pure derivation: measure the persisted UTF-8 size of an already-serialized
 * column value and return a finding when it crosses the threshold, else null.
 * Only strings can balloon; non-string binds (numbers, null) and absent columns
 * are ignored. Adds only a length scan — no re-serialization, no parse, no I/O —
 * so it is safe to run inside the SQLite transaction / write-queue critical
 * section (the emission is what must be deferred, see below).
 */
export function deriveRowColumnSizeFinding(
  table: string,
  column: string,
  id: string,
  value: unknown,
): RowColumnSizeFinding | null {
  if (typeof value !== "string") return null;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= ROW_COLUMN_SIZE_WARN_BYTES) return null;
  return {
    table,
    column,
    id,
    bytes,
    thresholdBytes: ROW_COLUMN_SIZE_WARN_BYTES,
  };
}

/**
 * Pure derivation for one bind row: sweep the named columns, flagging each
 * oversized string. Columns absent from `bind` (e.g. a focused per-column
 * update) are skipped.
 */
export function deriveRowColumnSizeFindings({
  table,
  id,
  bind,
  columns,
}: {
  readonly table: string;
  readonly id: string;
  readonly bind: Readonly<Record<string, unknown>>;
  readonly columns: readonly string[];
}): RowColumnSizeFinding[] {
  const findings: RowColumnSizeFinding[] = [];
  for (const column of columns) {
    if (!(column in bind)) continue;
    const finding = deriveRowColumnSizeFinding(table, column, id, bind[column]);
    if (finding) findings.push(finding);
  }
  return findings;
}

/**
 * Emit findings OUTSIDE the caller's synchronous stack.
 *
 * `logger.warn` writes the log line with `appendFileSync` (blocking filesystem
 * I/O). These checks run inside repository upserts, which execute while the
 * global write queue is held and inside a synchronous `better-sqlite3`
 * transaction — so emitting inline would perform filesystem I/O with the write
 * lock held and the event loop blocked, violating the
 * `no-slow-work-in-critical-section` invariant. `setImmediate` runs the warn on
 * a later macrotask, after the synchronous transaction has committed and the
 * write queue's `finally` has released the lock, so all that happens in the
 * critical section is the pure length scan above. Nothing is scheduled when
 * there is no finding (the common case), so a healthy write costs nothing.
 */
function emitAfterCriticalSection(
  logger: Pick<Logger, "warn">,
  findings: readonly RowColumnSizeFinding[],
): void {
  if (findings.length === 0) return;
  setImmediate(() => {
    for (const finding of findings) {
      logger.warn("state-store.row_size.exceeded", {
        table: finding.table,
        column: finding.column,
        id: finding.id,
        bytes: finding.bytes,
        thresholdBytes: finding.thresholdBytes,
      });
    }
  });
}

export interface RowColumnSizeCheck {
  /** Injected so the write-path repo owns the module scope and tests can spy. */
  readonly logger: Pick<Logger, "warn">;
  readonly table: string;
  readonly column: string;
  readonly id: string;
  readonly value: unknown;
}

/**
 * Derive a single-column finding during the write and, if oversized, emit its
 * `warn state-store.row_size.exceeded` after the critical section. Callers may
 * pass a whole changed-column bind without pre-filtering.
 */
export function checkRowColumnSize({
  logger,
  table,
  column,
  id,
  value,
}: RowColumnSizeCheck): void {
  const finding = deriveRowColumnSizeFinding(table, column, id, value);
  emitAfterCriticalSection(logger, finding ? [finding] : []);
}

/**
 * Derive findings for the named columns of one bind row during the write and
 * emit them after the critical section. Use at a repo write site to check every
 * big-JSON column of a row in one call.
 */
export function checkRowColumnSizes({
  logger,
  table,
  id,
  bind,
  columns,
}: {
  readonly logger: Pick<Logger, "warn">;
  readonly table: string;
  readonly id: string;
  readonly bind: Readonly<Record<string, unknown>>;
  readonly columns: readonly string[];
}): void {
  emitAfterCriticalSection(
    logger,
    deriveRowColumnSizeFindings({ table, id, bind, columns }),
  );
}
