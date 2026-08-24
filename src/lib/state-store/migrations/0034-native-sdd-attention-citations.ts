import { createHash } from "node:crypto";

import { createLogger } from "@/lib/logging";

import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { stableStringify } from "../serialization";
import type { MigrationContext, StateMigration } from "./types";

const logger = createLogger("state-store.migrations");
export const NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION = 11;
const MIGRATION_SCHEMA_DESCRIPTION =
  "native-SDD attention lifecycle and revision-owned assumption citations";
const PREFLIGHT_SAMPLE_LIMIT = 20;
const EMPTY_CONTRACT_2_CITATION_HASH =
  "551ce2879a567c8baca5a19f5af4385373bd63b916be6091fa891dd8a307d1df";

interface QuestionRow {
  readonly id: string;
  readonly spec_id: string;
  readonly number: number;
  readonly element_id: string | null;
  readonly provenance_json: string;
  readonly status: string;
  readonly answer: string | null;
  readonly answered_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AssumptionRow {
  readonly id: string;
  readonly spec_id: string;
  readonly number: number;
  readonly element_id: string | null;
  readonly text: string;
  readonly proposed_by_json: string;
  readonly disposition: string;
  readonly disposed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ElementOwnerRow {
  readonly id: string;
  readonly spec_id: string;
}

interface RevisionRow {
  readonly id: string;
  readonly spec_id: string;
  readonly state: "draft" | "proposed" | "approved" | "withdrawn";
  readonly authoring_stage: string;
  readonly content_hash: string | null;
  readonly proposed_at: string | null;
}

interface CanonicalElementRow {
  readonly revision_id: string;
  readonly element_id: string;
  readonly kind: string;
  readonly number: number | null;
  readonly parent_element_id: string | null;
  readonly position: number;
  readonly payload_json: string;
  readonly payload_hash: string;
}

interface MigratedAssumptionRow extends AssumptionRow {
  readonly proposed_by_json: string;
  readonly record_version: number;
  readonly withdrawn_at: string | null;
  readonly supersedes_assumption_id: string | null;
}

interface CitationRow {
  readonly revision_id: string;
  readonly element_id: string;
  readonly assumption_id: string;
  readonly assumption_snapshot_json: string;
}

interface MigratedRevisionRow extends RevisionRow {
  readonly citation_contract_version: 1 | 2;
  readonly citation_version: number;
  readonly citation_hash: string;
}

export class NativeSddAttentionCitationsPreflightError extends Error {
  constructor(readonly offendingIds: readonly string[]) {
    super(
      `Native SDD attention/citation migration preflight failed for record(s): ${offendingIds.join(", ")}`,
    );
    this.name = "NativeSddAttentionCitationsPreflightError";
  }
}

export class NativeSddAttentionCitationsVerificationError extends Error {
  constructor(readonly offendingIds: readonly string[]) {
    super(
      `Native SDD attention/citation migration verification failed for record(s): ${offendingIds.join(", ")}`,
    );
    this.name = "NativeSddAttentionCitationsVerificationError";
  }
}

function actorProvenanceIsValid(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const actor = value as Record<string, unknown>;
    const keys = Object.keys(actor).sort();
    if (actor.kind === "human") {
      return keys.length === 1 && keys[0] === "kind";
    }
    if (actor.kind !== "agent") return false;
    if (
      typeof actor.conversationId !== "string" ||
      actor.conversationId.length === 0
    ) {
      return false;
    }
    if (
      actor.backend !== undefined &&
      (typeof actor.backend !== "string" || actor.backend.length === 0)
    ) {
      return false;
    }
    return keys.every((key) =>
      ["backend", "conversationId", "kind"].includes(key),
    );
  } catch {
    return false;
  }
}

function timestampOrderIsValid(
  createdAt: string,
  updatedAt: string,
  terminalAt: string | null,
): boolean {
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return false;
  if (created > updated) return false;
  if (terminalAt === null) return true;
  const terminal = Date.parse(terminalAt);
  return (
    Number.isFinite(terminal) && terminal >= created && terminal <= updated
  );
}

function collectPreflightOffendingIds(db: MigrationContext["db"]): string[] {
  const elementOwners = new Map(
    (
      db
        .prepare("SELECT id, spec_id FROM spec_elements")
        .all() as ElementOwnerRow[]
    ).map((row) => [row.id, row.spec_id]),
  );
  const offending = new Set<string>();

  const questions = db
    .prepare(
      `SELECT id, spec_id, number, element_id, provenance_json, status, answer,
              answered_at, created_at, updated_at
       FROM spec_questions
       ORDER BY id`,
    )
    .all() as QuestionRow[];
  for (const question of questions) {
    const lifecycleValid =
      (question.status === "open" &&
        question.answer === null &&
        question.answered_at === null) ||
      (question.status === "answered" &&
        question.answer !== null &&
        question.answer.length > 0 &&
        question.answered_at !== null);
    const attachmentValid =
      question.element_id === null ||
      elementOwners.get(question.element_id) === question.spec_id;
    if (
      !lifecycleValid ||
      !attachmentValid ||
      !actorProvenanceIsValid(question.provenance_json) ||
      !timestampOrderIsValid(
        question.created_at,
        question.updated_at,
        question.answered_at,
      )
    ) {
      offending.add(question.id);
    }
  }

  const assumptions = db
    .prepare(
      `SELECT id, spec_id, number, element_id, text, proposed_by_json,
              disposition, disposed_at, created_at, updated_at
       FROM spec_assumptions
       ORDER BY id`,
    )
    .all() as AssumptionRow[];
  for (const assumption of assumptions) {
    const lifecycleValid =
      (assumption.disposition === "proposed" &&
        assumption.disposed_at === null) ||
      (["confirmed", "rejected", "deferred"].includes(assumption.disposition) &&
        assumption.disposed_at !== null);
    const attachmentValid =
      assumption.element_id === null ||
      elementOwners.get(assumption.element_id) === assumption.spec_id;
    if (
      !lifecycleValid ||
      !attachmentValid ||
      !actorProvenanceIsValid(assumption.proposed_by_json) ||
      !timestampOrderIsValid(
        assumption.created_at,
        assumption.updated_at,
        assumption.disposed_at,
      )
    ) {
      offending.add(assumption.id);
    }
  }

  for (const records of [questions, assumptions]) {
    const handleOwners = new Map<string, string>();
    for (const record of records) {
      const key = `${record.spec_id}\u0000${record.number}`;
      const prior = handleOwners.get(key);
      if (prior !== undefined) {
        offending.add(prior);
        offending.add(record.id);
      } else {
        handleOwners.set(key, record.id);
      }
    }
  }

  return [...offending].sort().slice(0, PREFLIGHT_SAMPLE_LIMIT);
}

function tableHasColumn(
  db: MigrationContext["db"],
  table: string,
  column: string,
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).some((entry) => entry.name === column);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function revisionIntegrityOffendingIds(db: MigrationContext["db"]): string[] {
  const revisions = db
    .prepare(
      `SELECT id, spec_id, state, authoring_stage, content_hash, proposed_at
       FROM spec_revisions
       ORDER BY id`,
    )
    .all() as RevisionRow[];
  const elementRows = db
    .prepare(
      `SELECT versions.revision_id, elements.id AS element_id, elements.kind,
              elements.number, elements.parent_element_id, versions.position,
              versions.payload_json, versions.payload_hash
       FROM spec_element_versions AS versions
       JOIN spec_elements AS elements ON elements.id = versions.element_id
       ORDER BY versions.revision_id, versions.position, elements.id`,
    )
    .all() as CanonicalElementRow[];
  const rowsByRevision = new Map<string, CanonicalElementRow[]>();
  for (const row of elementRows) {
    const rows = rowsByRevision.get(row.revision_id) ?? [];
    rows.push(row);
    rowsByRevision.set(row.revision_id, rows);
  }

  const offending = new Set<string>();
  for (const revision of revisions) {
    if (revision.state !== "draft" && revision.proposed_at === null) {
      offending.add(revision.id);
    }
    const canonicalElements: unknown[] = [];
    for (const row of rowsByRevision.get(revision.id) ?? []) {
      try {
        const payload: unknown = JSON.parse(row.payload_json);
        if (sha256(payload) !== row.payload_hash) {
          offending.add(revision.id);
        }
        canonicalElements.push({
          elementId: row.element_id,
          kind: row.kind,
          number: row.number,
          parentElementId: row.parent_element_id,
          position: row.position,
          payload,
        });
      } catch {
        offending.add(revision.id);
      }
    }
    if (revision.content_hash === null) {
      if (revision.state !== "draft") offending.add(revision.id);
      continue;
    }
    const expected = sha256({
      authoringStage: revision.authoring_stage,
      elements: canonicalElements,
    });
    if (expected !== revision.content_hash) offending.add(revision.id);
  }
  return [...offending].sort().slice(0, PREFLIGHT_SAMPLE_LIMIT);
}

function rebuildAttentionTables(db: MigrationContext["db"]): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_elements_id_spec
      ON spec_elements (id, spec_id);

