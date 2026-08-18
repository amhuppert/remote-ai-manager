import { z } from "zod";
import {
  deriveLoopLedger,
  type LoopLedgerEntry,
} from "@/lib/workflow-graph/loop-ledger";

/**
 * CLI-side loop ledger (D4 R16.2, decision D9).
 *
 * The CLI reads the same two durable sources the inspector does — the
 * execution's loop markers and the cursor-paginated event log — and runs them
 * through the SAME `deriveLoopLedger` projection, so the two surfaces cannot
 * report a different history. Only the derivation is shared: the wire schemas
 * below are the usual deliberately permissive CLI mirrors, so an added server
 * field never breaks the render.
 */

const loopDecisionRecordSchema = z.object({
  loopGroupId: z.string(),
  pass: z.number(),
  loopControlRevision: z.number(),
  templateVersion: z.number(),
  exitContextId: z.string(),
  exitCaptureIteration: z.number().nullable().default(null),
  verdict: z.enum(["satisfied", "unsatisfied", "unevaluable", "exit-skipped"]),
  outcome: z.enum(["concluded", "materialized", "halted"]),
  nextPass: z.number().nullable().default(null),
  decidedAt: z.string(),
});

const loopSlotSchema = z.object({
  pass: z.number(),
  state: z.enum(["reserved", "counted", "released"]),
  grantOrder: z.number(),
  grantedAt: z.string(),
});

/**
 * Exactly the marker fields `deriveLoopLedger` reads, and nothing else.
 *
 * Mirroring a field the projection never consumes buys no safety and costs
 * real correctness: the boundary snapshot, for one, is `null` only before
 * activation and an array of resolved upstream rows after it, so a mirror that
 * pinned the pre-activation shape rejected every normal running loop. Unknown
 * keys are stripped, which is what keeps a server-side addition from breaking
 * the render.
 */
const loopStateSchema = z.object({
  activation: z.enum(["unstarted", "running", "concluded", "skipped"]),
  loopControlRevision: z.number().default(0),
  passCount: z.number().default(0),
  slotLedger: z.array(loopSlotSchema).default([]),
  decisions: z.record(z.string(), loopDecisionRecordSchema).default({}),
  concludingExitContextId: z.string().nullable().default(null),
});

export const ledgerExecutionSchema = z.object({
  execution: z
    .object({
      id: z.string(),
      workingDefinition: z
        .object({
          loopGroups: z
            .array(z.object({ id: z.string(), maxPasses: z.number() }).loose())
            .optional(),
        })
        .loose(),
      loopStates: z.record(z.string(), loopStateSchema).default({}),
    })
    .nullable(),
});
export type LedgerExecution = NonNullable<
  z.infer<typeof ledgerExecutionSchema>["execution"]
>;

const loopDecisionEventSchema = z.object({
  type: z.literal("graph-workflow-loop-decision"),
  loopGroupId: z.string(),
  pass: z.number(),
  loopControlRevision: z.number(),
  templateVersion: z.number(),
  exitContextId: z.string(),
  exitCaptureIteration: z.number().nullable(),
  verdict: z.enum(["satisfied", "unsatisfied", "unevaluable", "exit-skipped"]),
  outcome: z.enum(["concluded", "materialized", "halted"]),
  nextPass: z.number().nullable(),
  decidedAt: z.string(),
});

/**
 * One page of the reader. Rows the ledger does not care about are dropped at the
 * boundary — the CLI walks the whole log, and carrying every unrelated event
 * through the derivation would cost memory for nothing.
 */
export const ledgerEventPageSchema = z.object({
  events: z.array(
    z
      .object({
        seq: z.number(),
        occurredAt: z.string(),
        preReset: z.boolean().default(false),
        event: z.unknown(),
      })
      .loose(),
  ),
  nextCursor: z.number().nullable(),
});

export interface LedgerDecisionRow {
  readonly occurredAt: string;
  readonly event: z.infer<typeof loopDecisionEventSchema>;
  readonly preReset: boolean;
}

