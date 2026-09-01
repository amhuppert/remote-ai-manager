import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import { specAssumptionCitationSnapshotSchema } from "@/lib/specs/schemas";
import { stableStringify } from "../serialization";
import { createSpecReviewRepo } from "../spec-review-repo";
import { createSpecsRepo } from "../specs-repo";
import { _createTestDb } from "../state-db";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";
import { createWriteQueue } from "../write-queue";
import { migrations } from "./index";
import {
  NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION,
  nativeSddAttentionCitations,
} from "./0034-native-sdd-attention-citations";

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpies,
}));

type Db = InstanceType<typeof Database>;

const CREATED_AT = "2026-08-23T10:00:00.000Z";
const EMPTY_CONTRACT_2_HASH_FOR_TEST =
  "551ce2879a567c8baca5a19f5af4385373bd63b916be6091fa891dd8a307d1df";
const AGENT = JSON.stringify({
  kind: "agent",
  conversationId: "conversation-1",
});

function createSchema10Db(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations (version, description)
      VALUES (10, 'graph-workflow candidate-unstable halt');

    CREATE TABLE projects (
      root_path TEXT PRIMARY KEY
    );
    INSERT INTO projects (root_path) VALUES ('/repos/project');

    CREATE TABLE specs (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      gate_policy_json TEXT NOT NULL,
      abandoned_at TEXT,
      abandoned_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE spec_aliases (
      project_path TEXT NOT NULL,
      slug TEXT NOT NULL,
      spec_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_path, slug)
    );
    CREATE TABLE spec_counters (
      spec_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      last_number INTEGER NOT NULL,
      PRIMARY KEY (spec_id, scope_key)
    );
    CREATE TABLE spec_elements (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      number INTEGER,
      parent_element_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
    );
    CREATE TABLE spec_revisions (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      state TEXT NOT NULL,
      authoring_stage TEXT NOT NULL,
      based_on_revision_id TEXT,
      content_hash TEXT,
      proposed_at TEXT,
      approved_at TEXT,
      external_delivery_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (spec_id, number),
      FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
    );
    CREATE TABLE spec_element_versions (
      revision_id TEXT NOT NULL,
      element_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      element_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (revision_id, element_id),
      FOREIGN KEY (revision_id) REFERENCES spec_revisions(id) ON DELETE CASCADE,
      FOREIGN KEY (element_id) REFERENCES spec_elements(id) ON DELETE CASCADE
    );
    CREATE TABLE spec_revision_supersessions (
      revision_id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      superseded_by_revision_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      dismissed_at TEXT NOT NULL
    );
    CREATE TABLE spec_approvals (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      element_id TEXT,
      revision_id TEXT NOT NULL,
      approver TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      validity TEXT NOT NULL
    );
    CREATE TABLE spec_gate_admissions (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      gate TEXT NOT NULL,
      basis TEXT NOT NULL,
      approval_id TEXT,
      revision_id TEXT,
      execution_id TEXT,
      actor_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE spec_questions (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      element_id TEXT,
      text TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'answered')),
      answer TEXT,
      answered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (spec_id, number),
      FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
      FOREIGN KEY (element_id) REFERENCES spec_elements(id)
    );
    CREATE TABLE spec_assumptions (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      element_id TEXT,
      text TEXT NOT NULL,
      proposed_by_json TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN (
        'proposed', 'confirmed', 'rejected', 'deferred'
      )),
      disposed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (spec_id, number),
      FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
      FOREIGN KEY (element_id) REFERENCES spec_elements(id)
    );
    CREATE TABLE spec_comments (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      parent_comment_id TEXT,
      element_id TEXT NOT NULL,
      anchor_json TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      body TEXT NOT NULL,
      author_json TEXT NOT NULL,
      blocking INTEGER NOT NULL,
      resolution TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    "spec-1",
    "/repos/project",
    "spec-one",
    "Spec one",
    JSON.stringify({ preset: "contract-bearing" }),
    CREATED_AT,
    CREATED_AT,
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    "spec-2",
    "/repos/project",
    "spec-two",
    "Spec two",
    JSON.stringify({ preset: "contract-bearing" }),
    CREATED_AT,
    CREATED_AT,
  );
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, 'requirement', 1, NULL, ?)`,
  ).run("requirement-1", "spec-1", CREATED_AT);
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, 'requirement', 1, NULL, ?)`,
  ).run("other-requirement-1", "spec-2", CREATED_AT);
  return db;
}