    ALTER TABLE spec_questions RENAME TO spec_questions_attention_legacy;
    CREATE TABLE spec_questions (
      id               TEXT PRIMARY KEY,
      spec_id          TEXT NOT NULL,
      number           INTEGER NOT NULL CHECK (number > 0),
      element_id       TEXT,
      text             TEXT NOT NULL,
      provenance_json  TEXT NOT NULL,
      record_version   INTEGER NOT NULL DEFAULT 1 CHECK (record_version > 0),
      status           TEXT NOT NULL CHECK (status IN (
        'open', 'answered', 'withdrawn'
      )),
      answer           TEXT,
      answered_at      TEXT,
      withdrawn_at     TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (id, spec_id),
      UNIQUE (spec_id, number),
      CHECK (
        (status = 'open' AND answer IS NULL AND answered_at IS NULL
          AND withdrawn_at IS NULL)
        OR
        (status = 'answered' AND answer IS NOT NULL AND length(answer) > 0
          AND answered_at IS NOT NULL AND withdrawn_at IS NULL)
        OR
        (status = 'withdrawn' AND answer IS NULL AND answered_at IS NULL
          AND withdrawn_at IS NOT NULL)
      ),
      FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
      FOREIGN KEY (element_id, spec_id) REFERENCES spec_elements(id, spec_id)
    );
    INSERT INTO spec_questions (
      id, spec_id, number, element_id, text, provenance_json, record_version,
      status, answer, answered_at, withdrawn_at, created_at, updated_at
    )
    SELECT
      id, spec_id, number, element_id, text, provenance_json, 1,
      status, answer, answered_at, NULL, created_at, updated_at
    FROM spec_questions_attention_legacy;
    DROP TABLE spec_questions_attention_legacy;
    CREATE INDEX idx_spec_questions_spec_status
      ON spec_questions (spec_id, status, number);

