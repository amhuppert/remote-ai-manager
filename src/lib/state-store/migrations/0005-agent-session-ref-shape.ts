import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";
import { encodeAgentSessionRefForStorage } from "@/lib/shared/session-ref-codec";
import { agentBackendSchema, type AgentSessionRef } from "@/lib/shared/schemas";
import { stableStringify } from "../conversation-row-codec";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import type { StateMigration } from "./types";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("state-store/migrations");

type Db = InstanceType<typeof Database>;

const MIGRATION_NAME = "0005-agent-session-ref-shape";
const MIGRATION_SCHEMA_VERSION = 1;
const MIGRATION_SCHEMA_DESCRIPTION =
  "AgentSessionRef persisted as canonical {backend, ref}";

const LEGACY_HANDLE_KEY: Record<
  AgentSessionRef["backend"],
  "sessionId" | "threadId"
> = {
  claude: "sessionId",
  codex: "threadId",
};

/**
 * Exact non-canonical-signature matcher: legacy `{backend, sessionId|threadId}`
 * or superset `{backend, ref, sessionId|threadId}`. A canonical `{backend,
 * ref}` object (exact two-key set) never matches, so this migration is
 * idempotent by predicate: canonical is the terminal shape, and replays or
 * racing workers converge. The key set is checked exactly because
 * `machine_snapshot` is walked as opaque JSON — a looser predicate could
 * rewrite an unrelated object that merely resembles a ref.
 */
function asNonCanonicalRef(value: unknown): AgentSessionRef | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const backend = agentBackendSchema.safeParse(obj.backend);
  if (!backend.success) return null;
  const legacyKey = LEGACY_HANDLE_KEY[backend.data];
  // Sorted key order: "backend" < "ref" < "sessionId" / "threadId".
  const keys = Object.keys(obj).sort().join(",");
  const isLegacy = keys === `backend,${legacyKey}`;
  const isSuperset = keys === `backend,ref,${legacyKey}`;
  if (!isLegacy && !isSuperset) return null;
  const handle = isSuperset ? obj.ref : obj[legacyKey];
  if (typeof handle !== "string" || handle.length === 0) return null;
  return { backend: backend.data, ref: handle };
}

/** Deep-walk arbitrary JSON, canonicalizing every legacy/superset ref. */
function rewriteRefsInPlace(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  let changed = false;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const ref = asNonCanonicalRef(node[i]);
      if (ref) {
        node[i] = encodeAgentSessionRefForStorage(ref);
        changed = true;
      } else if (rewriteRefsInPlace(node[i])) {
        changed = true;
      }
    }
    return changed;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const ref = asNonCanonicalRef(obj[key]);
    if (ref) {
      obj[key] = encodeAgentSessionRefForStorage(ref);
      changed = true;
    } else if (rewriteRefsInPlace(obj[key])) {
      changed = true;
    }
  }
  return changed;
}

interface RefColumnsRow {
  id: string;
  backend_ref: string | null;
  forked_from: string | null;
  machine_snapshot: string | null;
}

/**
 * Test-only interleaving point between the candidate scan and the row
 * updates — the only window where a concurrently running old build could
 * commit a ref this migration must not overwrite. The race test uses it to
 * drive a second WAL connection at exactly that moment.
 */
type AfterScanHook = (table: string) => void;

let afterScanHookForTesting: AfterScanHook | null = null;

export function _setMigration0005AfterScanHookForTesting(
  hook: AfterScanHook | null,
): void {
  afterScanHookForTesting = hook;
}

/**
 * Parse one JSON column and canonicalize its legacy/superset refs. Returns the
 * new bytes when a rewrite happened, or null when the column is absent, already
 * canonical, or unparseable (logged loudly, left intact — a pre-existing
 * corrupt row must not brick startup now that migration failure is fatal).
 */
function rewriteColumn(
  table: string,
  id: string,
  column: string,
  raw: string | null,
): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error("state-store.migration_row_skipped", {
      migration: MIGRATION_NAME,
      table,
      id,
      column,
      error: getErrorMessage(err),
    });
    return null;
  }
  const topLevel = asNonCanonicalRef(parsed);
  if (topLevel) {
    return stableStringify(encodeAgentSessionRefForStorage(topLevel));
  }
  if (rewriteRefsInPlace(parsed)) return stableStringify(parsed);
  return null;
}

