import { isDeepStrictEqual } from "node:util";
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
  createSpecDeliveryRepo,
  type SpecDeliveryRepo,
} from "@/lib/state-store/spec-delivery-repo";
import {
  createSpecReviewRepo,
  type SpecReviewRepo,
} from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  buildPinnedSpecDocument,
  compareCanonicalSpecBundles,
  loadSpecExportState,
  pinnedSpecDocumentPath,
  renderCanonicalBundle,
  verifyExportState,
} from "./export";

const PROJECT_PATH = "/repos/native-sdd-export";
const CREATED_AT = "2026-07-18T16:00:00.000Z";

let db: Db;
let specs: SpecsRepo;
let review: SpecReviewRepo;
let delivery: SpecDeliveryRepo;
let exportDeps: Parameters<typeof loadSpecExportState>[0];
let specId: string;
let revisionId: string;

beforeEach(async () => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  specs = createSpecsRepo(db, createWriteQueue());
  review = createSpecReviewRepo(db);
  delivery = createSpecDeliveryRepo(db);
  exportDeps = {
    specs,
    review,
    delivery,
    async observeLinkedWorkflow() {
      return { kind: "missing" as const };
    },
  };
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
  // This criterion is appended after the task in global revision order. The
  // rendered document still has to place it under R1, which is the read shape a
  // reviewer navigates and the lane document promises.
  await specs.createDraftElement({
    id: "criterion-1",
    specId,
    revisionId,
    kind: "criterion",
    parentElementId: "requirement-1",
    position: 3,
    payload: {
      kind: "criterion",
      text: "The exported revision nests criteria under their requirements.",
      validationStrategy: { kinds: ["test_run"] },
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
    const state = await loadSpecExportState(exportDeps, specId);
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
      formatVersion: 3,
      elementOrdering: {
        scope: "revision",
        sortKeys: ["position", "elementId"],
        nesting: "parentElementId",
        renderedTraversal: "parent-then-children",
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
            { id: "criterion-1", handle: "R1.1", position: 3 },
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
    const markdown = first.markdownFiles.at(0)?.content ?? "";
    expect(markdown.indexOf("## R1 — Requirement")).toBeLessThan(
      markdown.indexOf("### R1.1 — Acceptance criterion"),
    );
    expect(markdown.indexOf("### R1.1 — Acceptance criterion")).toBeLessThan(
      markdown.indexOf("## T1 — Export the complete plan"),
    );
  });

  it("reports an older bundle format as an explicit actionable mismatch", async () => {
    const current = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const olderManifest = {
      ...(JSON.parse(current.manifest) as Record<string, unknown>),
      formatVersion: 2,
    };
    const older = {
      ...current,
      manifest: `${JSON.stringify(olderManifest)}\n`,
    };

    expect(compareCanonicalSpecBundles(current, older)).toEqual({
      ok: false,
      code: "bundle_format_mismatch",
      currentFormatVersion: 3,
      againstFormatVersion: 2,
      message: "canonical bundle format 2 differs from current format 3",
      instruction:
        "Export a fresh canonical bundle, then verify against that file.",
      issue: {
        path: "bundle.manifest.formatVersion",
        message: "expected current format 3, found 2",
      },
    });
  });

  it("carries questions and assumptions in the canonical manifest (portable representation)", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
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
    const state = await loadSpecExportState(exportDeps, specId);
    expect(verifyExportState(state)).toEqual({
      ok: true,
      checkedRevisionIds: [revisionId],
      mismatches: [],
      consistencyFindings: [],
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

    const state = await loadSpecExportState(exportDeps, specId);
    expect(verifyExportState(state)).toMatchObject({
      ok: false,
      checkedRevisionIds: [revisionId],
      mismatches: [{ mismatchedElementIds: ["task-1"] }],
    });
  });

  /**
   * Within canonical format 3, an undeclared optional executionLane carries no
   * trace in the bundle. Declaring the field remains ordinary content drift;
   * cross-format compatibility is covered by the version-mismatch contract.
   */
  it("keeps a pre-executionLane bundle equal and detects a declared execution lane as a real difference", async () => {
    const archived = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    expect(archived.manifest).not.toContain("executionLane");
    expect(archived.markdownFiles[0]?.content).not.toContain("Execution lane");
    expect(
      isDeepStrictEqual(
        renderCanonicalBundle(await loadSpecExportState(exportDeps, specId)),
        archived,
      ),
    ).toBe(true);

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
        laneGroup: "persistence",
        executionLane: "persistence-lane",
        touchedPaths: ["src/lib/specs", "src/lib/state-store"],
      }),
      revisionId,
      "task-1",
    );

    const laned = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    expect(laned.markdownFiles[0]?.content).toContain(
      "- Execution lane: persistence-lane",
    );
    expect(isDeepStrictEqual(laned, archived)).toBe(false);
  });

  it("detects out-of-band mutation of a frozen revision's authoring stage", async () => {
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'design' WHERE id = ?",
    ).run(revisionId);

    const state = await loadSpecExportState(exportDeps, specId);
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

    const state = await loadSpecExportState(exportDeps, specId);
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

/**
 * The pinned-revision document the launch path seeds into every lane worktree.
 * Its contract is that it renders the PINNED snapshot through the one canonical
 * revision renderer — a mid-run amendment moves live spec state, never this.
 */
describe("pinned spec document", () => {
  it("renders the pinned revision at the reserved worktree-relative path", async () => {
    const spec = (await specs.findById(specId))!;
    const pinned = (await specs.getRevisionSnapshot(revisionId))!;

    const document = buildPinnedSpecDocument(spec, pinned);

    expect(document.relativePath).toBe(
      ".cc/graph-workflow-docs/spec/portable-spec.md",
    );
    expect(document.relativePath).toBe(pinnedSpecDocumentPath("portable-spec"));
    expect(document.contents).toContain("The export is deterministic.");
    expect(document.contents).toContain("<!-- element:requirement-1 -->");
    expect(document.contents).toContain("- Revision: 1");
    expect(document.description).toContain("portable-spec");
    expect(document.description).toContain("revision 1");
    expect(document.readWhen.length).toBeGreaterThan(0);

    // Deterministic: the seed writes it once, every lane materializes the same
    // bytes, and `spec verify` compares them.
    expect(buildPinnedSpecDocument(spec, pinned)).toEqual(document);
  });

  it("uses the same renderer as the canonical bundle's revision markdown", async () => {
    const spec = (await specs.findById(specId))!;
    const pinned = (await specs.getRevisionSnapshot(revisionId))!;
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );

    expect(buildPinnedSpecDocument(spec, pinned).contents).toBe(
      bundle.markdownFiles[0]!.content,
    );
  });

  it("stays on the pinned revision when the spec is amended mid-run", async () => {
    const spec = (await specs.findById(specId))!;
    const pinned = (await specs.getRevisionSnapshot(revisionId))!;
    const before = buildPinnedSpecDocument(spec, pinned);

    // Mid-run amendment: a new draft revision changes the requirement text.
    await specs.createDraftFromBase({
      id: "revision-export-2",
      specId,
      baseRevisionId: revisionId,
      authoringStage: "plan",
      createdAt: "2026-07-19T10:00:00.000Z",
    });
    const draftVersion = (await specs.findElementVersion(
      "revision-export-2",
      "requirement-1",
    ))!;
    await specs.updateDraftElement({
      revisionId: "revision-export-2",
      elementId: "requirement-1",
      expectedElementVersion: draftVersion.elementVersion,
      payload: {
        kind: "requirement",
        statement: "The export is amended.",
        priority: "must",
        risk: "high",
      },
      updatedAt: "2026-07-19T10:01:00.000Z",
    });

    const after = buildPinnedSpecDocument(
      (await specs.findById(specId))!,
      (await specs.getRevisionSnapshot(revisionId))!,
    );

    expect(after).toEqual(before);
    expect(after.contents).not.toContain("The export is amended.");
  });
});