/** The loop-decision rows of one page, in the order the page returned them. */
export function selectLedgerDecisionRows(
  page: z.infer<typeof ledgerEventPageSchema>,
): LedgerDecisionRow[] {
  const rows: LedgerDecisionRow[] = [];
  for (const row of page.events) {
    const parsed = loopDecisionEventSchema.safeParse(row.event);
    if (!parsed.success) continue;
    rows.push({
      occurredAt: row.occurredAt,
      preReset: row.preReset,
      event: parsed.data,
    });
  }
  return rows;
}

export function buildLedger(
  execution: LedgerExecution,
  rows: readonly LedgerDecisionRow[],
): LoopLedgerEntry[] {
  return deriveLoopLedger({
    loopStates: execution.loopStates,
    events: rows.map((row) => ({
      occurredAt: row.occurredAt,
      preReset: row.preReset,
      // The derivation reads only the loop-decision fields; the mirror above
      // has already proven every one of them.
      event: {
        ...row.event,
        projectName: "",
        sessionName: "",
        executionId: "",
      },
    })),
    loopGroups: execution.workingDefinition.loopGroups ?? [],
  });
}

/**
 * How far one walk of the event log got.
 *
 * D9 bounds each PAGE, not the history: the default walk runs to exhaustion, so
 * a bounded result is always something the operator asked for (`--max-pages`)
 * or a reader that misbehaved — and in the first case the walk says exactly
 * where to resume, so complete history stays reachable either way.
 */
export interface LedgerWalk {
  readonly complete: boolean;
  /** The cursor a bounded walk continues from; null when resuming is no help. */
  readonly resumeCursor: number | null;
  readonly reason: "complete" | "page-bound" | "reader-stalled" | "unreadable";
}

/**
 * What a short walk left out, in the shared disclosure vocabulary: the fact is
 * primary output and `next:` carries the read that reveals the rest. The walk
 * has no total to count against — the log's length is only known by reaching
 * its end — so the cap is disclosed by naming the resume point instead, and a
 * walk that stopped somewhere it cannot resume from says only that.
 */
function walkLines(walk: LedgerWalk): string[] {
  switch (walk.reason) {
    case "complete":
      return [];
    case "page-bound":
      return [
        "history: the event walk stopped at its page bound — older decisions are not shown",
        ...(walk.resumeCursor === null
          ? []
          : [`next: cctl workflow live ledger --cursor ${walk.resumeCursor}`]),
      ];
    case "reader-stalled":
      return [
        "history: the event reader stopped advancing its cursor — older decisions are not shown",
      ];
    case "unreadable":
      return [
        "history: a page of the event log could not be read — older decisions are not shown",
      ];
  }
}

export function renderLedger(
  entries: readonly LoopLedgerEntry[],
  walk: LedgerWalk,
): string {
  if (entries.length === 0) {
    // A declared group with no persisted state leaves the ledger empty while
    // the walk still ran, so the disclosure belongs here too.
    return `${["this execution declares no loop groups", ...walkLines(walk)].join("\n")}\n`;
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const cap = entry.maxPasses === null ? "" : ` of ${entry.maxPasses}`;
    lines.push(
      `${entry.loopGroupId}  ${entry.activation} · pass ${entry.passCount}${cap} · control revision ${entry.loopControlRevision}`,
    );
    if (entry.decisions.length === 0) {
      lines.push("  (no pass decided yet)");
    }
    for (const decision of entry.decisions) {
      const flags = [
        decision.latest ? null : "superseded",
        decision.markerOnly ? "from current state" : null,
      ].filter((flag): flag is string => flag !== null);
      lines.push(
        `  pass ${decision.pass}  ${decision.verdict} → ${decision.outcome}  rev ${decision.loopControlRevision}  tpl v${decision.templateVersion}  ${decision.exitContextId}${
          flags.length > 0 ? `  (${flags.join(", ")})` : ""
        }`,
      );
    }
    lines.push("");
  }
  // No silent caps: a walk that stopped short says so, and says what to do.
  lines.push(...walkLines(walk));
  return `${lines.join("\n").trimEnd()}\n`;
}
