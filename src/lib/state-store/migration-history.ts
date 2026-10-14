import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store/migration-history");

/** The last build that ran the retired migrations. */
export const RETIRED_HISTORY_BUILD = {
  tag: "overhaul-deploy-1.5",
  sha: "f441c64c3c2c75b483b00fe705ac9be0486c5829",
} as const;

/**
 * Every migration registered at {@link RETIRED_HISTORY_BUILD}, in registry
 * order. Literal on purpose: this build no longer holds their code, so this
 * list is the only record of the history an existing database must have
 * finished before this build may open it.
 */
export const RETIRED_MIGRATION_NAMES = [
  "0001-drop-legacy-roadmap-items",
  "0002-split-graph-workflow-history",
  "0003-split-graph-workflow-execution",
  "0004-fast-to-normal",
  "0005-agent-session-ref-shape",
  "0006-codex-runs-to-agent-runs",
  "0007-move-machine-snapshots-to-sidecar",
  "0008-add-spec-authoring-stage",
  "0009-narrow-evidence-kinds",
  "0010-freeze-spec-execution-launch",
  "0011-add-validation-runs",
  "0011-workflow-agent-assignments",
  "0012-validation-cost-exceeds-limit-status",
  "0013-script-validator-commands",
  "0014-validation-run-session-name",
  "0015-add-delivery-plan-attempts",
  "0015-mint-graph-workflow-edge-ids",
  "0016-add-delivery-plan-candidates",
  "0016-graph-workflow-context-placement",
  "0016-validation-run-scopes",
  "0017-spec-execution-abandon-coordinator",
  "0018-delivery-plan-prelaunch",
  "0019-delivery-plan-approval-identity",
  "0020-add-delivery-discoveries",
  "0020-delivery-plan-comments",
  "0021-spec-revision-external-delivery",
  "0022-import-gate-admission-basis",
  "0023-graph-workflow-seeded-documents",
  "0024-collab-lane-flow-agent-ids",
  "0024-execution-lease-and-result-deliveries",
  "0025-graph-workflow-pending-artifacts",
  "0026-delivery-plan-launch-cutover",
  "0026-retire-release-slot-cleanup-phase",
  "0027-workflow-result-notifications",
  "0027-retire-delivery-plan-amendments",
  "0028-retire-legacy-spec-executions",
  "0028-workflow-result-effect-receipts",
  "0029-add-spec-delivery-verdicts",
  "0029-job-record-parked-merge",
  "0030-native-sdd-v2-cutover",
  "0031-graph-workflow-candidate-unstable-halt",
  "0032-add-graph-plan-reviews",
  "0033-conversation-ownership",
  "0034-native-sdd-attention-citations",
  "0035-add-notepads",
  "0035-generalized-model-selection",
  "0036-add-notepad-comments",
  "0037-add-notepad-delivery-watermarks",
  "0038-ticket-relationships-and-status-updates",
  "0039-native-sdd-managed-workflow-definitions",
  "0040-add-memory-notes",
  "0041-add-memory-search-index",
  "0042-add-memory-telemetry",
  "0043-close-policy-admitted-approval-requests",
  "0044-add-conversation-checkpoints",
  "0045-add-checkpoint-forks",
  "0046-merge-completion-option",
  "0047-graph-workflow-lane-coverage",
  "0048-graph-workflow-document-content",
  "0049-graph-workflow-review-origin",
  "0050-remove-execution-seed-filler",
  "0051-retire-stored-shape-readers",
  "0052-optional-checkpoint-fork-work",
  "0053-add-checkpoint-handoff",
  "0054-graph-workflow-continuous-conversations",
  "0055-graph-workflow-validator-conversations",
  "0056-close-withdrawn-revision-approval-requests",
  "0057-continuous-spec-review",
  "0058-add-conversation-subscriptions",
  "0059-add-conversation-subscription-waits",
  "0060-add-conversation-subscription-controls",
  "0061-conversation-notice-inbox",
  "0062-notepad-notice-context",
  "0063-workflow-result-inbox",
  "0064-retire-automatic-validation-follows",
  "0065-subscription-wait-generations",
  "0066-repair-imported-notice-history",
  "0067-retire-consumed-finite-wait-sources",
  "0068-run-subscription-source",
] as const;

export type MigrationHistory = "fresh" | "eligible";

/**
 * The database holds data but not the full retired history, so this build has
 * no code that could finish it. Thrown before any write; the caller's
 * transaction leaves the database as it was.
 */
export class RetiredMigrationHistoryError extends Error {
  constructor(readonly missing: readonly string[]) {
    const named = missing.slice(0, 3).join(", ");
    const more = missing.length > 3 ? `, and ${missing.length - 3} more` : "";
    super(
      `This database has not applied every migration this build retired (missing: ${named}${more}). ` +
        `Start build ${RETIRED_HISTORY_BUILD.tag} (${RETIRED_HISTORY_BUILD.sha}) on it once so its startup migrations finish, then start this build. ` +
        "A disposable dev instance can delete its .config directory instead.",
    );
    this.name = "RetiredMigrationHistoryError";
  }
}

function hasTable(db: Db, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

/**
 * Decides, before the schema floor writes anything, whether this build may
 * open the database: `fresh` when it holds no table at all, `eligible` when its
 * ledger records every retired migration. Anything else throws
 * {@link RetiredMigrationHistoryError}; that includes a directory whose floor
 * ran but whose migrations never did, which only a disposable instance leaves.
 */
export function classifyMigrationHistory(db: Db): MigrationHistory {
  const anyTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1")
    .get();
  if (anyTable === undefined) return "fresh";
  const applied = new Set(
    hasTable(db, "applied_migrations")
      ? db
          .prepare("SELECT name FROM applied_migrations")
          .all()
          .map((row) => (row as { name: string }).name)
      : [],
  );
  const missing = RETIRED_MIGRATION_NAMES.filter((name) => !applied.has(name));
  if (missing.length === 0) return "eligible";
  logger.error("state-store.fatal", {
    reason: "retired_migration_history",
    dbPath: db.name,
    missingCount: missing.length,
    missing: missing.slice(0, 3),
  });
  throw new RetiredMigrationHistoryError(missing);
}

/**
 * Records the retired history on a fresh database, whose floor-built schema
 * already holds everything those migrations produced.
 */
export function stampRetiredMigrationHistory(db: Db): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO applied_migrations (name) VALUES (?)",
  );
  for (const name of RETIRED_MIGRATION_NAMES) insert.run(name);
}
