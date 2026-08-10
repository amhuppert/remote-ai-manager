import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import BetterSqlite3 from "better-sqlite3";
import {
  loadSpecExportState,
  renderCanonicalBundle,
  verifyExportState,
} from "@/lib/specs/export";
import { evidenceEvaluatedStateSchema } from "@/lib/specs/schemas";
import { runMigrations } from "../migrator";
import { createSpecReviewRepo } from "../spec-review-repo";
import {
  SchemaVersionConflictError,
  enforceSqliteSchemaCompatibility,
  schemaCompatibilityBarrierPath,
} from "../schema-compatibility";
import { stableStringify } from "../serialization";
import { createSpecDeliveryRepo } from "../spec-delivery-repo";
import { createSpecEventsRepo } from "../spec-events-repo";
import { createSpecsRepo } from "../specs-repo";
import { _createTestDb, _createTestDbAtPath } from "../state-db";
import { createWriteQueue } from "../write-queue";
import { addSpecAuthoringStage } from "./0008-add-spec-authoring-stage";
import { narrowEvidenceKinds } from "./0009-narrow-evidence-kinds";

type Db = InstanceType<typeof BetterSqlite3>;

const PROJECT_PATH = "/repos/legacy-evidence";
const SPEC_ID = "spec-legacy";
const REVISION_ID = "revision-legacy";
const EXECUTION_ID = "execution-legacy";
const AT = "2026-07-01T00:00:00.000Z";

const NOTE_MARKER =
  "[migration 0009] Evidence kinds screenshot could not machine-prove this criterion after the vocabulary narrowed; a validator verdict is now required.";

/**
 * Frozen snapshot of the pre-narrowing `spec_evidence` DDL. A real upgraded
 * database keeps this permissive CHECK forever (`CREATE TABLE IF NOT EXISTS`
 * never rewrites an existing table); recreating it here is what lets the
 * fixture seed dropped-kind rows that the narrowed floor would refuse.
 */
const LEGACY_SPEC_EVIDENCE_DDL = `
  CREATE TABLE spec_evidence (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    criterion_element_id  TEXT NOT NULL,
    revision_id           TEXT NOT NULL,
    kind                  TEXT NOT NULL CHECK (kind IN (
      'diff', 'commit', 'test_run', 'validator_verdict', 'screenshot',
      'human_signoff'
    )),
    ref_json              TEXT NOT NULL,
    evaluated_state_json  TEXT NOT NULL,
    producer_json         TEXT NOT NULL,
    execution_id          TEXT,
    source_event_id       INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );
`;