    ALTER TABLE spec_assumptions RENAME TO spec_assumptions_attention_legacy;
    CREATE TABLE spec_assumptions (
      id                           TEXT PRIMARY KEY,
      spec_id                      TEXT NOT NULL,
      number                       INTEGER NOT NULL CHECK (number > 0),
      element_id                   TEXT,
      text                         TEXT NOT NULL,
      proposed_by_json             TEXT NOT NULL,
      record_version               INTEGER NOT NULL DEFAULT 1
                                     CHECK (record_version > 0),
      disposition                  TEXT NOT NULL CHECK (disposition IN (
        'proposed', 'confirmed', 'rejected', 'deferred', 'withdrawn'
      )),
      disposed_at                  TEXT,
      withdrawn_at                 TEXT,
      supersedes_assumption_id     TEXT,
      supersession_operation_id    TEXT,
      supersession_request_hash    TEXT CHECK (
        supersession_request_hash IS NULL OR (
          length(supersession_request_hash) = 64
          AND supersession_request_hash NOT GLOB '*[^0-9a-f]*'
        )
      ),
      created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (id, spec_id),
      UNIQUE (spec_id, number),
      CHECK (
        (disposition = 'proposed' AND disposed_at IS NULL
          AND withdrawn_at IS NULL)
        OR
        (disposition IN ('confirmed', 'rejected', 'deferred')
          AND disposed_at IS NOT NULL AND withdrawn_at IS NULL)
        OR
        (disposition = 'withdrawn' AND disposed_at IS NULL
          AND withdrawn_at IS NOT NULL)
      ),
      CHECK (
        supersedes_assumption_id IS NULL
        OR id <> supersedes_assumption_id
      ),
      CHECK (
        (supersedes_assumption_id IS NULL
          AND supersession_operation_id IS NULL
          AND supersession_request_hash IS NULL)
        OR
        (supersedes_assumption_id IS NOT NULL
          AND supersession_operation_id IS NOT NULL
          AND supersession_request_hash IS NOT NULL)
      ),
      FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
      FOREIGN KEY (element_id, spec_id) REFERENCES spec_elements(id, spec_id),
      FOREIGN KEY (supersedes_assumption_id, spec_id)
        REFERENCES spec_assumptions(id, spec_id)
    );
    INSERT INTO spec_assumptions (
      id, spec_id, number, element_id, text, proposed_by_json, record_version,
      disposition, disposed_at, withdrawn_at, supersedes_assumption_id,
      supersession_operation_id, supersession_request_hash,
      created_at, updated_at
    )
    SELECT
      id, spec_id, number, element_id, text, proposed_by_json, 1,
      disposition, disposed_at, NULL, NULL, NULL, NULL, created_at, updated_at
    FROM spec_assumptions_attention_legacy;
    DROP TABLE spec_assumptions_attention_legacy;
    CREATE INDEX idx_spec_assumptions_spec_disposition
      ON spec_assumptions (spec_id, disposition, number);
    CREATE UNIQUE INDEX uq_spec_assumptions_predecessor
      ON spec_assumptions (spec_id, supersedes_assumption_id)
      WHERE supersedes_assumption_id IS NOT NULL;
    CREATE UNIQUE INDEX uq_spec_assumptions_operation
      ON spec_assumptions (spec_id, supersession_operation_id)
      WHERE supersession_operation_id IS NOT NULL;
  `);
}

function addCitationStorage(db: MigrationContext["db"]): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_revisions_id_spec
      ON spec_revisions (id, spec_id);
    ALTER TABLE spec_revisions ADD COLUMN
      citation_contract_version INTEGER NOT NULL DEFAULT 2 CHECK (
        citation_contract_version IN (1, 2)
      );
    ALTER TABLE spec_revisions ADD COLUMN
      citation_version INTEGER NOT NULL DEFAULT 1 CHECK (citation_version > 0);
    ALTER TABLE spec_revisions ADD COLUMN
      citation_hash TEXT NOT NULL DEFAULT '${EMPTY_CONTRACT_2_CITATION_HASH}'
        CHECK (
          length(citation_hash) = 64
          AND citation_hash NOT GLOB '*[^0-9a-f]*'
        );

    CREATE TABLE spec_revision_assumption_citations (
      revision_id              TEXT NOT NULL,
      spec_id                  TEXT NOT NULL,
      element_id               TEXT NOT NULL,
      assumption_id            TEXT NOT NULL,
      assumption_snapshot_json TEXT NOT NULL CHECK (
        json_valid(assumption_snapshot_json)
      ),
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      PRIMARY KEY (revision_id, element_id, assumption_id),
      FOREIGN KEY (revision_id, spec_id)
        REFERENCES spec_revisions(id, spec_id) ON DELETE CASCADE,
      FOREIGN KEY (revision_id, element_id)
        REFERENCES spec_element_versions(revision_id, element_id)
          ON DELETE CASCADE,
      FOREIGN KEY (assumption_id, spec_id)
        REFERENCES spec_assumptions(id, spec_id)
    );
    CREATE INDEX idx_spec_revision_citations_revision_assumption
      ON spec_revision_assumption_citations (revision_id, assumption_id);
    CREATE INDEX idx_spec_revision_citations_assumption_revision
      ON spec_revision_assumption_citations (assumption_id, revision_id);
  `);
}

