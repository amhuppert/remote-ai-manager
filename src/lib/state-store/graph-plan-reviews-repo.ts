import type Database from "better-sqlite3";

import { createLogger } from "@/lib/logging";
import { emitOrDeferRepositoryLog } from "@/lib/state-store/deferred-repo-logging";
import {
  graphPlanReviewSchema,
  type GraphPlanReview,
} from "@/lib/workflows/plan-review/schemas";

import { checkRowColumnSize } from "./row-size-telemetry";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.graph-plan-reviews");

/**
 * Terminal plan-review verdicts (#69 change 5), keyed by the reviewed
 * revision's `workingDefinitionHash`.
 *
 * A revision may be reviewed more than once — a reviewer revisits a plan, a
 * second reviewer weighs in — so the store keeps every verdict and the read
 * returns the whole ordered history. Collapsing to one row per hash would make
 * "the latest verdict" a write-time decision, and a lost earlier verdict is
 * exactly the audit gap this record exists to close.
 */
export interface GraphPlanReviewsRepo {
  /**
   * Record one concluded review.
   *
   * Converges on IDENTICAL content, so a retried write is safe, and leaves a
   * stored verdict untouched when the same id arrives carrying different
   * content — that is a caller minting ids wrongly, and silently replacing the
   * earlier verdict would erase exactly the history this table exists to keep.
   * The mismatch is logged, not refused: a write path that can reject is a new
   * way for an advisory mechanism to fail.
   */
  record(review: GraphPlanReview): void;
  /**
   * Every DECODABLE review of one exact revision, oldest first. An unreviewed
   * revision yields an empty list — never an error, because absence of a review
   * is a legitimate state on every path that consults this.
   *
   * A row the schema refuses is quarantined and logged rather than thrown, so
   * one bad row cannot hide its valid neighbours. The usual repository contract
   * (throw a typed PersistenceError over the whole result set) is wrong here:
   * this record is advisory, so the cost of a strict read is a revision with a
   * durable verdict reading back as unreviewed, while the benefit — refusing a
   * caller that cannot act on the refusal anyway — is nil.
   */
  listByDefinitionHash(definitionHash: string): GraphPlanReview[];
}

interface StorageRow {
  id: string;
  definition_hash: string;
  reviewer_conversation_id: string;
  verdict: string;
  findings: string | null;
  reviewed_at: string;
}

function isStorageRow(value: unknown): value is StorageRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.definition_hash === "string" &&
    typeof row.reviewer_conversation_id === "string" &&
    typeof row.verdict === "string" &&
    (row.findings === null || typeof row.findings === "string") &&
    typeof row.reviewed_at === "string"
  );
}

/** Does the stored row already carry exactly what this write would insert? */
function storageRowMatches(row: StorageRow, bind: StorageRow): boolean {
  return (
    row.definition_hash === bind.definition_hash &&
    row.reviewer_conversation_id === bind.reviewer_conversation_id &&
    row.verdict === bind.verdict &&
    row.findings === bind.findings &&
    row.reviewed_at === bind.reviewed_at
  );
}

function quarantineRow(identifier: string, issues: unknown): null {
  emitOrDeferRepositoryLog(() =>
    logger.warn("state-store.graph-plan-reviews.row_quarantined", {
      identifier,
      issues,
    }),
  );
  return null;
}

/** The decoded review, or null when the row is unreadable (already logged). */
function rowToDomain(row: unknown): GraphPlanReview | null {
  if (!isStorageRow(row)) {
    return quarantineRow("<row>", [
      { code: "invalid_row_shape", path: [], message: "unexpected row shape" },
    ]);
  }
  const parsed = graphPlanReviewSchema.safeParse({
    id: row.id,
    definitionHash: row.definition_hash,
    reviewerConversationId: row.reviewer_conversation_id,
    verdict: row.verdict,
    findings: row.findings,
    reviewedAt: row.reviewed_at,
  });
  if (!parsed.success) {
    return quarantineRow(row.id, parsed.error.issues);
  }
  return parsed.data;
}

export function createGraphPlanReviewsRepo(db: Db): GraphPlanReviewsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO graph_plan_reviews (
       id, definition_hash, reviewer_conversation_id, verdict, findings,
       reviewed_at
     ) VALUES (
       @id, @definition_hash, @reviewer_conversation_id, @verdict, @findings,
       @reviewed_at
     )
     ON CONFLICT(id) DO NOTHING`,
  );
  const findByIdStmt = db.prepare(
    `SELECT * FROM graph_plan_reviews WHERE id = ? LIMIT 1`,
  );
  // `rowid` breaks a `reviewed_at` tie by insertion order, so two reviews
  // stamped the same second still have one deterministic "most recent".
  const listStmt = db.prepare(
    `SELECT * FROM graph_plan_reviews
      WHERE definition_hash = ?
      ORDER BY reviewed_at ASC, rowid ASC`,
  );

  return {
    record(review) {
      const validated = graphPlanReviewSchema.parse(review);
      checkRowColumnSize({
        logger,
        table: "graph_plan_reviews",
        column: "findings",
        id: validated.id,
        value: validated.findings,
      });
      const bind = {
        id: validated.id,
        definition_hash: validated.definitionHash,
        reviewer_conversation_id: validated.reviewerConversationId,
        verdict: validated.verdict,
        findings: validated.findings,
        reviewed_at: validated.reviewedAt,
      };
      if (insertStmt.run(bind).changes > 0) return;

      // The id was already taken. An identical replay is the expected case and
      // has converged; anything else is a distinct verdict wearing an existing
      // id, and the caller needs to hear about it.
      const existing: unknown = findByIdStmt.get(validated.id);
      if (isStorageRow(existing) && !storageRowMatches(existing, bind)) {
        emitOrDeferRepositoryLog(() =>
          logger.warn("state-store.graph-plan-reviews.record_id_reused", {
            identifier: validated.id,
            storedDefinitionHash: existing.definition_hash,
            storedVerdict: existing.verdict,
            storedReviewedAt: existing.reviewed_at,
            incomingDefinitionHash: bind.definition_hash,
            incomingVerdict: bind.verdict,
            incomingReviewedAt: bind.reviewed_at,
          }),
        );
      }
    },
    listByDefinitionHash(definitionHash) {
      const reviews: GraphPlanReview[] = [];
      for (const row of listStmt.all(definitionHash)) {
        const review = rowToDomain(row);
        if (review !== null) reviews.push(review);
      }
      return reviews;
    },
  };
}
