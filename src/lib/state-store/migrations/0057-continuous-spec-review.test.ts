import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approvalRecordFromRow,
  subjectFingerprint,
} from "@/lib/specs/approval-applicability";
import {
  toDiffCitations,
  toDiffRows,
} from "@/lib/specs/revision-diff-projections";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";
import { createSpecReviewRepo } from "../spec-review-repo";
import { createSpecsRepo, type SpecsRepo } from "../specs-repo";
import { _createTestDbAtPath, KNOWN_SCHEMA_VERSION } from "../state-db";
import { createWriteQueue } from "../write-queue";
import type { Db } from "../schemas";
import {
  CONTINUOUS_SPEC_REVIEW_SCHEMA_VERSION,
  continuousSpecReview,
} from "./0057-continuous-spec-review";

const PROJECT = "/repos/continuous-review";
const AT = "2026-09-24T10:00:00.000Z";

let configDir: string;
let db: Db;
let specs: SpecsRepo;

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "cc-continuous-review-"));
  db = _createTestDbAtPath(path.join(configDir, "command-center.db"));
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT);
  specs = createSpecsRepo(db, createWriteQueue());
});

afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
});

function run() {
  return continuousSpecReview.up({
    name: continuousSpecReview.name,
    context: { db, configDir },
  });
}

/** A spec whose revision 1 is approved and carries R1 (with a criterion) and D1. */
async function approvedSpec(slug: string) {
  const specId = `spec-${slug}`;
  const revisionId = `${specId}-r1`;
  await specs.create({
    spec: {
      id: specId,
      projectPath: PROJECT,
      slug,
      name: slug,
      gatePolicy: { preset: "contract-bearing" },
      createdAt: AT,
      updatedAt: AT,
    },
    initialRevision: {
      id: revisionId,
      authoringStage: "design",
      createdAt: AT,
    },
  });
  for (const element of [
    {
      id: `${specId}-requirement`,
      kind: "requirement" as const,
      parentElementId: null,
      payload: {
        kind: "requirement" as const,
        statement: "Approvals name what a human read.",
        priority: "must" as const,
        risk: "high" as const,
      },
    },
    {
      id: `${specId}-criterion`,
      kind: "criterion" as const,
      parentElementId: `${specId}-requirement`,
      payload: {
        kind: "criterion" as const,
        text: "An edited subject is unapproved again.",
        validationStrategy: { kinds: ["test_run" as const] },
      },
    },
    {
      id: `${specId}-decision`,
      kind: "decision" as const,
      parentElementId: null,
      payload: {
        kind: "decision" as const,
        title: "Store the fingerprint",
        chosenApproach: "Record the approved fingerprint on the approval.",
        rejectedAlternatives: [],
        reason: "A draft is edited in place.",
        tracedRequirementElementIds: [`${specId}-requirement`],
      },
    },
  ]) {
    await specs.createDraftElement({
      ...element,
      specId,
      revisionId,
      createdAt: AT,
      updatedAt: AT,
    });
  }
  await specs.approveRevision({ revisionId, approvedAt: AT });
  return { specId, revisionId };
}

/** Rows as a pre-continuous-review build wrote them: no fingerprint column value. */
function insertLegacyApproval(
  id: string,
  specId: string,
  revisionId: string,
  subjectKind: "requirement" | "decision" | "revision",
  elementId: string | null,
): void {
  db.prepare(
    `INSERT INTO spec_approvals (
       id, spec_id, subject_kind, element_id, revision_id, approver,
       granted_at, validity, subject_fingerprint_json
     ) VALUES (?, ?, ?, ?, ?, 'operator', ?, 'valid', NULL)`,
  ).run(id, specId, subjectKind, elementId, revisionId, AT);
}

async function openDraft(
  specId: string,
  baseRevisionId: string,
  number: number,
) {
  const revisionId = `${specId}-r${number}`;
  await specs.createDraftFromBase({
    id: revisionId,
    specId,
    baseRevisionId,
    authoringStage: "design",
    createdAt: AT,
  });
  return revisionId;
}

/** Leaves a revision in the retired `proposed` state, as an older build did. */
function markLegacyProposed(revisionId: string): void {
  db.pragma("ignore_check_constraints = ON");
  db.prepare(
    `UPDATE spec_revisions
     SET state = 'proposed', content_hash = ?, proposed_at = ?
     WHERE id = ?`,
  ).run("a".repeat(64), AT, revisionId);
  db.pragma("ignore_check_constraints = OFF");
}

async function expectedFingerprint(
  revisionId: string,
  subject: { subjectKind: "requirement" | "decision"; elementId: string },
) {
  const snapshot = await specs.getRevisionSnapshot(revisionId);
  if (snapshot === null) throw new Error(`missing snapshot ${revisionId}`);
  return subjectFingerprint(toDiffRows(snapshot), subject, {
    citationContractVersion: snapshot.revision.citationContractVersion,
    citations: toDiffCitations(snapshot),
  });
}