function citationHash(
  contractVersion: 1 | 2,
  rows: readonly CitationRow[],
): string {
  return sha256({
    citationContractVersion: contractVersion,
    citations: rows.map((row) => ({
      elementId: row.element_id,
      assumptionId: row.assumption_id,
      snapshot: JSON.parse(row.assumption_snapshot_json) as unknown,
    })),
  });
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCitationRows(left: CitationRow, right: CitationRow): number {
  return (
    compareCodeUnits(left.element_id, right.element_id) ||
    compareCodeUnits(left.assumption_id, right.assumption_id)
  );
}

function backfillCitations(
  db: MigrationContext["db"],
  cutoverAt: string,
): void {
  const revisions = db
    .prepare(
      `SELECT id, spec_id, state, authoring_stage, content_hash, proposed_at
       FROM spec_revisions
       ORDER BY id`,
    )
    .all() as RevisionRow[];
  const assumptions = db
    .prepare(
      `SELECT id, spec_id, number, element_id, text, proposed_by_json,
              record_version, disposition, disposed_at, withdrawn_at,
              supersedes_assumption_id, created_at, updated_at
       FROM spec_assumptions
       ORDER BY element_id, id`,
    )
    .all() as MigratedAssumptionRow[];
  const elementRows = db
    .prepare(
      `SELECT revision_id, element_id
       FROM spec_element_versions
       ORDER BY revision_id, element_id`,
    )
    .all() as Array<{ revision_id: string; element_id: string }>;
  const elementIdsByRevision = new Map<string, Set<string>>();
  for (const row of elementRows) {
    const ids = elementIdsByRevision.get(row.revision_id) ?? new Set<string>();
    ids.add(row.element_id);
    elementIdsByRevision.set(row.revision_id, ids);
  }

  const insertCitation = db.prepare(
    `INSERT INTO spec_revision_assumption_citations (
       revision_id, spec_id, element_id, assumption_id,
       assumption_snapshot_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRevision = db.prepare(
    `UPDATE spec_revisions
     SET citation_contract_version = ?, citation_version = 1,
         citation_hash = ?
     WHERE id = ?`,
  );

  for (const revision of revisions) {
    const contractVersion = revision.state === "draft" ? 2 : 1;
    const revisionElements = elementIdsByRevision.get(revision.id) ?? new Set();
    const revisionCitations: CitationRow[] = [];
    for (const assumption of assumptions) {
      if (assumption.spec_id !== revision.spec_id) continue;
      if (assumption.element_id === null) continue;
      if (!revisionElements.has(assumption.element_id)) continue;
      if (
        revision.state !== "draft" &&
        (revision.proposed_at === null ||
          assumption.created_at > revision.proposed_at)
      ) {
        continue;
      }
      const snapshot = {
        schemaVersion: 1,
        captureKind: "legacy_backfill",
        capturedAt: cutoverAt,
        assumptionId: assumption.id,
        number: assumption.number,
        recordVersion: assumption.record_version,
        text: assumption.text,
        elementId: assumption.element_id,
        proposedBy: JSON.parse(assumption.proposed_by_json) as unknown,
        disposition: assumption.disposition,
        disposedAt: assumption.disposed_at,
        withdrawnAt: assumption.withdrawn_at,
        supersedesAssumptionId: assumption.supersedes_assumption_id,
        createdAt: assumption.created_at,
        updatedAt: assumption.updated_at,
      };
      const row = {
        revision_id: revision.id,
        element_id: assumption.element_id,
        assumption_id: assumption.id,
        assumption_snapshot_json: stableStringify(snapshot),
      };
      revisionCitations.push(row);
    }
    revisionCitations.sort(compareCitationRows);
    for (const citation of revisionCitations) {
      insertCitation.run(
        revision.id,
        revision.spec_id,
        citation.element_id,
        citation.assumption_id,
        citation.assumption_snapshot_json,
        cutoverAt,
        cutoverAt,
      );
    }
    updateRevision.run(
      contractVersion,
      citationHash(contractVersion, revisionCitations),
      revision.id,
    );
  }
}

function verifyMigratedState(db: MigrationContext["db"]): void {
  const offending = new Set(revisionIntegrityOffendingIds(db));
  const foreignKeyIssues = db
    .prepare("PRAGMA foreign_key_check")
    .all() as Array<{
    table: string;
    rowid: number;
  }>;
  for (const issue of foreignKeyIssues) {
    offending.add(`${issue.table}:${issue.rowid}`);
  }

  const revisions = db
    .prepare(
      `SELECT id, spec_id, state, authoring_stage, content_hash, proposed_at,
              citation_contract_version, citation_version, citation_hash
       FROM spec_revisions
       ORDER BY id`,
    )
    .all() as MigratedRevisionRow[];
  const citations = db
    .prepare(
      `SELECT revision_id, element_id, assumption_id,
              assumption_snapshot_json
       FROM spec_revision_assumption_citations
       ORDER BY revision_id, element_id, assumption_id`,
    )
    .all() as CitationRow[];
  const revisionsWithNativeCitations = new Set<string>();

  for (const row of citations) {
    try {
      const snapshot = JSON.parse(row.assumption_snapshot_json) as Record<
        string,
        unknown
      >;
      if (
        snapshot.schemaVersion !== 1 ||
        snapshot.assumptionId !== row.assumption_id ||
        !["native", "legacy_backfill"].includes(String(snapshot.captureKind))
      ) {
        offending.add(`${row.revision_id}:${row.assumption_id}`);
      }
      if (snapshot.captureKind === "native") {
        revisionsWithNativeCitations.add(row.revision_id);
      }
    } catch {
      offending.add(`${row.revision_id}:${row.assumption_id}`);
    }
  }

  for (const revision of revisions) {
    const revisionCitations = citations.filter(
      (row) => row.revision_id === revision.id,
    );
    revisionCitations.sort(compareCitationRows);
    const contractIsValid =
      revision.state === "draft"
        ? revision.citation_contract_version === 2
        : revision.citation_contract_version === 2 ||
          (revision.citation_contract_version === 1 &&
            revision.citation_version === 1 &&
            !revisionsWithNativeCitations.has(revision.id));
    if (
      !contractIsValid ||
      revision.citation_version < 1 ||
      revision.citation_hash !==
        citationHash(revision.citation_contract_version, revisionCitations)
    ) {
      offending.add(revision.id);
    }
  }

  if (offending.size > 0) {
    const offendingIds = [...offending].sort().slice(0, PREFLIGHT_SAMPLE_LIMIT);
    logger.error(
      "state-store.migration_attention_citations_verification_failed",
      {
        offendingCount: offending.size,
        offendingIds,
      },
    );
    throw new NativeSddAttentionCitationsVerificationError(offendingIds);
  }
}

function installCitationTriggers(db: MigrationContext["db"]): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS spec_revision_citations_same_spec_insert
    BEFORE INSERT ON spec_revision_assumption_citations
    WHEN NOT EXISTS (
      SELECT 1 FROM spec_elements
      WHERE id = NEW.element_id AND spec_id = NEW.spec_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'citation element must belong to the same spec');
    END;

    CREATE TRIGGER IF NOT EXISTS spec_revision_citations_same_spec_update
    BEFORE UPDATE ON spec_revision_assumption_citations
    WHEN NOT EXISTS (
      SELECT 1 FROM spec_elements
      WHERE id = NEW.element_id AND spec_id = NEW.spec_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'citation element must belong to the same spec');
    END;

    CREATE TRIGGER IF NOT EXISTS spec_revision_citations_frozen_insert
    BEFORE INSERT ON spec_revision_assumption_citations
    WHEN COALESCE((
      SELECT state FROM spec_revisions WHERE id = NEW.revision_id
    ), '') <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'frozen revision citations require a draft');
    END;

    CREATE TRIGGER IF NOT EXISTS spec_revision_citations_frozen_update
    BEFORE UPDATE ON spec_revision_assumption_citations
    WHEN COALESCE((
      SELECT state FROM spec_revisions WHERE id = OLD.revision_id
    ), '') <> 'draft'
      OR COALESCE((
        SELECT state FROM spec_revisions WHERE id = NEW.revision_id
      ), '') <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'frozen revision citations require a draft');
    END;

    CREATE TRIGGER IF NOT EXISTS spec_revision_citations_frozen_delete
    BEFORE DELETE ON spec_revision_assumption_citations
    WHEN COALESCE((
      SELECT state FROM spec_revisions WHERE id = OLD.revision_id
    ), '') <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'frozen revision citations require a draft');
    END;

    CREATE TRIGGER IF NOT EXISTS spec_revision_citation_metadata_frozen_update
    BEFORE UPDATE OF
      citation_contract_version, citation_version, citation_hash
    ON spec_revisions
    WHEN OLD.state <> 'draft' AND (
      NEW.citation_contract_version <> OLD.citation_contract_version
      OR NEW.citation_version <> OLD.citation_version
      OR NEW.citation_hash <> OLD.citation_hash
    )
    BEGIN
      SELECT RAISE(ABORT, 'frozen revision citation metadata requires a draft');
    END;
  `);
}

function verifyCitationTriggers(db: MigrationContext["db"]): void {
  const frozenCitation = db
    .prepare(
      `SELECT citations.revision_id, citations.element_id,
              citations.assumption_id
       FROM spec_revision_assumption_citations AS citations
       JOIN spec_revisions AS revisions ON revisions.id = citations.revision_id
       WHERE revisions.state <> 'draft'
       ORDER BY citations.revision_id, citations.element_id,
                citations.assumption_id
       LIMIT 1`,
    )
    .get() as
    | { revision_id: string; element_id: string; assumption_id: string }
    | undefined;
  if (frozenCitation !== undefined) {
    let refused = false;
    try {
      db.prepare(
        `DELETE FROM spec_revision_assumption_citations
         WHERE revision_id = ? AND element_id = ? AND assumption_id = ?`,
      ).run(
        frozenCitation.revision_id,
        frozenCitation.element_id,
        frozenCitation.assumption_id,
      );
    } catch {
      refused = true;
    }
    if (!refused) {
      throw new NativeSddAttentionCitationsVerificationError([
        `${frozenCitation.revision_id}:citation-trigger`,
      ]);
    }
  }

  const frozenRevision = db
    .prepare(
      `SELECT id, citation_hash
       FROM spec_revisions
       WHERE state <> 'draft'
       ORDER BY id
       LIMIT 1`,
    )
    .get() as { id: string; citation_hash: string } | undefined;
  if (frozenRevision === undefined) return;
  const probeHash =
    frozenRevision.citation_hash === "0".repeat(64)
      ? "1".repeat(64)
      : "0".repeat(64);
  let refused = false;
  try {
    db.prepare("UPDATE spec_revisions SET citation_hash = ? WHERE id = ?").run(
      probeHash,
      frozenRevision.id,
    );
  } catch {
    refused = true;
  }
  if (!refused) {
    throw new NativeSddAttentionCitationsVerificationError([
      `${frozenRevision.id}:metadata-trigger`,
    ]);
  }
}

export interface NativeSddAttentionCitationsMigrationResult {
  readonly replayed: boolean;
  readonly questionCount: number;
  readonly assumptionCount: number;
  readonly citationCount: number;
}

export function applyNativeSddAttentionCitationsSchema(
  db: MigrationContext["db"],
): NativeSddAttentionCitationsMigrationResult {
  enforceCurrentSchemaCompatibility(
    db,
    db.name,
    NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION,
  );
  const alreadyMigrated = tableHasColumn(
    db,
    "spec_revisions",
    "citation_contract_version",
  );
  if (alreadyMigrated) {
    verifyMigratedState(db);
    installCitationTriggers(db);
    verifyCitationTriggers(db);
  } else {
    const offendingIds = [
      ...new Set([
        ...collectPreflightOffendingIds(db),
        ...revisionIntegrityOffendingIds(db),
      ]),
    ]
      .sort()
      .slice(0, PREFLIGHT_SAMPLE_LIMIT);
    if (offendingIds.length > 0) {
      logger.error(
        "state-store.migration_attention_citations_preflight_failed",
        {
          offendingCount: offendingIds.length,
          offendingIds,
        },
      );
      throw new NativeSddAttentionCitationsPreflightError(offendingIds);
    }

    rebuildAttentionTables(db);
    addCitationStorage(db);
    backfillCitations(db, new Date().toISOString());
    verifyMigratedState(db);
    installCitationTriggers(db);
    verifyCitationTriggers(db);
  }
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, description)
     VALUES (?, ?)`,
  ).run(
    NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION,
    MIGRATION_SCHEMA_DESCRIPTION,
  );

  const questionCount = db
    .prepare("SELECT COUNT(*) AS count FROM spec_questions")
    .get() as { count: number };
  const assumptionCount = db
    .prepare("SELECT COUNT(*) AS count FROM spec_assumptions")
    .get() as { count: number };
  const citationCount = db
    .prepare("SELECT COUNT(*) AS count FROM spec_revision_assumption_citations")
    .get() as { count: number };
  return {
    replayed: alreadyMigrated,
    questionCount: questionCount.count,
    assumptionCount: assumptionCount.count,
    citationCount: citationCount.count,
  };
}

export const nativeSddAttentionCitations: StateMigration = {
  name: "0034-native-sdd-attention-citations",
  up: async ({ context }) => {
    const startedAt = Date.now();
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION,
      );
    }

    const result = context.db
      .transaction(() => applyNativeSddAttentionCitationsSchema(context.db))
      .immediate();
    logger.info("state-store.migration_attention_citations_complete", {
      ...result,
      durationMs: Date.now() - startedAt,
    });
  },
};
