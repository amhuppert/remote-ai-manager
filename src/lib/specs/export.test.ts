import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createSpecReviewRepo,
  type SpecReviewRepo,
} from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  loadSpecExportState,
  renderCanonicalBundle,
  verifyExportState,
} from "./export";

const PROJECT_PATH = "/repos/native-sdd-export";
const CREATED_AT = "2026-07-18T16:00:00.000Z";

let db: Db;
let specs: SpecsRepo;
let review: SpecReviewRepo;
let specId: string;
let revisionId: string;

beforeEach(async () => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  specs = createSpecsRepo(db, createWriteQueue());
  review = createSpecReviewRepo(db);
  specId = "spec-export";
  revisionId = "revision-export-1";
  await specs.create({
    spec: {
      id: specId,
      projectPath: PROJECT_PATH,
      slug: "portable-spec",
      name: "Portable spec",
      gatePolicy: { preset: "contract-bearing" },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    initialRevision: {
      id: revisionId,
      authoringStage: "plan",
      createdAt: CREATED_AT,
    },
  });
  await specs.createDraftElement({
    id: "section-1",
    specId,
    revisionId,
    kind: "section",
    parentElementId: null,
    position: 0,
    payload: {
      kind: "section",
      role: "intent_problem",
      title: "Problem",
      body: "Specs need a portable representation.",
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await specs.createDraftElement({
    id: "task-1",
    specId,
    revisionId,
    kind: "task",
    parentElementId: null,
    position: 2,
    payload: {
      kind: "task",
      title: "Export the complete plan",
      instructions: "Preserve every approved task field.",
      tracedRequirementElementIds: ["requirement-1"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: [],
      dependsOnTaskElementIds: [],
      laneGroup: "persistence",
      touchedPaths: ["src/lib/specs", "src/lib/state-store"],
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await specs.createDraftElement({
    id: "requirement-1",
    specId,
    revisionId,
    kind: "requirement",
    parentElementId: null,
    position: 1,
    payload: {
      kind: "requirement",
      statement: "The export is deterministic.",
      priority: "must",
      risk: "high",
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await specs.proposeRevision({
    revisionId,
    proposedAt: "2026-07-18T16:01:00.000Z",
  });
  await specs.approveRevision({
    revisionId,
    approvedAt: "2026-07-18T16:02:00.000Z",
  });
  review.saveApproval({
    id: "approval-1",
    spec_id: specId,
    subject_kind: "requirement",
    element_id: "requirement-1",
    revision_id: revisionId,
    approver: "alex",
    granted_at: "2026-07-18T16:01:30.000Z",
    validity: "valid",
  });
  review.saveQuestion({
    id: "question-1",
    spec_id: specId,
    number: 1,
    element_id: "requirement-1",
    text: "Which auth modes are in scope?",
    provenance_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-export",
    }),
    status: "answered",
    answer: "OAuth only.",
    answered_at: "2026-07-18T16:03:00.000Z",
    created_at: "2026-07-18T16:02:30.000Z",
    updated_at: "2026-07-18T16:03:00.000Z",
  });
  review.saveAssumption({
    id: "assumption-1",
    spec_id: specId,
    number: 1,
    element_id: null,
    text: "Sessions stay single-region.",
    proposed_by_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-export",
    }),
    disposition: "confirmed",
    disposed_at: "2026-07-18T16:04:00.000Z",
    created_at: "2026-07-18T16:03:30.000Z",
    updated_at: "2026-07-18T16:04:00.000Z",
  });
});

afterEach(() => db.close());

describe("canonical spec export and verification", () => {
  it("renders the same canonical bundle for identical durable state", async () => {
    const state = await loadSpecExportState({ specs, review }, specId);
    const first = renderCanonicalBundle(state);
    const second = renderCanonicalBundle(state);

    expect(first).toEqual(second);
    expect(first.markdownFiles).toEqual([
      expect.objectContaining({
        path: "revisions/0001-approved.md",
        content: expect.stringContaining("The export is deterministic."),
      }),
    ]);
    expect(JSON.parse(first.manifest)).toMatchObject({
      formatVersion: 2,
      elementOrdering: {
        scope: "revision",
        sortKeys: ["position", "elementId"],
        nesting: "parentElementId",
        omittedPositionOnCreate: "append",
      },
      spec: { id: specId, slug: "portable-spec" },
      revisions: [
        {
          id: revisionId,
          authoringStage: "plan",
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          elements: [
            { id: "section-1", position: 0 },
            { id: "requirement-1", handle: "R1", position: 1 },
            {
              id: "task-1",
              handle: "T1",
              position: 2,
              payload: {
                laneGroup: "persistence",
                touchedPaths: ["src/lib/specs", "src/lib/state-store"],
              },
            },
          ],
        },
      ],
      approvals: [{ id: "approval-1" }],
    });
    expect(first.markdownFiles[0]?.content).toContain(
      "- Lane group: persistence",
    );
    expect(first.markdownFiles[0]?.content).toContain(
      "- Authoring stage: plan",
    );
    expect(first.markdownFiles[0]?.content).toContain(
      "- Touched paths: src/lib/specs, src/lib/state-store",
    );
  });

  it("carries questions and assumptions in the canonical manifest (portable representation)", async () => {
    const state = await loadSpecExportState({ specs, review }, specId);
    const manifest = JSON.parse(renderCanonicalBundle(state).manifest) as {
      questions?: Array<{ id: string; number: number; answer: string | null }>;
      assumptions?: Array<{ id: string; disposition: string }>;
    };

    expect(manifest.questions).toEqual([
      expect.objectContaining({
        id: "question-1",
        number: 1,
        status: "answered",
        answer: "OAuth only.",
      }),
    ]);
    expect(manifest.assumptions).toEqual([
      expect.objectContaining({
        id: "assumption-1",
        number: 1,
        disposition: "confirmed",
      }),
    ]);
  });

  it("passes verification for intact frozen state", async () => {
    const state = await loadSpecExportState({ specs, review }, specId);
    expect(verifyExportState(state)).toEqual({
      ok: true,
      checkedRevisionIds: [revisionId],
      mismatches: [],
    });
  });

  it("detects out-of-band mutation of lane grouping and touched surfaces", async () => {
    db.prepare(
      `UPDATE spec_element_versions
       SET payload_json = ?
       WHERE revision_id = ? AND element_id = ?`,
    ).run(
      JSON.stringify({
        kind: "task",
        title: "Export the complete plan",
        instructions: "Preserve every approved task field.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
        laneGroup: "tampered-lane",
        touchedPaths: ["src/lib/other"],
      }),
      revisionId,
      "task-1",
    );

    const state = await loadSpecExportState({ specs, review }, specId);
    expect(verifyExportState(state)).toMatchObject({
      ok: false,
      checkedRevisionIds: [revisionId],
      mismatches: [{ mismatchedElementIds: ["task-1"] }],
    });
  });

  it("detects out-of-band mutation of a frozen revision's authoring stage", async () => {
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'design' WHERE id = ?",
    ).run(revisionId);

    const state = await loadSpecExportState({ specs, review }, specId);
    expect(verifyExportState(state)).toMatchObject({
      ok: false,
      checkedRevisionIds: [revisionId],
      mismatches: [{ revisionId, mismatchedElementIds: [] }],
    });
  });

  it("reports the precise revision and element mismatch after out-of-band approved-content mutation", async () => {
    db.prepare(
      `UPDATE spec_element_versions
       SET payload_json = ?
       WHERE revision_id = ? AND element_id = ?`,
    ).run(
      JSON.stringify({
        kind: "section",
        role: "intent_problem",
        title: "Tampered",
        body: "Out-of-band mutation.",
      }),
      revisionId,
      "section-1",
    );

    const state = await loadSpecExportState({ specs, review }, specId);
    const report = verifyExportState(state);
    expect(report.ok).toBe(false);
    expect(report.checkedRevisionIds).toEqual([revisionId]);
    expect(report.mismatches).toEqual([
      {
        revisionId,
        expectedContentHash: state.revisions[0]!.snapshot.revision.contentHash,
        actualContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        mismatchedElementIds: ["section-1"],
      },
    ]);
  });
});