const openDbs: Db[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface LegacyElement {
  id: string;
  kind: "requirement" | "criterion" | "task";
  number: number;
  parentElementId: string | null;
  position: number;
  payload: Record<string, unknown>;
}

const LEGACY_ELEMENTS: LegacyElement[] = [
  {
    id: "requirement-1",
    kind: "requirement",
    number: 1,
    parentElementId: null,
    position: 0,
    payload: {
      kind: "requirement",
      statement: "Legacy strategies survive the vocabulary narrowing.",
      priority: "must",
      risk: "high",
    },
  },
  {
    id: "criterion-a",
    kind: "criterion",
    number: 1,
    parentElementId: "requirement-1",
    position: 1,
    payload: {
      kind: "criterion",
      text: "Strips the dropped kind while keeping the machine kind.",
      validationStrategy: { kinds: ["test_run", "diff"] },
    },
  },
  {
    id: "criterion-b",
    kind: "criterion",
    number: 2,
    parentElementId: "requirement-1",
    position: 2,
    payload: {
      kind: "criterion",
      text: "A screenshot-only strategy falls back to a validator verdict.",
      validationStrategy: {
        kinds: ["screenshot"],
        note: "Existing operator note.",
      },
    },
  },
  {
    id: "criterion-c",
    kind: "criterion",
    number: 3,
    parentElementId: "requirement-1",
    position: 3,
    payload: {
      kind: "criterion",
      text: "An empty strategy gains a validator verdict.",
      validationStrategy: { kinds: [] },
    },
  },
  {
    id: "criterion-d",
    kind: "criterion",
    number: 4,
    parentElementId: "requirement-1",
    position: 4,
    payload: {
      kind: "criterion",
      text: "A commit-only strategy keeps its commit and gains a verdict.",
      validationStrategy: { kinds: ["commit"] },
    },
  },
  {
    id: "task-1",
    kind: "task",
    number: 1,
    parentElementId: null,
    position: 5,
    payload: {
      kind: "task",
      title: "Deliver the legacy criterion",
      instructions: "Cover criterion-a.",
      tracedRequirementElementIds: ["requirement-1"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["criterion-a"],
      dependsOnTaskElementIds: [],
    },
  },
];

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function legacyContentHash(): string {
  return sha256({
    authoringStage: "plan",
    elements: LEGACY_ELEMENTS.map((element) => ({
      elementId: element.id,
      kind: element.kind,
      number: element.number,
      parentElementId: element.parentElementId,
      position: element.position,
      payload: element.payload,
    })),
  });
}

function freshDb(): Db {
  const db = _createTestDb({ inMemory: true });
  openDbs.push(db);
  return db;
}

function seedLegacyWorld(db: Db, options?: { contentHash?: string }): void {
  db.exec("DROP TABLE spec_evidence");
  db.exec(LEGACY_SPEC_EVIDENCE_DDL);

  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, 'legacy-evidence', 'Legacy evidence', ?, NULL, NULL, ?, ?)`,
  ).run(SPEC_ID, PROJECT_PATH, '{"preset":"contract-bearing"}', AT, AT);
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, based_on_revision_id,
       content_hash, proposed_at, approved_at, created_at
     ) VALUES (?, ?, 1, 'approved', 'plan', NULL, ?, ?, ?, ?)`,
  ).run(
    REVISION_ID,
    SPEC_ID,
    options?.contentHash ?? legacyContentHash(),
    AT,
    AT,
    AT,
  );
  const insertElement = db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  for (const element of LEGACY_ELEMENTS) {
    insertElement.run(
      element.id,
      SPEC_ID,
      element.kind,
      element.number,
      element.parentElementId,
      AT,
    );
    insertVersion.run(
      REVISION_ID,
      element.id,
      element.position,
      stableStringify(element.payload),
      sha256(element.payload),
      AT,
      AT,
    );
  }
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, '{}', 'running', 'workflow-definition-legacy',
               'workflow-execution-legacy', NULL, NULL, NULL, ?, ?)`,
  ).run(EXECUTION_ID, SPEC_ID, REVISION_ID, AT, AT);

  const insertEvidence = db.prepare(
    `INSERT INTO spec_evidence (
       id, spec_id, criterion_element_id, revision_id, kind, ref_json,
       evaluated_state_json, producer_json, execution_id, source_event_id,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvidence.run(
    "evidence-dropped",
    SPEC_ID,
    "criterion-b",
    REVISION_ID,
    "screenshot",
    JSON.stringify({ type: "content_store", objectKey: "captures/legacy" }),
    JSON.stringify({ relevantPaths: [], surfaceId: "spec-studio/legacy" }),
    JSON.stringify({ kind: "human" }),
    EXECUTION_ID,
    null,
    AT,
  );
  insertEvidence.run(
    "evidence-surviving",
    SPEC_ID,
    "criterion-a",
    REVISION_ID,
    "validator_verdict",
    JSON.stringify({
      type: "workflow_event",
      workflowExecutionId: "workflow-execution-legacy",
      eventId: 7,
      contextId: "context-legacy",
    }),
    JSON.stringify({
      commitSha: "legacy-sha",
      relevantPaths: ["src/lib/alias.ts"],
      relevantTreeHash: "legacy-tree",
      surfaceId: "spec-studio/retained",
    }),
    JSON.stringify({ kind: "agent", conversationId: "conversation-legacy" }),
    EXECUTION_ID,
    7,
    AT,
  );
  insertEvidence.run(
    "evidence-commit",
    SPEC_ID,
    "criterion-d",
    REVISION_ID,
    "commit",
    JSON.stringify({ type: "git_object", objectId: "legacy-commit-sha" }),
    JSON.stringify({ commitSha: "legacy-commit-sha", relevantPaths: [] }),
    JSON.stringify({ kind: "agent", conversationId: "conversation-legacy" }),
    EXECUTION_ID,
    8,
    AT,
  );

  const insertVerdict = db.prepare(
    `INSERT INTO spec_proof_verdicts (
       id, spec_id, criterion_element_id, revision_id, execution_id,
       verdict_kind, evidence_ids_json, verdict_at, stale_at, stale_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  );
  insertVerdict.run(
    "verdict-citing",
    SPEC_ID,
    "criterion-b",
    REVISION_ID,
    EXECUTION_ID,
    "agent_validator",
    JSON.stringify(["evidence-dropped", "evidence-surviving"]),
    AT,
  );
  insertVerdict.run(
    "verdict-clean",
    SPEC_ID,
    "criterion-a",
    REVISION_ID,
    EXECUTION_ID,
    "deterministic_validator",
    JSON.stringify(["evidence-surviving"]),
    AT,
  );
  // Legacy code accepted a current verdict citing nothing against criterion-c's
  // empty strategy, and one citing only commit evidence against criterion-d's
  // commit-only strategy. Neither cites a dropped row, so evidence deletion
  // alone leaves both current after the migration strengthens the strategies.
  insertVerdict.run(
    "verdict-empty",
    SPEC_ID,
    "criterion-c",
    REVISION_ID,
    EXECUTION_ID,
    "agent_validator",
    JSON.stringify([]),
    AT,
  );
  insertVerdict.run(
    "verdict-commit-only",
    SPEC_ID,
    "criterion-d",
    REVISION_ID,
    EXECUTION_ID,
    "agent_validator",
    JSON.stringify(["evidence-commit"]),
    AT,
  );

  db.prepare(
    `INSERT INTO spec_task_claims (
       id, spec_id, task_element_id, execution_id, actor_json,
       evidence_ids_json, claimed_at, status
     ) VALUES (?, ?, 'task-1', ?, ?, ?, ?, 'accepted')`,
  ).run(
    "claim-citing",
    SPEC_ID,
    EXECUTION_ID,
    JSON.stringify({ kind: "agent", conversationId: "conversation-legacy" }),
    JSON.stringify(["evidence-dropped"]),
    AT,
  );
}

async function runNarrowing(db: Db): Promise<void> {
  await narrowEvidenceKinds.up({
    name: narrowEvidenceKinds.name,
    context: { db, configDir: null },
  });
}

function strategyOf(
  snapshot: {
    elements: readonly {
      element: { id: string };
      version: { payload: unknown };
    }[];
  },
  elementId: string,
): { kinds: string[]; note?: string } {
  const entry = snapshot.elements.find(
    ({ element }) => element.id === elementId,
  );
  if (entry === undefined) throw new Error(`element ${elementId} missing`);
  const payload = entry.version.payload as {
    validationStrategy: { kinds: string[]; note?: string };
  };
  return payload.validationStrategy;
}

function dumpState(db: Db): string {
  const tables = [
    "spec_element_versions",
    "spec_revisions",
    "spec_evidence",
    "spec_proof_verdicts",
    "spec_task_claims",
    "spec_events",
    "schema_migrations",
  ];
  return JSON.stringify(
    tables.map((table) => ({
      table,
      rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    })),
  );
}

describe("0009-narrow-evidence-kinds", () => {
  it("rewrites strategies, repairs hashes, deletes dropped evidence, and invalidates dependents", async () => {
    const db = freshDb();
    seedLegacyWorld(db);

    await runNarrowing(db);

    // Strict read path is total: the live repository parses every payload.
    const specs = createSpecsRepo(db, createWriteQueue());
    const snapshot = await specs.getRevisionSnapshot(REVISION_ID);
    if (snapshot === null) throw new Error("snapshot missing");
    expect(strategyOf(snapshot, "criterion-a")).toEqual({
      kinds: ["test_run"],
    });
    expect(strategyOf(snapshot, "criterion-b")).toEqual({
      kinds: ["validator_verdict"],
      note: `Existing operator note.\n\n${NOTE_MARKER}`,
    });
    expect(strategyOf(snapshot, "criterion-c")).toEqual({
      kinds: ["validator_verdict"],
      note: "[migration 0009] Evidence kinds (none) could not machine-prove this criterion after the vocabulary narrowed; a validator verdict is now required.",
    });
    expect(strategyOf(snapshot, "criterion-d")).toEqual({
      kinds: ["commit", "validator_verdict"],
      note: "[migration 0009] Evidence kinds commit could not machine-prove this criterion after the vocabulary narrowed; a validator verdict is now required.",
    });

    // Hashes were recomputed with the rewritten payloads: the live
    // verification (live hash functions) accepts the migrated bytes.
    await expect(specs.verifyRevision(REVISION_ID)).resolves.toMatchObject({
      ok: true,
    });

    const delivery = createSpecDeliveryRepo(db);
    expect(delivery.findEvidenceById("evidence-dropped")).toBeNull();
    const surviving = delivery.findEvidenceById("evidence-surviving");
    expect(surviving).not.toBeNull();
    // Retained-historical surfaceId stays readable on surviving rows.
    expect(
      evidenceEvaluatedStateSchema.parse(
        JSON.parse(surviving?.evaluated_state_json ?? "{}"),
      ),
    ).toMatchObject({ surfaceId: "spec-studio/retained" });

    expect(delivery.findProofVerdictById("verdict-citing")).toMatchObject({
      stale_reason: "evidence kind removed from vocabulary by migration 0009",
    });
    expect(
      delivery.findProofVerdictById("verdict-citing")?.stale_at,
    ).not.toBeNull();
    // A strip-only rewrite ([test_run, diff] -> [test_run]) cannot invalidate
    // a previously recorded verdict: afterKinds is a subset of beforeKinds.
    expect(delivery.findProofVerdictById("verdict-clean")).toMatchObject({
      stale_at: null,
      stale_reason: null,
    });
    // Strengthened strategies invalidate the verdicts that satisfied only the
    // weaker legacy form; every read projection (stale_at IS NULL) now agrees
    // with the gate's re-evaluation of the new strategy instead of showing
    // proof the gate refuses.
    for (const verdictId of ["verdict-empty", "verdict-commit-only"]) {
      expect(delivery.findProofVerdictById(verdictId)).toMatchObject({
        stale_reason: "validation strategy strengthened by migration 0009",
      });
      expect(delivery.findProofVerdictById(verdictId)?.stale_at).not.toBeNull();
    }
    expect(
      delivery
        .findProofVerdictsByCriterionRevision("criterion-c", REVISION_ID)
        .filter((verdict) => verdict.stale_at === null),
    ).toEqual([]);
    expect(
      delivery
        .findProofVerdictsByCriterionRevision("criterion-d", REVISION_ID)
        .filter((verdict) => verdict.stale_at === null),
    ).toEqual([]);
    // The commit evidence itself survives — only the verdict's sufficiency
    // claim is withdrawn.
    expect(delivery.findEvidenceById("evidence-commit")).not.toBeNull();
    expect(delivery.findTaskClaimById("claim-citing")).toMatchObject({
      status: "reopened",
    });

    // The durable trace parses through the live events repo.
    const events = createSpecEventsRepo(db).findBySpecId(SPEC_ID);
    const traces = events.filter(
      (event) =>
        JSON.parse(event.payload_json).kind ===
        "evidence-kind-vocabulary-migrated",
    );
    expect(traces).toHaveLength(1);
    expect(JSON.parse(traces[0]?.actor_json ?? "null")).toEqual({
      kind: "system",
    });
    const payload = JSON.parse(traces[0]?.payload_json ?? "null");
    expect(payload).toMatchObject({
      removedEvidenceIds: ["evidence-dropped"],
      // Deleted-citation staling first, then strengthened-strategy staling in
      // strategy-rewrite order (criterion-c before criterion-d).
      staledVerdictIds: [
        "verdict-citing",
        "verdict-empty",
        "verdict-commit-only",
      ],
      reopenedClaimIds: ["claim-citing"],
    });
    expect(payload.strategyChanges).toEqual(
      expect.arrayContaining([
        {
          revisionId: REVISION_ID,
          criterionElementId: "criterion-a",
          beforeKinds: ["test_run", "diff"],
          afterKinds: ["test_run"],
          fallbackApplied: false,
        },
        {
          revisionId: REVISION_ID,
          criterionElementId: "criterion-d",
          beforeKinds: ["commit"],
          afterKinds: ["commit", "validator_verdict"],
          fallbackApplied: true,
        },
      ]),
    );
    expect(payload.strategyChanges).toHaveLength(4);

    expect(
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: 2 });
  });

  it("is idempotent: a second run leaves byte-identical rows and no duplicate trace", async () => {
    const db = freshDb();
    seedLegacyWorld(db);

    await runNarrowing(db);
    const firstState = dumpState(db);
    await runNarrowing(db);

    expect(dumpState(db)).toBe(firstState);
  });

  it("rolls back everything when the transaction fails mid-flight and completes on retry", async () => {
    const db = freshDb();
    seedLegacyWorld(db);
    db.exec(`
      CREATE TEMP TRIGGER fail_trace
      BEFORE INSERT ON spec_events
      WHEN NEW.payload_json LIKE '%evidence-kind-vocabulary-migrated%'
      BEGIN
        SELECT RAISE(ABORT, 'simulated mid-migration failure');
      END;
    `);

    await expect(runNarrowing(db)).rejects.toThrow(
      /simulated mid-migration failure/,
    );
    // Legacy bytes intact, version unstamped: the one transaction rolled back.
    const rawPayload = db
      .prepare(
        `SELECT payload_json FROM spec_element_versions
         WHERE revision_id = ? AND element_id = 'criterion-b'`,
      )
      .get(REVISION_ID) as { payload_json: string };
    expect(rawPayload.payload_json).toContain("screenshot");
    expect(
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: null });
    expect(db.prepare("SELECT COUNT(*) AS c FROM spec_evidence").get()).toEqual(
      { c: 3 },
    );

    db.exec("DROP TRIGGER temp.fail_trace");
    await runNarrowing(db);
    const specs = createSpecsRepo(db, createWriteQueue());
    await expect(specs.verifyRevision(REVISION_ID)).resolves.toMatchObject({
      ok: true,
    });
    expect(
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: 2 });
  });

  it("stamps a fresh database too, so an old build cannot open it later", async () => {
    const db = freshDb();

    const applied = await runMigrations({ db, configDir: null }, [
      narrowEvidenceKinds,
    ]);

    expect(applied).toEqual(["0009-narrow-evidence-kinds"]);
    expect(
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: 2 });
  });

  it("refuses a simulated older build (known version 1) after the narrowing", async () => {
    const db = freshDb();
    seedLegacyWorld(db);
    await runNarrowing(db);

    expect(() => enforceSqliteSchemaCompatibility(db, "test-db", 1)).toThrow(
      SchemaVersionConflictError,
    );
    expect(() =>
      enforceSqliteSchemaCompatibility(db, "test-db", 2),
    ).not.toThrow();
  });

  it("publishes the fail-closed external barrier for version 2", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-0009-barrier-"));
    tempDirs.push(dir);
    const db = _createTestDbAtPath(path.join(dir, "command-center.db"));
    openDbs.push(db);

    await narrowEvidenceKinds.up({
      name: narrowEvidenceKinds.name,
      context: { db, configDir: dir },
    });

    expect(existsSync(schemaCompatibilityBarrierPath(dir, 2))).toBe(true);
  });

  it("fresh-floor SQL contract: the narrowed CHECK refuses dropped kinds and accepts survivors", () => {
    const db = freshDb();
    seedLegacyWorld(db);
    // Restore the narrowed floor table (the legacy fixture recreated the
    // permissive one) so this pins the *fresh* DDL text.
    db.exec("DELETE FROM spec_evidence");
    db.exec("DROP TABLE spec_evidence");
    const narrowed = _createTestDb({ inMemory: true });
    const ddlRow = narrowed
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spec_evidence'",
      )
      .get() as { sql: string };
    narrowed.close();
    db.exec(ddlRow.sql);

    const insert = (id: string, kind: string) =>
      db
        .prepare(
          `INSERT INTO spec_evidence (
             id, spec_id, criterion_element_id, revision_id, kind, ref_json,
             evaluated_state_json, producer_json, execution_id,
             source_event_id, created_at
           ) VALUES (?, ?, 'criterion-a', ?, ?, '{}', '{}', '{}', NULL, NULL, ?)`,
        )
        .run(id, SPEC_ID, REVISION_ID, kind, AT);

    for (const kind of ["diff", "screenshot", "human_signoff"]) {
      expect(() => insert(`evidence-${kind}`, kind)).toThrow(/CHECK/);
    }
    for (const kind of ["commit", "test_run", "validator_verdict"]) {
      expect(() => insert(`evidence-${kind}`, kind)).not.toThrow();
    }
  });

  it("post-migration canonical export verifies and no longer matches pre-narrowing bundle content", async () => {
    // The strict read path refuses pre-narrowing rows, so a current build can
    // never re-render the OLD bundle bytes; this pins the two halves of the
    // `spec verify --against` outcome instead: plain integrity passes, and
    // the current export renders only surviving kinds — so any bundle
    // exported before the migration (which named the dropped kinds) can no
    // longer deep-equal it, which is exactly the CLI's mismatch predicate.
    const db = freshDb();
    seedLegacyWorld(db);
    await runNarrowing(db);

    const exportDeps = {
      specs: createSpecsRepo(db, createWriteQueue()),
      review: createSpecReviewRepo(db),
      delivery: createSpecDeliveryRepo(db),
      async observeLinkedWorkflow() {
        return { kind: "missing" as const };
      },
    };
    const state = await loadSpecExportState(exportDeps, SPEC_ID);

    expect(verifyExportState(state)).toMatchObject({ ok: true });
    const bundle = renderCanonicalBundle(state);
    const strategyLines = bundle.markdownFiles
      .flatMap((file) => file.content.split("\n"))
      .filter((line) => line.startsWith("Validation strategy:"));
    expect(strategyLines).toEqual([
      "Validation strategy: test_run",
      "Validation strategy: validator_verdict",
      "Validation strategy: validator_verdict",
      "Validation strategy: commit, validator_verdict",
    ]);
  });

  it("full chain: a pre-narrowing database survives frozen 0008 then 0009 and verifies", async () => {
    const db = freshDb();
    // A stale content hash forces 0008 to rehash rows whose payloads still
    // carry dropped kinds — the exact case that made freezing 0008 necessary.
    seedLegacyWorld(db, { contentHash: "stale-pre-0008-hash" });

    const applied = await runMigrations({ db, configDir: null }, [
      addSpecAuthoringStage,
      narrowEvidenceKinds,
    ]);

    expect(applied).toEqual([
      "0008-add-spec-authoring-stage",
      "0009-narrow-evidence-kinds",
    ]);
    const specs = createSpecsRepo(db, createWriteQueue());
    await expect(specs.verifyRevision(REVISION_ID)).resolves.toMatchObject({
      ok: true,
    });
    const snapshot = await specs.getRevisionSnapshot(REVISION_ID);
    if (snapshot === null) throw new Error("snapshot missing");
    expect(strategyOf(snapshot, "criterion-a")).toEqual({
      kinds: ["test_run"],
    });
  });
});