describe("0057 continuous spec review", () => {
  it("records on each content approval the fingerprint of the revision it was granted on", async () => {
    const { specId, revisionId } = await approvedSpec("backfill");
    insertLegacyApproval(
      "approval-requirement",
      specId,
      revisionId,
      "requirement",
      `${specId}-requirement`,
    );
    insertLegacyApproval(
      "approval-decision",
      specId,
      revisionId,
      "decision",
      `${specId}-decision`,
    );
    insertLegacyApproval(
      "approval-sign-off",
      specId,
      revisionId,
      "revision",
      null,
    );

    await run();

    const rows = createSpecReviewRepo(db).findApprovalsBySpecId(specId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const requirement = byId.get("approval-requirement");
    const decision = byId.get("approval-decision");
    if (requirement === undefined || decision === undefined) {
      throw new Error("approvals missing after migration");
    }
    expect(approvalRecordFromRow(requirement)?.fingerprint).toEqual(
      await expectedFingerprint(revisionId, {
        subjectKind: "requirement",
        elementId: `${specId}-requirement`,
      }),
    );
    expect(approvalRecordFromRow(decision)?.fingerprint).toEqual(
      await expectedFingerprint(revisionId, {
        subjectKind: "decision",
        elementId: `${specId}-decision`,
      }),
    );
    expect(byId.get("approval-sign-off")?.subject_fingerprint_json).toBeNull();
  });

  it("reopens a retired proposal as the spec's draft, keeping what its approvals read", async () => {
    const { specId, revisionId: approvedId } = await approvedSpec("reopen");
    const proposedId = await openDraft(specId, approvedId, 2);
    const fingerprintBefore = await expectedFingerprint(proposedId, {
      subjectKind: "requirement",
      elementId: `${specId}-requirement`,
    });
    markLegacyProposed(proposedId);
    insertLegacyApproval(
      "approval-on-proposal",
      specId,
      proposedId,
      "requirement",
      `${specId}-requirement`,
    );

    await run();

    expect(await specs.findRevision(proposedId)).toMatchObject({
      state: "draft",
      contentHash: null,
      proposedAt: null,
    });
    const approval = createSpecReviewRepo(db).findApprovalById(
      "approval-on-proposal",
    );
    if (approval === null) throw new Error("approval missing");
    expect(approvalRecordFromRow(approval)?.fingerprint).toEqual(
      fingerprintBefore,
    );
  });

  it("withdraws a retired proposal when the spec already has an open draft", async () => {
    const { specId, revisionId: approvedId } = await approvedSpec("sibling");
    const proposedId = await openDraft(specId, approvedId, 2);
    markLegacyProposed(proposedId);
    await openDraft(specId, approvedId, 3);

    await run();

    expect((await specs.findRevision(proposedId))?.state).toBe("withdrawn");
    expect((await specs.findRevision(`${specId}-r3`))?.state).toBe("draft");
  });

  it("abandons delivery-plan attempts that were proposed or parked without a sign-off", async () => {
    const { specId, revisionId } = await approvedSpec("plans");
    const insertAttempt = db.prepare(
      `INSERT INTO spec_delivery_plan_attempts (
         id, spec_id, pinned_revision_id, status, draft_revision,
         content_json, approval_json, prelaunch_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, '{}', ?, ?, ?, ?)`,
    );
    const parkedUnsigned = JSON.stringify({
      parkedAt: AT,
      parkedBy: { kind: "human" },
      reason: null,
      candidate: { candidateId: "c", candidateHash: "h" },
      approvedAtPark: false,
    });
    const parkedSigned = JSON.stringify({
      parkedAt: AT,
      parkedBy: { kind: "human" },
      reason: null,
      candidate: { candidateId: "c", candidateHash: "h" },
      approvedAtPark: true,
    });
    db.pragma("ignore_check_constraints = ON");
    insertAttempt.run(
      "attempt-proposed",
      specId,
      revisionId,
      "proposed",
      null,
      null,
      AT,
      AT,
    );
    db.pragma("ignore_check_constraints = OFF");
    insertAttempt.run(
      "attempt-parked-unsigned",
      specId,
      revisionId,
      "parked",
      null,
      parkedUnsigned,
      AT,
      AT,
    );
    insertAttempt.run(
      "attempt-parked-signed",
      specId,
      revisionId,
      "parked",
      "{}",
      parkedSigned,
      AT,
      AT,
    );

    await run();

    const rows = db
      .prepare(
        "SELECT id, status, prelaunch_json FROM spec_delivery_plan_attempts ORDER BY id",
      )
      .all() as { id: string; status: string; prelaunch_json: string | null }[];
    expect(rows.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "attempt-parked-signed", status: "parked" },
      { id: "attempt-parked-unsigned", status: "abandoned" },
      { id: "attempt-proposed", status: "abandoned" },
    ]);
    expect(JSON.parse(rows[0]?.prelaunch_json ?? "null")).not.toHaveProperty(
      "approvedAtPark",
    );
  });

  it("drops the supersession table and fences older builds, idempotently", async () => {
    db.exec(`CREATE TABLE spec_revision_supersessions (
      revision_id TEXT PRIMARY KEY
    )`);

    await run();
    await run();

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'spec_revision_supersessions'",
        )
        .all(),
    ).toEqual([]);
    expect(
      db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .all(CONTINUOUS_SPEC_REVIEW_SCHEMA_VERSION),
    ).toEqual([{ version: CONTINUOUS_SPEC_REVIEW_SCHEMA_VERSION }]);
    expect(() =>
      enforceCurrentSchemaCompatibility(
        db,
        db.name,
        CONTINUOUS_SPEC_REVIEW_SCHEMA_VERSION - 1,
      ),
    ).toThrow(/greater than known build version/);
    expect(KNOWN_SCHEMA_VERSION).toBe(CONTINUOUS_SPEC_REVIEW_SCHEMA_VERSION);
  });
});
