import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEPLOY_1_5_SCHEMA_SQL } from "./deploy-1-5-schema";

export const DEPLOY_1_5_PROJECT_PATH = "/deploy-1-5/project";
export const DEPLOY_1_5_SESSION_NAME = "deploy-1-5-session";
export const DEPLOY_1_5_CONVERSATION_ID = "deploy-1-5-conversation";
export const DEPLOY_1_5_PROJECT_CONVERSATION_ID =
  "deploy-1-5-project-conversation";

/**
 * The migration ledger a fresh deploy 1.5 startup writes, in its order. A copy
 * of what that build recorded, kept apart from the list this build requires so
 * that a test comparing the two compares two witnesses.
 */
const DEPLOY_1_5_LEDGER = [
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

const DEPLOY_1_5_SCHEMA_VERSION = 29;

const AT = "2026-10-01T00:00:00.000Z";

/**
 * Writes the data directory a stopped deploy 1.5 server leaves in `configDir`:
 * its database (the frozen schema, the full migration ledger, schema version
 * 29 and rows seeded through raw SQL, in write-ahead-log mode) and its
 * compatibility barrier files 1 to 29. Only raw SQLite touches it, so no floor
 * of this build has run on it. Returns the database path.
 */
export function createDeploy15Database(configDir: string): string {
  mkdirSync(configDir, { recursive: true });
  const dbPath = path.join(configDir, "command-center.db");
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(DEPLOY_1_5_SCHEMA_SQL);
    db.transaction(() => {
      const ledger = db.prepare(
        "INSERT INTO applied_migrations (name, applied_at) VALUES (?, ?)",
      );
      for (const name of DEPLOY_1_5_LEDGER) ledger.run(name, AT);
      db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
      ).run(
        DEPLOY_1_5_SCHEMA_VERSION,
        "run boundaries as a subscription source and waking follows",
        AT,
      );
      seedRows(db);
    })();
  } finally {
    db.close();
  }
  for (let version = 1; version <= DEPLOY_1_5_SCHEMA_VERSION; version++) {
    writeFileSync(
      path.join(configDir, `command-center.schema-version-${version}.json`),
      `${JSON.stringify({ version }, null, 2)}\n`,
    );
  }
  return dbPath;
}

function seedRows(db: InstanceType<typeof Database>): void {
  db.prepare(
    "INSERT INTO projects (root_path, created_at, updated_at) VALUES (?, ?, ?)",
  ).run(DEPLOY_1_5_PROJECT_PATH, AT, AT);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    DEPLOY_1_5_PROJECT_PATH,
    DEPLOY_1_5_SESSION_NAME,
    `${DEPLOY_1_5_PROJECT_PATH}/.worktrees/${DEPLOY_1_5_SESSION_NAME}`,
    `csm/${DEPLOY_1_5_SESSION_NAME}`,
    AT,
    AT,
  );
  db.prepare(
    `INSERT INTO conversations (
       id, project_path, session_name, name, status, prompt_count,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, 'awaiting', 2, ?, ?)`,
  ).run(
    DEPLOY_1_5_CONVERSATION_ID,
    DEPLOY_1_5_PROJECT_PATH,
    DEPLOY_1_5_SESSION_NAME,
    "Session conversation",
    AT,
    AT,
  );
  db.prepare(
    `INSERT INTO project_conversations (
       id, project_path, name, status, prompt_count, created_at,
       last_activity_at
     ) VALUES (?, ?, ?, 'awaiting', 1, ?, ?)`,
  ).run(
    DEPLOY_1_5_PROJECT_CONVERSATION_ID,
    DEPLOY_1_5_PROJECT_PATH,
    "Project conversation",
    AT,
    AT,
  );
}
