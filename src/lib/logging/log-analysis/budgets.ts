import { z } from "zod";
import type { ParsedServerLogRecord } from "./types";

/**
 * Performance budgets as code (Design 6.3). A checked-in config declares the
 * ceilings the audit calibrated; the analyzer reports violations advisory-only
 * by default and, under `--assert-budgets`, exits non-zero. The two-week silent
 * 5× degradation this audit found becomes a same-week red number.
 *
 * The checked-in config lives at `scripts/log-budgets.json` beside the CLI
 * entry; this schema is its contract, and `DEFAULT_BUDGET_CONFIG` is the
 * baked-in fallback so the analyzer always has budgets even if the file is
 * missing. The numbers are calibration starting points (decision point 3),
 * meant to be tuned as telemetry accrues.
 */
export const budgetConfigSchema = z
  .object({
    /** Per-route-class p95 ceiling (method+path bucket), ms. */
    routeClassP95Ms: z.number().nonnegative(),
    /** Write-queue hold ceiling, ms — matches the runtime hold budget. */
    writeQueueHoldMs: z.number().nonnegative(),
    /** state.read accessor p95 ceiling, ms. */
    stateReadMs: z.number().nonnegative(),
    /** Serialized row-size ceiling, bytes. */
    rowSizeBytes: z.number().nonnegative(),
  })
  .strict();

export type BudgetConfig = z.infer<typeof budgetConfigSchema>;

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  routeClassP95Ms: 1000,
  writeQueueHoldMs: 500,
  stateReadMs: 100,
  rowSizeBytes: 262144,
};

/** Parse and validate a raw budget config (throws on a malformed shape). */
export function parseBudgetConfig(raw: unknown): BudgetConfig {
  return budgetConfigSchema.parse(raw);
}

export type BudgetViolationKind =
  | "route-p95"
  | "write-queue-hold"
  | "state-read"
  | "row-size";

export interface BudgetViolation {
  kind: BudgetViolationKind;
  subject: string;
  observed: number;
  ceiling: number;
  unit: "ms" | "bytes";
}

export interface BudgetEvaluationInput {
  config: BudgetConfig;
  routeP95s: readonly { key: string; p95Ms: number | null }[];
  writeQueueHolds: readonly { label: string; maxHoldMs: number | null }[];
  stateReadP95s: readonly { accessor: string; p95Ms: number | null }[];
  rowSizes: readonly { subject: string; bytes: number }[];
}

function rawString(
  record: ParsedServerLogRecord,
  key: string,
): string | undefined {
  const value = record.raw[key];
  return typeof value === "string" ? value : undefined;
}

function rawNumber(
  record: ParsedServerLogRecord,
  key: string,
): number | undefined {
  const value = record.raw[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Row-size samples from `state-store.row_size.exceeded` events (Design 1's
 * row-size telemetry). Absent until a repo emits them, in which case budget
 * evaluation simply sees no row-size samples.
 */
export function extractRowSizeEvents(
  records: readonly ParsedServerLogRecord[],
): { subject: string; bytes: number }[] {
  const samples: { subject: string; bytes: number }[] = [];
  for (const record of records) {
    if (record.message !== "state-store.row_size.exceeded") continue;
    const bytes = rawNumber(record, "bytes");
    if (bytes === undefined) continue;
    const table = rawString(record, "table") ?? "unknown";
    const column = rawString(record, "column") ?? "unknown";
    const id = rawString(record, "id") ?? "unknown";
    samples.push({ subject: `${table}.${column}#${id}`, bytes });
  }
  return samples;
}

export function evaluateBudgets(
  input: BudgetEvaluationInput,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];

  for (const route of input.routeP95s) {
    if (route.p95Ms !== null && route.p95Ms > input.config.routeClassP95Ms) {
      violations.push({
        kind: "route-p95",
        subject: route.key,
        observed: route.p95Ms,
        ceiling: input.config.routeClassP95Ms,
        unit: "ms",
      });
    }
  }

  for (const hold of input.writeQueueHolds) {
    if (
      hold.maxHoldMs !== null &&
      hold.maxHoldMs > input.config.writeQueueHoldMs
    ) {
      violations.push({
        kind: "write-queue-hold",
        subject: hold.label,
        observed: hold.maxHoldMs,
        ceiling: input.config.writeQueueHoldMs,
        unit: "ms",
      });
    }
  }

  for (const accessor of input.stateReadP95s) {
    if (accessor.p95Ms !== null && accessor.p95Ms > input.config.stateReadMs) {
      violations.push({
        kind: "state-read",
        subject: accessor.accessor,
        observed: accessor.p95Ms,
        ceiling: input.config.stateReadMs,
        unit: "ms",
      });
    }
  }

  for (const row of input.rowSizes) {
    if (row.bytes > input.config.rowSizeBytes) {
      violations.push({
        kind: "row-size",
        subject: row.subject,
        observed: row.bytes,
        ceiling: input.config.rowSizeBytes,
        unit: "bytes",
      });
    }
  }

  return violations;
}