function migrateTable(db: Db, table: string): void {
  const selectCandidates = db.prepare(
    `SELECT id, backend_ref, forked_from, machine_snapshot FROM ${table}
      WHERE backend_ref IS NOT NULL
         OR forked_from IS NOT NULL
         OR machine_snapshot IS NOT NULL`,
  );
  // Guarded update: it only lands if every column still holds the exact bytes
  // that were scanned (`IS` for NULL-safe comparison), so a value written by a
  // concurrent old build can never be overwritten by a stale scan. Inside the
  // immediate transaction the guard cannot miss (the write lock is held across
  // scan and update); it is defense in depth in case that lock discipline is
  // ever weakened. A row it skips is left as-is — the read path decodes legacy
  // shapes, so an unmigrated row degrades to the tolerated old-writer case.
  const guardedUpdate = db.prepare(
    `UPDATE ${table}
        SET backend_ref = ?, forked_from = ?, machine_snapshot = ?
      WHERE id = ?
        AND backend_ref IS ?
        AND forked_from IS ?
        AND machine_snapshot IS ?`,
  );

  const rows = selectCandidates.all() as RefColumnsRow[];
  afterScanHookForTesting?.(table);
  let rewrittenRows = 0;
  for (const row of rows) {
    const backendRef = rewriteColumn(
      table,
      row.id,
      "backend_ref",
      row.backend_ref,
    );
    const forkedFrom = rewriteColumn(
      table,
      row.id,
      "forked_from",
      row.forked_from,
    );
    const machineSnapshot = rewriteColumn(
      table,
      row.id,
      "machine_snapshot",
      row.machine_snapshot,
    );
    if (
      backendRef === null &&
      forkedFrom === null &&
      machineSnapshot === null
    ) {
      continue;
    }
    const result = guardedUpdate.run(
      backendRef ?? row.backend_ref,
      forkedFrom ?? row.forked_from,
      machineSnapshot ?? row.machine_snapshot,
      row.id,
      row.backend_ref,
      row.forked_from,
      row.machine_snapshot,
    );
    if (result.changes === 1) {
      rewrittenRows += 1;
    } else {
      logger.error("state-store.migration_guarded_update_skipped", {
        migration: MIGRATION_NAME,
        table,
        id: row.id,
      });
    }
  }
  logger.info("state-store.migration_table_rewritten", {
    migration: MIGRATION_NAME,
    table,
    scannedRows: rows.length,
    rewrittenRows,
  });
}

/**
 * Stamp the forward-only compatibility-version gate. `INSERT OR IGNORE` keeps
 * this idempotent on replay (the ledger write is a separate step from `up`, so
 * a crash replays it). Recording version 1 is what refuses an older build that
 * shares `CC_CONFIG_DIR` after this migration applies — the older build's
 * `KNOWN_SCHEMA_VERSION` is 0, below the recorded MAX, so it fails on open.
 */
function stampSchemaVersion(db: Db): void {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO schema_migrations (version, description)
       VALUES (?, ?)`,
    )
    .run(MIGRATION_SCHEMA_VERSION, MIGRATION_SCHEMA_DESCRIPTION);
  logger.info("state-store.migration_schema_version_stamped", {
    migration: MIGRATION_NAME,
    version: MIGRATION_SCHEMA_VERSION,
    inserted: result.changes === 1,
  });
}

/**
 * BREAKING migration. Rewrite persisted `AgentSessionRef` shapes to the
 * canonical `{backend, ref}` in `conversations` and `project_conversations` —
 * the columns `backend_ref`, `forked_from` (embedded `sourceBackendRef`), and
 * `machine_snapshot` (deep-walked opaque XState context) — collapsing both the
 * legacy `sessionId`/`threadId` unions and the earlier shadow superset
 * `{backend, ref, sessionId|threadId}`. Idempotent by predicate: a canonical
 * object never matches, so replays and racing workers converge; per-row
 * malformed JSON is skipped with a loud log, never thrown. Safe against
 * concurrent old-build writers: each table is scanned and rewritten inside one
 * immediate (write-locked) transaction with compare-and-swap updates, so a ref
 * committed by an old build mid-rollout is never overwritten by a stale scan.
 *
 * Because canonical bytes drop the legacy handle key an old build's reader
 * requires, this bumps the compat version: it stamps `schema_migrations`
 * version 1, so an older build sharing `CC_CONFIG_DIR` is refused on open by
 * the forward-only gate once this migration has applied. Both table rewrites
 * and the compatibility stamp share one immediate transaction: failure at any
 * stage restores the legacy bytes and leaves the version unstamped.
 */
export const agentSessionRefShape: StateMigration = {
  name: MIGRATION_NAME,
  up: async ({ context }) => {
    // Publish the external barrier before SQLite can expose canonical-only
    // bytes. It is intentionally fail-closed: if the transaction below rolls
    // back, current builds can retry while older readers remain excluded.
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    }
    // BEGIN IMMEDIATE takes the write lock before either candidate scan. A
    // racing old-build write serializes entirely before or after the breaking
    // rewrite, and no older build can observe canonical bytes without the
    // compatibility version that refuses its reader.
    const migrateAll = context.db.transaction(() => {
      enforceCurrentSchemaCompatibility(
        context.db,
        context.db.name,
        MIGRATION_SCHEMA_VERSION,
      );
      migrateTable(context.db, "conversations");
      migrateTable(context.db, "project_conversations");
      stampSchemaVersion(context.db);
    });
    migrateAll.immediate();
  },
};