async function runMigration(db: Db): Promise<void> {
  await nativeSddAttentionCitations.up({
    name: nativeSddAttentionCitations.name,
    context: { db, configDir: null },
  });
}

function columns(db: Db, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

function insertQuestion(
  db: Db,
  input: {
    id: string;
    elementId?: string | null;
    provenance?: string;
    status?: "open" | "answered";
    answer?: string | null;
    answeredAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO spec_questions (
       id, spec_id, number, element_id, text, provenance_json,
       status, answer, answered_at, created_at, updated_at
     ) VALUES (?, 'spec-1', 1, ?, 'Question?', ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.elementId ?? null,
    input.provenance ?? AGENT,
    input.status ?? "open",
    input.answer ?? null,
    input.answeredAt ?? null,
    CREATED_AT,
    CREATED_AT,
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

const REQUIREMENT_PAYLOAD = {
  kind: "requirement",
  statement: "The system shall quiesce writers during cutover.",
  priority: "must",
  risk: "high",
} as const;

function seedRevision(
  db: Db,
  input: {
    id: string;
    number: number;
    state: "draft" | "approved" | "proposed" | "withdrawn";
    proposedAt: string | null;
    contentHash?: string;
    elements?: Array<{
      elementId: string;
      kind: string;
      number: number | null;
      parentElementId: string | null;
      position: number;
      payload: Record<string, unknown>;
    }>;
  },
): void {
  const canonicalElements = input.elements ?? [
    {
      elementId: "requirement-1",
      kind: "requirement",
      number: 1,
      parentElementId: null,
      position: 0,
      payload: REQUIREMENT_PAYLOAD,
    },
  ];
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, based_on_revision_id,
       content_hash, proposed_at, approved_at, external_delivery_json, created_at
     ) VALUES (?, 'spec-1', ?, ?, 'requirements', NULL, ?, ?, ?, NULL, ?)`,
  ).run(
    input.id,
    input.number,
    input.state,
    input.contentHash ??
      sha256({ authoringStage: "requirements", elements: canonicalElements }),
    input.proposedAt,
    input.state === "approved" ? "2026-08-23T10:02:00.000Z" : null,
    CREATED_AT,
  );
  const insertElementVersion = db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  for (const element of canonicalElements) {
    insertElementVersion.run(
      input.id,
      element.elementId,
      element.position,
      stableStringify(element.payload),
      sha256(element.payload),
      CREATED_AT,
      CREATED_AT,
    );
  }
}

function seedAssumption(
  db: Db,
  input: {
    id: string;
    number: number;
    createdAt: string;
    elementId: string | null;
    disposition?: "proposed" | "confirmed";
  },
): void {
  const disposition = input.disposition ?? "proposed";
  const disposedAt =
    disposition === "confirmed" ? "2026-08-23T10:03:00.000Z" : null;
  db.prepare(
    `INSERT INTO spec_assumptions (
       id, spec_id, number, element_id, text, proposed_by_json,
       disposition, disposed_at, created_at, updated_at
     ) VALUES (?, 'spec-1', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.number,
    input.elementId,
    `Assumption ${input.number}`,
    AGENT,
    disposition,
    disposedAt,
    input.createdAt,
    disposedAt ?? input.createdAt,
  );
}

function citationHash(
  contractVersion: 1 | 2,
  rows: Array<{
    element_id: string;
    assumption_id: string;
    assumption_snapshot_json: string;
  }>,
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

describe("0034-native-sdd-attention-citations", () => {
  it("is a registered schema-11 compatibility cutover", () => {
    expect(NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION).toBe(11);
    expect(migrations).toContain(nativeSddAttentionCitations);
    const index = migrations.findIndex(
      (migration) => migration.name === "0034-native-sdd-attention-citations",
    );
    expect(index).toBeGreaterThanOrEqual(0);
    // This migration stamps schema 11, but it is no longer the last cutover, so
    // its expectation is pinned to its own frozen constant rather than the
    // moving KNOWN_SCHEMA_VERSION. Everything registered after it is declared
    // here so an append is deliberate rather than silent: purely additive
    // migrations (a table no older build reads) are compatibility-neutral on
    // either side of the stamp, and a later cutover that flips the version
    // again must order after them.
    expect(
      migrations.slice(index + 1).map((migration) => migration.name),
    ).toEqual([
      "0035-add-notepads",
      "0035-generalized-model-selection",
      "0036-add-notepad-comments",
      "0037-add-notepad-delivery-watermarks",
      "0038-ticket-relationships-and-status-updates",
    ]);
  });

  it.each([
    {
      label: "contradictory lifecycle",
      insert(db: Db) {
        insertQuestion(db, {
          id: "question-contradictory",
          status: "open",
          answer: "An open question cannot already be answered.",
        });
      },
      expectedId: "question-contradictory",
    },
    {
      label: "invalid provenance",
      insert(db: Db) {
        insertQuestion(db, {
          id: "question-invalid-provenance",
          provenance: JSON.stringify({ kind: "agent" }),
        });
      },
      expectedId: "question-invalid-provenance",
    },
    {
      label: "cross-spec attachment",
      insert(db: Db) {
        insertQuestion(db, {
          id: "question-cross-spec",
          elementId: "other-requirement-1",
        });
      },
      expectedId: "question-cross-spec",
    },
  ])("refuses $label before changing the schema", async (scenario) => {
    const db = createSchema10Db();
    try {
      scenario.insert(db);

      await expect(runMigration(db)).rejects.toThrow(scenario.expectedId);
      expect(columns(db, "spec_questions")).not.toContain("record_version");
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spec_revision_assumption_citations'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 11",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("atomically rebuilds rows, backfills exact draft/frozen citations, hashes them, installs triggers, and replays", async () => {
    const db = createSchema10Db();
    try {
      seedRevision(db, {
        id: "revision-approved",
        number: 1,
        state: "approved",
        proposedAt: "2026-08-23T10:01:00.000Z",
      });
      seedRevision(db, {
        id: "revision-draft",
        number: 2,
        state: "draft",
        proposedAt: null,
      });
      insertQuestion(db, { id: "question-open" });
      seedAssumption(db, {
        id: "assumption-before-cutoff",
        number: 1,
        createdAt: "2026-08-23T10:00:30.000Z",
        elementId: "requirement-1",
      });
      seedAssumption(db, {
        id: "assumption-after-cutoff",
        number: 2,
        createdAt: "2026-08-23T10:02:00.000Z",
        elementId: "requirement-1",
        disposition: "confirmed",
      });
      seedAssumption(db, {
        id: "assumption-spec-level",
        number: 3,
        createdAt: "2026-08-23T10:00:30.000Z",
        elementId: null,
      });

      await runMigration(db);
      await runMigration(db);

      expect(columns(db, "spec_questions")).toEqual(
        expect.arrayContaining(["record_version", "withdrawn_at"]),
      );
      expect(columns(db, "spec_assumptions")).toEqual(
        expect.arrayContaining([
          "record_version",
          "withdrawn_at",
          "supersedes_assumption_id",
          "supersession_operation_id",
          "supersession_request_hash",
        ]),
      );
      expect(columns(db, "spec_revisions")).toEqual(
        expect.arrayContaining([
          "citation_contract_version",
          "citation_version",
          "citation_hash",
        ]),
      );
      expect(
        db
          .prepare(
            "SELECT id, record_version, withdrawn_at FROM spec_questions ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "question-open", record_version: 1, withdrawn_at: null },
      ]);
      expect(
        db
          .prepare(
            `SELECT id, record_version, withdrawn_at,
                    supersedes_assumption_id, supersession_operation_id,
                    supersession_request_hash
             FROM spec_assumptions ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "assumption-after-cutoff",
          record_version: 1,
          withdrawn_at: null,
          supersedes_assumption_id: null,
          supersession_operation_id: null,
          supersession_request_hash: null,
        },
        {
          id: "assumption-before-cutoff",
          record_version: 1,
          withdrawn_at: null,
          supersedes_assumption_id: null,
          supersession_operation_id: null,
          supersession_request_hash: null,
        },
        {
          id: "assumption-spec-level",
          record_version: 1,
          withdrawn_at: null,
          supersedes_assumption_id: null,
          supersession_operation_id: null,
          supersession_request_hash: null,
        },
      ]);

      const citationRows = db
        .prepare(
          `SELECT revision_id, element_id, assumption_id,
                  assumption_snapshot_json
           FROM spec_revision_assumption_citations
           ORDER BY revision_id, element_id, assumption_id`,
        )
        .all() as Array<{
        revision_id: string;
        element_id: string;
        assumption_id: string;
        assumption_snapshot_json: string;
      }>;
      expect(
        citationRows.map(({ revision_id, assumption_id }) => ({
          revision_id,
          assumption_id,
        })),
      ).toEqual([
        {
          revision_id: "revision-approved",
          assumption_id: "assumption-before-cutoff",
        },
        {
          revision_id: "revision-draft",
          assumption_id: "assumption-after-cutoff",
        },
        {
          revision_id: "revision-draft",
          assumption_id: "assumption-before-cutoff",
        },
      ]);
      for (const row of citationRows) {
        const snapshot = specAssumptionCitationSnapshotSchema.parse(
          JSON.parse(row.assumption_snapshot_json),
        );
        expect(snapshot.captureKind).toBe("legacy_backfill");
        expect(snapshot.assumptionId).toBe(row.assumption_id);
      }

      const revisions = db
        .prepare(
          `SELECT id, state, content_hash, citation_contract_version,
                  citation_version, citation_hash
           FROM spec_revisions ORDER BY id`,
        )
        .all() as Array<{
        id: string;
        state: string;
        content_hash: string;
        citation_contract_version: 1 | 2;
        citation_version: number;
        citation_hash: string;
      }>;
      for (const revision of revisions) {
        const rows = citationRows.filter(
          (row) => row.revision_id === revision.id,
        );
        expect(revision.citation_contract_version).toBe(
          revision.state === "draft" ? 2 : 1,
        );
        expect(revision.citation_version).toBe(1);
        expect(revision.citation_hash).toBe(
          citationHash(revision.citation_contract_version, rows),
        );
        expect(revision.content_hash).toHaveLength(64);
      }

      expect(() =>
        db
          .prepare(
            `DELETE FROM spec_revision_assumption_citations
             WHERE revision_id = 'revision-approved'`,
          )
          .run(),
      ).toThrow(/frozen|draft/i);
      expect(() =>
        db
          .prepare(
            `UPDATE spec_revisions SET citation_hash = ?
             WHERE id = 'revision-approved'`,
          )
          .run("f".repeat(64)),
      ).toThrow(/frozen|draft/i);

      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() =>
        enforceCurrentSchemaCompatibility(db, ":memory:", 10),
      ).toThrow(/schema/i);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 11",
          )
          .get(),
      ).toEqual({ count: 1 });

      const specsRepo = createSpecsRepo(db, createWriteQueue());
      const reviewRepo = createSpecReviewRepo(db);
      const approvedSnapshot =
        await specsRepo.getRevisionSnapshot("revision-approved");
      expect(approvedSnapshot).toMatchObject({
        revision: {
          citationContractVersion: 1,
          citationVersion: 1,
        },
        assumptionCitations: [
          {
            elementId: "requirement-1",
            assumptionId: "assumption-before-cutoff",
            snapshot: {
              captureKind: "legacy_backfill",
              recordVersion: 1,
            },
          },
        ],
      });
      expect(reviewRepo.findQuestionById("question-open")).toMatchObject({
        record_version: 1,
        withdrawn_at: null,
      });
      expect(
        reviewRepo.findAssumptionById("assumption-before-cutoff"),
      ).toMatchObject({
        record_version: 1,
        withdrawn_at: null,
        supersedes_assumption_id: null,
      });
    } finally {
      db.close();
    }
  });

  it("replays after a post-cutover contract-2 revision is proposed and approved", async () => {
    const db = createSchema10Db();
    try {
      seedRevision(db, {
        id: "revision-post-cutover",
        number: 1,
        state: "draft",
        proposedAt: null,
      });
      await runMigration(db);

      const specsRepo = createSpecsRepo(db, createWriteQueue());
      await expect(
        specsRepo.proposeRevision({
          revisionId: "revision-post-cutover",
          proposedAt: "2026-08-23T10:04:00.000Z",
        }),
      ).resolves.toMatchObject({
        state: "proposed",
        citationContractVersion: 2,
      });
      await expect(runMigration(db)).resolves.toBeUndefined();

      await expect(
        specsRepo.approveRevision({
          revisionId: "revision-post-cutover",
          approvedAt: "2026-08-23T10:05:00.000Z",
        }),
      ).resolves.toMatchObject({
        state: "approved",
        citationContractVersion: 2,
      });
      await expect(runMigration(db)).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("materializes and hashes Unicode citation tuples in UTF-16 code-unit order", async () => {
    const db = createSchema10Db();
    try {
      const unicodeElements = [
        { id: "requirement-Z", number: 2 },
        { id: "requirement-\u00c5", number: 3 },
        { id: "requirement-\u{10000}", number: 4 },
        { id: "requirement-\ue000", number: 5 },
      ];
      const insertElement = db.prepare(
        `INSERT INTO spec_elements (
           id, spec_id, kind, number, parent_element_id, created_at
         ) VALUES (?, 'spec-1', 'requirement', ?, NULL, ?)`,
      );
      for (const element of unicodeElements) {
        insertElement.run(element.id, element.number, CREATED_AT);
      }

      const revisionElements = [
        {
          elementId: "requirement-1",
          kind: "requirement",
          number: 1,
          parentElementId: null,
          position: 0,
          payload: REQUIREMENT_PAYLOAD,
        },
        ...unicodeElements.map((element, index) => ({
          elementId: element.id,
          kind: "requirement",
          number: element.number,
          parentElementId: null,
          position: index + 1,
          payload: {
            ...REQUIREMENT_PAYLOAD,
            statement: `Unicode citation subject ${element.number}.`,
          },
        })),
      ];
      seedRevision(db, {
        id: "revision-unicode-citations",
        number: 1,
        state: "draft",
        proposedAt: null,
        elements: revisionElements,
      });

      const assumptionIds = [
        "assumption-Z",
        "assumption-\u00c5",
        "assumption-\u{10000}",
        "assumption-\ue000",
      ];
      for (const [index, assumptionId] of assumptionIds.entries()) {
        seedAssumption(db, {
          id: assumptionId,
          number: index + 1,
          createdAt: CREATED_AT,
          elementId: "requirement-Z",
        });
      }
      for (const [index, element] of unicodeElements.slice(1).entries()) {
        seedAssumption(db, {
          id: `assumption-element-${index + 1}`,
          number: assumptionIds.length + index + 1,
          createdAt: CREATED_AT,
          elementId: element.id,
        });
      }

      await runMigration(db);

      const citationRows = db
        .prepare(
          `SELECT revision_id, element_id, assumption_id,
                  assumption_snapshot_json
           FROM spec_revision_assumption_citations
           WHERE revision_id = 'revision-unicode-citations'`,
        )
        .all() as Array<{
        revision_id: string;
        element_id: string;
        assumption_id: string;
        assumption_snapshot_json: string;
      }>;
      const codeUnitRows = [...citationRows].sort(
        (left, right) =>
          (left.element_id === right.element_id
            ? 0
            : left.element_id < right.element_id
              ? -1
              : 1) ||
          (left.assumption_id === right.assumption_id
            ? 0
            : left.assumption_id < right.assumption_id
              ? -1
              : 1),
      );
      const expectedTuples = [
        ["requirement-Z", "assumption-Z"],
        ["requirement-Z", "assumption-\u00c5"],
        ["requirement-Z", "assumption-\u{10000}"],
        ["requirement-Z", "assumption-\ue000"],
        ["requirement-\u00c5", "assumption-element-1"],
        ["requirement-\u{10000}", "assumption-element-2"],
        ["requirement-\ue000", "assumption-element-3"],
      ];
      expect(
        codeUnitRows.map((row) => [row.element_id, row.assumption_id]),
      ).toEqual(expectedTuples);
      expect(
        db
          .prepare(
            `SELECT citation_contract_version, citation_hash
             FROM spec_revisions
             WHERE id = 'revision-unicode-citations'`,
          )
          .get(),
      ).toEqual({
        citation_contract_version: 2,
        citation_hash: citationHash(2, codeUnitRows),
      });

      const specsRepo = createSpecsRepo(db, createWriteQueue());
      const snapshot = await specsRepo.getRevisionSnapshot(
        "revision-unicode-citations",
      );
      expect(
        snapshot?.assumptionCitations.map((citation) => [
          citation.elementId,
          citation.assumptionId,
        ]),
      ).toEqual(expectedTuples);
    } finally {
      db.close();
    }
  });

  it("preserves frozen tied-element hashes in SQLite byte order through cutover and replay", async () => {
    const db = createSchema10Db();
    try {
      const astralId = "requirement-\u{10000}";
      const privateUseId = "requirement-\ue000";
      const insertElement = db.prepare(
        `INSERT INTO spec_elements (
           id, spec_id, kind, number, parent_element_id, created_at
         ) VALUES (?, 'spec-1', 'requirement', ?, NULL, ?)`,
      );
      insertElement.run(astralId, 2, CREATED_AT);
      insertElement.run(privateUseId, 3, CREATED_AT);

      seedRevision(db, {
        id: "revision-unicode-elements",
        number: 1,
        state: "approved",
        proposedAt: "2026-08-23T10:01:00.000Z",
        elements: [
          {
            elementId: privateUseId,
            kind: "requirement",
            number: 3,
            parentElementId: null,
            position: 0,
            payload: {
              ...REQUIREMENT_PAYLOAD,
              statement: "Private-use requirement.",
            },
          },
          {
            elementId: astralId,
            kind: "requirement",
            number: 2,
            parentElementId: null,
            position: 0,
            payload: {
              ...REQUIREMENT_PAYLOAD,
              statement: "Astral requirement.",
            },
          },
        ],
      });
      const before = db
        .prepare(
          "SELECT content_hash FROM spec_revisions WHERE id = 'revision-unicode-elements'",
        )
        .get() as { content_hash: string };

      await runMigration(db);
      expect(
        db
          .prepare(
            "SELECT content_hash FROM spec_revisions WHERE id = 'revision-unicode-elements'",
          )
          .get(),
      ).toEqual(before);
      await runMigration(db);
      expect(
        db
          .prepare(
            "SELECT content_hash FROM spec_revisions WHERE id = 'revision-unicode-elements'",
          )
          .get(),
      ).toEqual(before);

      const specsRepo = createSpecsRepo(db, createWriteQueue());
      const snapshot = await specsRepo.getRevisionSnapshot(
        "revision-unicode-elements",
      );
      expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
        privateUseId,
        astralId,
      ]);
      await expect(
        specsRepo.verifyRevision("revision-unicode-elements"),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      db.close();
    }
  });

  it("rolls back every structural change when integrity verification fails", async () => {
    const db = createSchema10Db();
    try {
      seedRevision(db, {
        id: "revision-bad-hash",
        number: 1,
        state: "approved",
        proposedAt: "2026-08-23T10:01:00.000Z",
        contentHash: "0".repeat(64),
      });

      await expect(runMigration(db)).rejects.toThrow(/revision-bad-hash/);
      expect(columns(db, "spec_revisions")).not.toContain(
        "citation_contract_version",
      );
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spec_revision_assumption_citations'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 11",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("keeps the synchronous fresh/in-memory floor at schema-11 parity", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      expect(columns(db, "spec_questions")).toEqual(
        expect.arrayContaining(["record_version", "withdrawn_at"]),
      );
      expect(columns(db, "spec_assumptions")).toEqual(
        expect.arrayContaining([
          "record_version",
          "withdrawn_at",
          "supersedes_assumption_id",
        ]),
      );
      expect(columns(db, "spec_revisions")).toEqual(
        expect.arrayContaining([
          "citation_contract_version",
          "citation_version",
          "citation_hash",
        ]),
      );
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_revision_assumption_citations'",
          )
          .get(),
      ).toEqual({ name: "spec_revision_assumption_citations" });
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'trigger' AND name LIKE 'spec_revision_citation%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual(
        expect.arrayContaining([
          { name: "spec_revision_citation_metadata_frozen_update" },
          { name: "spec_revision_citations_frozen_delete" },
          { name: "spec_revision_citations_frozen_insert" },
          { name: "spec_revision_citations_frozen_update" },
        ]),
      );

      db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
        "/repos/floor",
      );
      db.prepare(
        `INSERT INTO specs (
           id, project_path, slug, name, gate_policy_json,
           created_at, updated_at
         ) VALUES ('spec-floor', '/repos/floor', 'floor', 'Floor', ?, ?, ?)`,
      ).run(
        JSON.stringify({ preset: "contract-bearing" }),
        CREATED_AT,
        CREATED_AT,
      );
      db.prepare(
        `INSERT INTO spec_revisions (
           id, spec_id, number, state, authoring_stage,
           based_on_revision_id, content_hash, proposed_at, approved_at,
           external_delivery_json, created_at
         ) VALUES (
           'revision-floor', 'spec-floor', 1, 'draft', 'requirements',
           NULL, NULL, NULL, NULL, NULL, ?
         )`,
      ).run(CREATED_AT);
      expect(
        db
          .prepare(
            `SELECT citation_contract_version, citation_version, citation_hash
             FROM spec_revisions WHERE id = 'revision-floor'`,
          )
          .get(),
      ).toEqual({
        citation_contract_version: 2,
        citation_version: 1,
        citation_hash: EMPTY_CONTRACT_2_HASH_FOR_TEST,
      });

      expect(() =>
        db
          .prepare(
            `INSERT INTO spec_questions (
               id, spec_id, number, element_id, text, provenance_json,
               record_version, status, answer, answered_at, withdrawn_at,
               created_at, updated_at
             ) VALUES (
               'question-bad-floor', 'spec-floor', 1, NULL, 'Question?', ?,
               1, 'open', 'already answered', NULL, NULL, ?, ?
             )`,
          )
          .run(AGENT, CREATED_AT, CREATED_AT),
      ).toThrow(/check constraint/i);
    } finally {
      db.close();
    }
  });
});
