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
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  computeSpecElementPayloadHash,
  computeSpecRevisionCitationHash,
  computeSpecRevisionContentHash,
  createSpecsRepo,
  type SpecsRepo,
} from "@/lib/state-store/specs-repo";
import { stableStringify } from "@/lib/state-store/serialization";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  buildPinnedSpecDocument,
  compareCanonicalSpecBundles,
  decodeCanonicalSpecBundle,
  loadSpecExportState,
  pinnedSpecDocumentPath,
  renderCanonicalBundle,
  renderVerifiedCanonicalBundle,
  verifyExportState,
} from "./export";
import {
  assumptionCitationSnapshot,
  questionAuditSnapshot,
} from "./attention-records";

const PROJECT_PATH = "/repos/native-sdd-export";
const CREATED_AT = "2026-07-18T16:00:00.000Z";
const CITATION_CAPTURED_AT = "2026-07-18T16:05:00.000Z";

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
  const events = createSpecEventsRepo(db);
  exportDeps = {
    specs,
    review,
    delivery,
    events,
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
  review.insertQuestion({
    id: "question-1",
    spec_id: specId,
    number: 1,
    element_id: "requirement-1",
    text: "Which auth modes are in scope?",
    provenance_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-export",
    }),
    record_version: 2,
    status: "answered",
    answer: "OAuth only.",
    answered_at: "2026-07-18T16:03:00.000Z",
    withdrawn_at: null,
    created_at: "2026-07-18T16:02:30.000Z",
    updated_at: "2026-07-18T16:03:00.000Z",
  });
  review.insertAssumption({
    id: "assumption-1",
    spec_id: specId,
    number: 1,
    element_id: null,
    text: "Sessions stay single-region.",
    proposed_by_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-export",
    }),
    record_version: 2,
    disposition: "confirmed",
    disposed_at: "2026-07-18T16:04:00.000Z",
    withdrawn_at: null,
    supersedes_assumption_id: null,
    supersession_operation_id: null,
    supersession_request_hash: null,
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
      formatVersion: 4,
      elementOrdering: {
        scope: "revision",
        sortKeys: ["position", "elementId"],
        elementIdCollation: "utf8-byte",
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
          citationContractVersion: 2,
          citationVersion: 1,
          citationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          assumptionCitations: [],
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
      attentionAuditEvents: [],
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
      currentFormatVersion: 4,
      againstFormatVersion: 2,
      message: "canonical bundle format 2 differs from current format 4",
      instruction:
        "Export a fresh canonical bundle, then verify against that file.",
      issue: {
        path: "bundle.manifest.formatVersion",
        message: "expected current format 4, found 2",
      },
    });
  });

  it("strictly decodes and re-renders an intact format-4 bundle", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );

    expect(decodeCanonicalSpecBundle(bundle)).toEqual({
      ok: true,
      value: bundle,
    });
  });

  it("uses one code-unit order for rendering and decoding citation identities", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const snapshot = state.revisions[0]!.snapshot;
    const codeUnitFirst = "\u{10000}";
    const codeUnitSecond = "\uE000";
    const elements = snapshot.elements.map((row) => {
      const id =
        row.element.id === "section-1"
          ? codeUnitFirst
          : row.element.id === "task-1"
            ? codeUnitSecond
            : row.element.id;
      return {
        element: { ...row.element, id },
        version: { ...row.version, elementId: id },
      };
    });
    const citationSnapshot = assumptionCitationSnapshot(
      state.assumptions[0]!,
      CITATION_CAPTURED_AT,
    );
    const citations = [codeUnitFirst, codeUnitSecond].map((elementId) => ({
      revisionId,
      specId,
      elementId,
      assumptionId: citationSnapshot.assumptionId,
      snapshot: citationSnapshot,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }));
    const mixedCaseSnapshot = {
      ...snapshot,
      revision: {
        ...snapshot.revision,
        contentHash: computeSpecRevisionContentHash(
          snapshot.revision.authoringStage,
          elements,
        ),
        citationHash: computeSpecRevisionCitationHash(2, citations),
      },
      elements,
      assumptionCitations: citations,
    };
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [{ snapshot: mixedCaseSnapshot }],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toEqual({
      ok: true,
      value: bundle,
    });
  });

  it("uses UTF-8 byte order for same-position element identities", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const snapshot = state.revisions[0]!.snapshot;
    const source = snapshot.elements.find(
      ({ element }) => element.id === "section-1",
    )!;
    const tied = ["\uE000", "\u{10000}"].map((id) => ({
      element: { ...source.element, id },
      version: {
        ...source.version,
        elementId: id,
        position: 4,
      },
    }));
    const elements = [...snapshot.elements, ...tied];
    const canonicalSnapshot = {
      ...snapshot,
      revision: {
        ...snapshot.revision,
        contentHash: computeSpecRevisionContentHash(
          snapshot.revision.authoringStage,
          elements,
        ),
      },
      elements,
    };
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [{ snapshot: canonicalSnapshot }],
    });
    expect(JSON.parse(bundle.manifest)).toMatchObject({
      elementOrdering: { elementIdCollation: "utf8-byte" },
    });

    expect(decodeCanonicalSpecBundle(bundle)).toEqual({
      ok: true,
      value: bundle,
    });
  });

  it("uses code-unit order for approval and gate-admission identities", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const expectedOrder = ["\u{10000}", "\uE000"];
    const approvals = expectedOrder.map((id) => ({
      ...state.approvals[0]!,
      id,
    }));
    const gateAdmissions = expectedOrder.map((id) => ({
      id,
      spec_id: specId,
      gate: "requirements" as const,
      basis: "import" as const,
      approval_id: null,
      revision_id: revisionId,
      execution_id: null,
      actor_json: stableStringify({
        kind: "agent",
        conversationId: "conversation-export",
      }),
      created_at: CREATED_AT,
    }));
    const bundle = renderCanonicalBundle({
      ...state,
      approvals,
      gateAdmissions,
    });
    const manifest = JSON.parse(bundle.manifest) as {
      approvals: Array<{ id: string }>;
      gateAdmissions: Array<{ id: string }>;
    };

    expect(manifest.approvals.map(({ id }) => id)).toEqual(expectedOrder);
    expect(manifest.gateAdmissions.map(({ id }) => id)).toEqual(expectedOrder);
    expect(decodeCanonicalSpecBundle(bundle)).toEqual({
      ok: true,
      value: bundle,
    });
  });

  it.each([
    {
      field: "number" as const,
      replacement: 99,
    },
    {
      field: "proposedBy" as const,
      replacement: { kind: "human" as const },
    },
    {
      field: "supersedesAssumptionId" as const,
      replacement: "unrelated-predecessor",
    },
    {
      field: "createdAt" as const,
      replacement: "2026-07-17T16:00:00.000Z",
    },
  ])(
    "binds citation snapshot immutable identity field $field to its assumption",
    async ({ field, replacement }) => {
      const state = await loadSpecExportState(exportDeps, specId);
      const snapshot = state.revisions[0]!.snapshot;
      const citedSnapshot = {
        ...assumptionCitationSnapshot(
          state.assumptions[0]!,
          CITATION_CAPTURED_AT,
        ),
        [field]: replacement,
      };
      const citations = [
        {
          revisionId,
          specId,
          elementId: "requirement-1",
          assumptionId: citedSnapshot.assumptionId,
          snapshot: citedSnapshot,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ];
      const bundle = renderCanonicalBundle({
        ...state,
        revisions: [
          {
            snapshot: {
              ...snapshot,
              revision: {
                ...snapshot.revision,
                citationHash: computeSpecRevisionCitationHash(2, citations),
              },
              assumptionCitations: citations,
            },
          },
        ],
      });

      expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: `bundle.manifest.revisions[0].assumptionCitations[0].snapshot.${field}`,
        },
      });
    },
  );

  it("names the first precise non-body path when valid bundles differ", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const current = renderCanonicalBundle(state);
    const against = renderCanonicalBundle({
      ...state,
      spec: { ...state.spec, name: "Different private spec name" },
    });

    const comparison = compareCanonicalSpecBundles(current, against);

    expect(comparison).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.spec.name",
        message: "differs from the current canonical export",
      },
    });
    expect(JSON.stringify(comparison)).not.toContain(
      "Different private spec name",
    );
  });

  it("refuses an older canonical format before parsing its obsolete shape", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const olderManifest = {
      formatVersion: 3,
      obsoleteAttentionRecords: "not a format-4 manifest",
    };

    expect(
      decodeCanonicalSpecBundle({
        manifest: `${JSON.stringify(olderManifest)}\n`,
        obsoleteMarkdownDocuments: bundle.markdownFiles,
      }),
    ).toEqual({
      ok: false,
      code: "bundle_format_mismatch",
      currentFormatVersion: 4,
      againstFormatVersion: 3,
      message: "canonical bundle format 3 differs from current format 4",
      instruction:
        "Export a fresh canonical bundle, then verify against that file.",
      issue: {
        path: "bundle.manifest.formatVersion",
        message: "expected current format 4, found 3",
      },
    });
  });

  it("reports a missing format marker as a format mismatch", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const manifest = JSON.parse(bundle.manifest) as Record<string, unknown>;
    delete manifest.formatVersion;

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toEqual({
      ok: false,
      code: "bundle_format_mismatch",
      currentFormatVersion: 4,
      againstFormatVersion: null,
      message:
        "canonical bundle format is missing or invalid; current format is 4",
      instruction:
        "Export a fresh canonical bundle, then verify against that file.",
      issue: {
        path: "bundle.manifest.formatVersion",
        message: "expected current format 4, found missing or invalid format",
      },
    });
  });

  it.each(["4", 4.5])(
    "reports invalid format marker %j as a format mismatch",
    async (formatVersion) => {
      const bundle = renderCanonicalBundle(
        await loadSpecExportState(exportDeps, specId),
      );
      const manifest = JSON.parse(bundle.manifest) as Record<string, unknown>;
      manifest.formatVersion = formatVersion;

      expect(
        decodeCanonicalSpecBundle({
          ...bundle,
          manifest: `${stableStringify(manifest)}\n`,
        }),
      ).toMatchObject({
        ok: false,
        code: "bundle_format_mismatch",
        currentFormatVersion: 4,
        againstFormatVersion: null,
        issue: { path: "bundle.manifest.formatVersion" },
      });
    },
  );

  it("reports unknown outer and manifest fields at the exact field path", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const manifest = JSON.parse(bundle.manifest) as Record<string, unknown>;
    manifest.unexpectedManifestField = true;

    expect(
      decodeCanonicalSpecBundle({ ...bundle, unexpectedBundleField: true }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: { path: "bundle.unexpectedBundleField" },
    });
    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: { path: "bundle.manifest.unexpectedManifestField" },
    });
  });

  it("exports a frozen withdrawn authoring draft without pretending it was proposed", async () => {
    const exportState = await loadSpecExportState(exportDeps, specId);
    const snapshot = exportState.revisions[0]!.snapshot;
    const bundle = renderCanonicalBundle({
      ...exportState,
      revisions: [
        {
          snapshot: {
            ...snapshot,
            revision: {
              ...snapshot.revision,
              state: "withdrawn",
              proposedAt: null,
              approvedAt: null,
            },
          },
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toEqual({
      ok: true,
      value: bundle,
    });
  });

  it.each([
    {
      state: "draft" as const,
      contentHash: "valid" as const,
      proposedAt: null,
      approvedAt: null,
      expectedPath: "contentHash",
    },
    {
      state: "proposed" as const,
      contentHash: null,
      proposedAt: CREATED_AT,
      approvedAt: null,
      expectedPath: "contentHash",
    },
    {
      state: "approved" as const,
      contentHash: "valid" as const,
      proposedAt: CREATED_AT,
      approvedAt: null,
      expectedPath: "approvedAt",
    },
    {
      state: "withdrawn" as const,
      contentHash: null,
      proposedAt: CREATED_AT,
      approvedAt: null,
      expectedPath: "contentHash",
    },
  ])(
    "rejects an impossible $state revision lifecycle",
    async ({ state, contentHash, proposedAt, approvedAt, expectedPath }) => {
      const exportState = await loadSpecExportState(exportDeps, specId);
      const snapshot = exportState.revisions[0]!.snapshot;
      const bundle = renderCanonicalBundle({
        ...exportState,
        revisions: [
          {
            snapshot: {
              ...snapshot,
              revision: {
                ...snapshot.revision,
                state,
                contentHash:
                  contentHash === "valid"
                    ? snapshot.revision.contentHash
                    : contentHash,
                proposedAt,
                approvedAt,
              },
            },
          },
        ],
      });

      expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: `bundle.manifest.revisions[0].${expectedPath}`,
        },
      });
    },
  );

  it("rejects a canonical bundle with no revision history", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [],
      approvals: [],
      gateAdmissions: [],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions",
      },
    });
  });

  it("allows citation contract 1 only on frozen legacy revisions", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const snapshot = state.revisions[0]!.snapshot;
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [
        {
          snapshot: {
            ...snapshot,
            revision: {
              ...snapshot.revision,
              state: "draft",
              contentHash: null,
              citationContractVersion: 1,
              citationHash: computeSpecRevisionCitationHash(
                1,
                snapshot.assumptionCitations,
              ),
              proposedAt: null,
              approvedAt: null,
            },
          },
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[0].citationContractVersion",
      },
    });
  });

  it.each(["proposed", "approved", "withdrawn"] as const)(
    "preserves a frozen legacy %s revision under citation contract 1",
    async (stateName) => {
      const state = await loadSpecExportState(exportDeps, specId);
      const snapshot = state.revisions[0]!.snapshot;
      const bundle = renderCanonicalBundle({
        ...state,
        approvals: stateName === "approved" ? state.approvals : [],
        revisions: [
          {
            snapshot: {
              ...snapshot,
              revision: {
                ...snapshot.revision,
                state: stateName,
                citationContractVersion: 1,
                citationHash: computeSpecRevisionCitationHash(
                  1,
                  snapshot.assumptionCitations,
                ),
                approvedAt:
                  stateName === "approved"
                    ? snapshot.revision.approvedAt
                    : null,
              },
            },
          },
        ],
      });

      expect(decodeCanonicalSpecBundle(bundle)).toEqual({
        ok: true,
        value: bundle,
      });
    },
  );

  it("preserves non-empty legacy-backfill citations on a frozen contract-1 revision", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const revision = state.revisions[0]!.snapshot;
    const cutoverAt = "2026-07-20T16:00:00.000Z";
    const assumption = {
      ...state.assumptions[0]!,
      created_at: "2026-07-18T15:59:00.000Z",
      updated_at: "2026-07-18T16:04:00.000Z",
    };
    const snapshot = {
      ...assumptionCitationSnapshot(assumption, cutoverAt),
      captureKind: "legacy_backfill" as const,
    };
    const citations = [
      {
        revisionId,
        specId,
        elementId: "requirement-1",
        assumptionId: snapshot.assumptionId,
        snapshot,
        createdAt: cutoverAt,
        updatedAt: cutoverAt,
      },
    ];
    const bundle = renderCanonicalBundle({
      ...state,
      assumptions: [assumption],
      revisions: [
        {
          snapshot: {
            ...revision,
            revision: {
              ...revision.revision,
              citationContractVersion: 1,
              citationHash: computeSpecRevisionCitationHash(1, citations),
            },
            assumptionCitations: citations,
          },
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toEqual({
      ok: true,
      value: bundle,
    });

    const nativeCitations = citations.map((citation) => ({
      ...citation,
      snapshot: { ...citation.snapshot, captureKind: "native" as const },
    }));
    const nativeBundle = renderCanonicalBundle({
      ...state,
      assumptions: [assumption],
      revisions: [
        {
          snapshot: {
            ...revision,
            revision: {
              ...revision.revision,
              citationContractVersion: 1,
              citationHash: computeSpecRevisionCitationHash(1, nativeCitations),
            },
            assumptionCitations: nativeCitations,
          },
        },
      ],
    });
    expect(decodeCanonicalSpecBundle(nativeBundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[0].assumptionCitations[0].snapshot.captureKind",
      },
    });

    const advancedVersionBundle = renderCanonicalBundle({
      ...state,
      assumptions: [assumption],
      revisions: [
        {
          snapshot: {
            ...revision,
            revision: {
              ...revision.revision,
              citationContractVersion: 1,
              citationVersion: 2,
              citationHash: computeSpecRevisionCitationHash(1, citations),
            },
            assumptionCitations: citations,
          },
        },
      ],
    });
    expect(decodeCanonicalSpecBundle(advancedVersionBundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[0].citationVersion",
      },
    });

    const lateSnapshot = {
      ...assumptionCitationSnapshot(state.assumptions[0]!, cutoverAt),
      captureKind: "legacy_backfill" as const,
    };
    const lateCitations = citations.map((citation) => ({
      ...citation,
      assumptionId: lateSnapshot.assumptionId,
      snapshot: lateSnapshot,
    }));
    const lateBundle = renderCanonicalBundle({
      ...state,
      revisions: [
        {
          snapshot: {
            ...revision,
            revision: {
              ...revision.revision,
              citationContractVersion: 1,
              citationHash: computeSpecRevisionCitationHash(1, lateCitations),
            },
            assumptionCitations: lateCitations,
          },
        },
      ],
    });
    expect(decodeCanonicalSpecBundle(lateBundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[0].assumptionCitations[0].snapshot.createdAt",
      },
    });

    const prematureCitations = citations.map((citation) => ({
      ...citation,
      snapshot: {
        ...citation.snapshot,
        capturedAt: "2026-07-18T15:58:00.000Z",
      },
    }));
    const prematureBundle = renderCanonicalBundle({
      ...state,
      assumptions: [assumption],
      revisions: [
        {
          snapshot: {
            ...revision,
            revision: {
              ...revision.revision,
              citationContractVersion: 1,
              citationHash: computeSpecRevisionCitationHash(
                1,
                prematureCitations,
              ),
            },
            assumptionCitations: prematureCitations,
          },
        },
      ],
    });
    expect(decodeCanonicalSpecBundle(prematureBundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[0].assumptionCitations[0].snapshot.capturedAt",
      },
    });
  });

  it("returns a precise structural issue without echoing authored content", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const authoredSecret = "private requirement body must stay private";
    const manifest = JSON.parse(bundle.manifest) as Record<string, unknown>;
    const revisions = manifest.revisions as Array<{
      elements: Array<{ payload: Record<string, unknown> }>;
    }>;
    revisions[0]!.elements[1]!.payload.statement = authoredSecret;
    delete revisions[0]!.elements[1]!.payload.risk;

    const decoded = decodeCanonicalSpecBundle({
      ...bundle,
      manifest: `${stableStringify(manifest)}\n`,
    });

    expect(decoded).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[0].elements[1].payload.risk",
      },
    });
    expect(JSON.stringify(decoded)).not.toContain(authoredSecret);
  });

  it("reports the exact tampered payload hash", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const manifest = JSON.parse(bundle.manifest) as {
      revisions: Array<{ elements: Array<{ payloadHash: string }> }>;
    };
    manifest.revisions[0]!.elements[1]!.payloadHash = "0".repeat(64);

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[0].elements[1].payloadHash",
        message: "does not match the element payload",
      },
    });
  });

  it("reports the exact tampered citation hash", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const manifest = JSON.parse(bundle.manifest) as {
      revisions: Array<{ citationHash: string }>;
    };
    manifest.revisions[0]!.citationHash = "0".repeat(64);

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[0].citationHash",
        message: "does not match the revision citations",
      },
    });
  });

  it("rejects non-canonical manifest collection ordering", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const manifest = JSON.parse(bundle.manifest) as {
      approvals: Array<Record<string, unknown>>;
    };
    manifest.approvals.push({
      ...manifest.approvals[0]!,
      id: "approval-0",
    });

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.approvals[1].id",
        message: "approvals must be ordered by id",
      },
    });
  });

  it("rejects revision and approval references missing from the bundle", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const missingBaseManifest = JSON.parse(bundle.manifest) as {
      revisions: Array<{ basedOnRevisionId: string | null }>;
    };
    missingBaseManifest.revisions[0]!.basedOnRevisionId = "missing-revision";
    const missingApprovalElementManifest = JSON.parse(bundle.manifest) as {
      approvals: Array<{ element_id: string | null }>;
    };
    missingApprovalElementManifest.approvals[0]!.element_id = "missing-element";

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(missingBaseManifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      issue: {
        path: "bundle.manifest.revisions[0].basedOnRevisionId",
      },
    });
    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(missingApprovalElementManifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      issue: { path: "bundle.manifest.approvals[0].element_id" },
    });
  });

  it.each(["self", "future"] as const)(
    "rejects a revision based on a %s revision",
    async (baseKind) => {
      const state = await loadSpecExportState(exportDeps, specId);
      const first = state.revisions[0]!.snapshot;
      const secondRevisionId = "revision-export-2";
      const thirdRevisionId = "revision-export-3";
      const bundle = renderCanonicalBundle({
        ...state,
        revisions: [
          { snapshot: first },
          {
            snapshot: {
              ...first,
              revision: {
                ...first.revision,
                id: secondRevisionId,
                number: 2,
                state: "withdrawn",
                basedOnRevisionId: revisionId,
                approvedAt: null,
                createdAt: "2026-07-19T16:00:00.000Z",
              },
            },
          },
          {
            snapshot: {
              ...first,
              revision: {
                ...first.revision,
                id: thirdRevisionId,
                number: 3,
                state: "draft",
                basedOnRevisionId: secondRevisionId,
                contentHash: null,
                citationContractVersion: 2,
                citationHash: computeSpecRevisionCitationHash(
                  2,
                  first.assumptionCitations,
                ),
                proposedAt: null,
                approvedAt: null,
                createdAt: "2026-07-20T16:00:00.000Z",
              },
            },
          },
        ],
      });
      const manifest = JSON.parse(bundle.manifest) as {
        revisions: Array<{
          id: string;
          number: number;
          basedOnRevisionId: string | null;
        }>;
      };
      manifest.revisions[1]!.basedOnRevisionId =
        baseKind === "self" ? secondRevisionId : thirdRevisionId;

      expect(
        decodeCanonicalSpecBundle({
          ...bundle,
          manifest: `${stableStringify(manifest)}\n`,
        }),
      ).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: "bundle.manifest.revisions[1].basedOnRevisionId",
          message: "base revision must precede the derived revision",
        },
      });
    },
  );

  it("requires every revision after the first to name an earlier base", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const first = state.revisions[0]!.snapshot;
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [
        { snapshot: first },
        {
          snapshot: {
            ...first,
            revision: {
              ...first.revision,
              id: "revision-export-2",
              number: 2,
              state: "draft",
              basedOnRevisionId: null,
              contentHash: null,
              citationContractVersion: 2,
              citationHash: computeSpecRevisionCitationHash(
                2,
                first.assumptionCitations,
              ),
              proposedAt: null,
              approvedAt: null,
              createdAt: "2026-07-19T16:00:00.000Z",
            },
          },
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[1].basedOnRevisionId",
      },
    });
  });

  it("enforces canonical number and parent shape for every element kind", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const snapshot = state.revisions[0]!.snapshot;
    const cases = [
      {
        id: "section-1",
        field: "number" as const,
        value: 1,
      },
      {
        id: "criterion-1",
        field: "number" as const,
        value: null,
      },
      {
        id: "criterion-1",
        field: "parentElementId" as const,
        value: "task-1",
      },
      {
        id: "requirement-1",
        field: "parentElementId" as const,
        value: "task-1",
      },
    ];

    for (const testCase of cases) {
      const elements = snapshot.elements.map((row) =>
        row.element.id === testCase.id
          ? {
              ...row,
              element: {
                ...row.element,
                number:
                  testCase.field === "number"
                    ? (testCase.value as number | null)
                    : row.element.number,
                parentElementId:
                  testCase.field === "parentElementId"
                    ? (testCase.value as string | null)
                    : row.element.parentElementId,
              },
            }
          : row,
      );
      const elementIndex = elements.findIndex(
        ({ element }) => element.id === testCase.id,
      );
      const bundle = renderCanonicalBundle({
        ...state,
        revisions: [
          {
            snapshot: {
              ...snapshot,
              revision: {
                ...snapshot.revision,
                contentHash: computeSpecRevisionContentHash(
                  snapshot.revision.authoringStage,
                  elements,
                ),
              },
              elements,
            },
          },
        ],
      });

      expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: `bundle.manifest.revisions[0].elements[${elementIndex}].${testCase.field}`,
        },
      });
    }
  });

  it("binds approval subject kinds to their canonical subject shape", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const cases = ["revision", "decision"] as const;

    for (const subjectKind of cases) {
      const manifest = JSON.parse(bundle.manifest) as {
        approvals: Array<{
          subject_kind: "requirement" | "decision" | "revision" | "plan";
          element_id: string | null;
        }>;
      };
      manifest.approvals[0]!.subject_kind = subjectKind;

      expect(
        decodeCanonicalSpecBundle({
          ...bundle,
          manifest: `${stableStringify(manifest)}\n`,
        }),
      ).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: "bundle.manifest.approvals[0].element_id",
        },
      });
    }
  });

  it("binds approvals to a frozen revision lifecycle and the matching authoring stage", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const snapshot = state.revisions[0]!.snapshot;
    const cases = [
      {
        revision: {
          ...snapshot.revision,
          state: "draft" as const,
          contentHash: null,
          proposedAt: null,
          approvedAt: null,
        },
        approval: state.approvals[0]!,
        expectedPath: "revision_id",
      },
      {
        revision: {
          ...snapshot.revision,
          authoringStage: "design" as const,
          contentHash: computeSpecRevisionContentHash(
            "design",
            snapshot.elements,
          ),
        },
        approval: {
          ...state.approvals[0]!,
          subject_kind: "plan" as const,
          element_id: null,
        },
        expectedPath: "subject_kind",
      },
      {
        revision: {
          ...snapshot.revision,
          state: "proposed" as const,
          approvedAt: null,
        },
        approval: {
          ...state.approvals[0]!,
          subject_kind: "revision" as const,
          element_id: null,
        },
        expectedPath: "revision_id",
      },
    ];

    for (const testCase of cases) {
      const bundle = renderCanonicalBundle({
        ...state,
        revisions: [
          {
            snapshot: {
              ...snapshot,
              revision: testCase.revision,
            },
          },
        ],
        approvals: [testCase.approval],
      });
      expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: `bundle.manifest.approvals[0].${testCase.expectedPath}`,
        },
      });
    }
  });

  it.each([
    {
      basis: "human_approval" as const,
      approvalId: null,
      expectedPath: "approval_id",
    },
    {
      basis: "import" as const,
      approvalId: "approval-1",
      expectedPath: "approval_id",
    },
  ])(
    "binds $basis gate admissions to their approval basis",
    async ({ basis, approvalId, expectedPath }) => {
      const state = await loadSpecExportState(exportDeps, specId);
      const bundle = renderCanonicalBundle({
        ...state,
        gateAdmissions: [
          {
            id: "gate-admission-1",
            spec_id: specId,
            gate: "requirements",
            basis,
            approval_id: approvalId,
            revision_id: revisionId,
            execution_id: null,
            actor_json: stableStringify({ kind: "human" }),
            created_at: CREATED_AT,
          },
        ],
      });

      expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: `bundle.manifest.gateAdmissions[0].${expectedPath}`,
        },
      });
    },
  );

  it("requires a human gate admission to reference a valid revision approval", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const admission = {
      id: "gate-admission-1",
      spec_id: specId,
      gate: "requirements" as const,
      basis: "human_approval" as const,
      approval_id: "approval-1",
      revision_id: revisionId,
      execution_id: null,
      actor_json: stableStringify({ kind: "human" }),
      created_at: CREATED_AT,
    };
    const invalidBundle = renderCanonicalBundle({
      ...state,
      gateAdmissions: [admission],
    });

    expect(decodeCanonicalSpecBundle(invalidBundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.gateAdmissions[0].approval_id",
      },
    });

    const validBundle = renderCanonicalBundle({
      ...state,
      approvals: [
        {
          ...state.approvals[0]!,
          subject_kind: "revision",
          element_id: null,
        },
      ],
      gateAdmissions: [admission],
    });
    expect(decodeCanonicalSpecBundle(validBundle)).toEqual({
      ok: true,
      value: validBundle,
    });
  });

  it("requires a human gate admission and its approval to name the same revision", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const first = state.revisions[0]!.snapshot;
    const secondRevisionId = "revision-export-2";
    const bundle = renderCanonicalBundle({
      ...state,
      approvals: [
        {
          ...state.approvals[0]!,
          subject_kind: "revision",
          element_id: null,
        },
      ],
      revisions: [
        { snapshot: first },
        {
          snapshot: {
            ...first,
            revision: {
              ...first.revision,
              id: secondRevisionId,
              number: 2,
              state: "draft",
              basedOnRevisionId: revisionId,
              contentHash: null,
              citationContractVersion: 2,
              citationHash: computeSpecRevisionCitationHash(
                2,
                first.assumptionCitations,
              ),
              proposedAt: null,
              approvedAt: null,
              createdAt: "2026-07-19T16:00:00.000Z",
            },
          },
        },
      ],
      gateAdmissions: [
        {
          id: "gate-admission-1",
          spec_id: specId,
          gate: "requirements",
          basis: "human_approval",
          approval_id: "approval-1",
          revision_id: secondRevisionId,
          execution_id: null,
          actor_json: stableStringify({ kind: "human" }),
          created_at: CREATED_AT,
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.gateAdmissions[0].revision_id",
      },
    });
  });

  it("round-trips a system-owned policy gate admission", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const bundle = renderCanonicalBundle({
      ...state,
      gateAdmissions: [
        {
          id: "gate-admission-system",
          spec_id: specId,
          gate: "requirements",
          basis: "import",
          approval_id: null,
          revision_id: revisionId,
          execution_id: null,
          actor_json: stableStringify({ kind: "system" }),
          created_at: CREATED_AT,
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toEqual({
      ok: true,
      value: bundle,
    });
  });

  it("applies canonical approval semantics to durable verification", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const corruptState = {
      ...state,
      approvals: [
        {
          ...state.approvals[0]!,
          subject_kind: "decision" as const,
        },
      ],
    };

    expect(() => verifyExportState(corruptState)).toThrow(
      /approvals\[0\]\.element_id/,
    );
    expect(() => renderVerifiedCanonicalBundle(corruptState)).toThrow(
      /approvals\[0\]\.element_id/,
    );
  });

  it.each([
    {
      sourceKind: "decision" as const,
      field: "tracedRequirementElementIds" as const,
      targetId: "task-1",
    },
    {
      sourceKind: "task" as const,
      field: "tracedRequirementElementIds" as const,
      targetId: "criterion-1",
    },
    {
      sourceKind: "task" as const,
      field: "tracedDecisionElementIds" as const,
      targetId: "requirement-1",
    },
    {
      sourceKind: "task" as const,
      field: "coveredCriterionElementIds" as const,
      targetId: "requirement-1",
    },
    {
      sourceKind: "task" as const,
      field: "dependsOnTaskElementIds" as const,
      targetId: "requirement-1",
    },
  ])(
    "rejects an invalid $sourceKind.$field reference",
    async ({ sourceKind, field, targetId }) => {
      const state = await loadSpecExportState(exportDeps, specId);
      const snapshot = state.revisions[0]!.snapshot;
      const sourceIndex = snapshot.elements.findIndex(
        ({ element }) => element.id === "task-1",
      );
      const source = snapshot.elements[sourceIndex]!;
      const payload =
        sourceKind === "decision"
          ? {
              kind: "decision" as const,
              title: "Choose the export strategy",
              chosenApproach: "Use the canonical bundle.",
              rejectedAlternatives: [],
              reason: "It is deterministic.",
              tracedRequirementElementIds: [targetId],
            }
          : { ...source.version.payload, [field]: [targetId] };
      const elements = [...snapshot.elements];
      elements[sourceIndex] = {
        element: { ...source.element, kind: sourceKind },
        version: {
          ...source.version,
          payload,
          payloadHash: computeSpecElementPayloadHash(payload),
        },
      };
      const bundle = renderCanonicalBundle({
        ...state,
        revisions: [
          {
            snapshot: {
              ...snapshot,
              revision: {
                ...snapshot.revision,
                contentHash: computeSpecRevisionContentHash(
                  snapshot.revision.authoringStage,
                  elements,
                ),
              },
              elements,
            },
          },
        ],
      });

      expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: `bundle.manifest.revisions[0].elements[${sourceIndex}].payload.${field}[0]`,
        },
      });
    },
  );

  it("keeps a stable element identity immutable across revisions", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const base = state.revisions[0]!.snapshot;
    const decisionPayload = {
      kind: "decision" as const,
      title: "Repurposed identity",
      chosenApproach: "Reuse an existing internal id.",
      rejectedAlternatives: [],
      reason: "This must be rejected by canonical verification.",
      tracedRequirementElementIds: [],
    };
    const elements = base.elements.map((row) =>
      row.element.id === "task-1"
        ? {
            element: { ...row.element, kind: "decision" as const },
            version: {
              ...row.version,
              payload: decisionPayload,
              payloadHash: computeSpecElementPayloadHash(decisionPayload),
            },
          }
        : row,
    );
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [
        { snapshot: base },
        {
          snapshot: {
            revision: {
              ...base.revision,
              id: "revision-export-2",
              number: 2,
              state: "draft",
              basedOnRevisionId: base.revision.id,
              contentHash: null,
              citationContractVersion: 2,
              citationHash: computeSpecRevisionCitationHash(2, []),
              proposedAt: null,
              approvedAt: null,
              createdAt: "2026-07-19T16:00:00.000Z",
            },
            elements,
            assumptionCitations: [],
          },
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[1].elements[2].kind",
      },
    });
  });

  it("requires unique canonical element handles within a revision", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const snapshot = state.revisions[0]!.snapshot;
    const source = snapshot.elements.find(
      ({ element }) => element.id === "requirement-1",
    )!;
    const duplicate = {
      element: {
        ...source.element,
        id: "duplicate-requirement",
      },
      version: {
        ...source.version,
        elementId: "duplicate-requirement",
        position: 4,
      },
    };
    const elements = [...snapshot.elements, duplicate];
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [
        {
          snapshot: {
            ...snapshot,
            revision: {
              ...snapshot.revision,
              contentHash: computeSpecRevisionContentHash(
                snapshot.revision.authoringStage,
                elements,
              ),
            },
            elements,
          },
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.revisions[0].elements[4].handle",
      },
    });
  });

  it.each(["added", "removed", "refreshed"] as const)(
    "rejects non-canonical citation audit %s ordering",
    async (collection) => {
      const state = await loadSpecExportState(exportDeps, specId);
      const snapshot = assumptionCitationSnapshot(
        state.assumptions[0]!,
        CITATION_CAPTURED_AT,
      );
      const beforeSnapshot = {
        ...snapshot,
        recordVersion: snapshot.recordVersion - 1,
        updatedAt: snapshot.createdAt,
      };
      const ordinaryEntry = {
        elementId: "requirement-1",
        assumptionId: snapshot.assumptionId,
        snapshot,
      };
      const laterEntry = {
        elementId: "task-1",
        assumptionId: snapshot.assumptionId,
        snapshot,
      };
      const refreshedEntry = {
        elementId: "requirement-1",
        assumptionId: snapshot.assumptionId,
        beforeSnapshot,
        afterSnapshot: snapshot,
      };
      const laterRefreshedEntry = {
        ...refreshedEntry,
        elementId: "task-1",
      };
      const citationRow = (
        elementId: string,
        citationSnapshot: typeof snapshot,
      ) => ({
        revisionId,
        specId,
        elementId,
        assumptionId: snapshot.assumptionId,
        snapshot: citationSnapshot,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      });
      const beforeCitations =
        collection === "added"
          ? []
          : [
              citationRow(
                "requirement-1",
                collection === "refreshed" ? beforeSnapshot : snapshot,
              ),
              citationRow(
                "task-1",
                collection === "refreshed" ? beforeSnapshot : snapshot,
              ),
            ];
      const afterCitations =
        collection === "removed"
          ? []
          : [
              citationRow("requirement-1", snapshot),
              citationRow("task-1", snapshot),
            ];
      const beforeCitationHash = computeSpecRevisionCitationHash(
        2,
        beforeCitations,
      );
      const afterCitationHash = computeSpecRevisionCitationHash(
        2,
        afterCitations,
      );
      const payload = {
        schemaVersion: 1,
        revisionId,
        beforeCitationVersion: 1,
        afterCitationVersion: 2,
        beforeCitationHash,
        afterCitationHash,
        added: collection === "added" ? [ordinaryEntry, laterEntry] : [],
        removed: collection === "removed" ? [ordinaryEntry, laterEntry] : [],
        refreshed:
          collection === "refreshed"
            ? [refreshedEntry, laterRefreshedEntry]
            : [],
      };
      const revision = state.revisions[0]!.snapshot;
      const bundle = renderCanonicalBundle({
        ...state,
        revisions: [
          {
            snapshot: {
              ...revision,
              revision: {
                ...revision.revision,
                citationVersion: 2,
                citationHash: afterCitationHash,
              },
              assumptionCitations: afterCitations,
            },
          },
        ],
        attentionAuditEvents: [
          {
            id: 1,
            spec_id: specId,
            event_type: "spec-assumption-citations-mutated",
            actor_json: stableStringify({
              kind: "agent",
              conversationId: "conversation-export",
            }),
            payload_json: stableStringify(payload),
            occurred_at: CREATED_AT,
          },
        ],
      });
      const manifest = JSON.parse(bundle.manifest) as {
        attentionAuditEvents: Array<{ payload_json: string }>;
      };
      const tamperedPayload = JSON.parse(
        manifest.attentionAuditEvents[0]!.payload_json,
      ) as typeof payload;
      tamperedPayload[collection].reverse();
      manifest.attentionAuditEvents[0]!.payload_json =
        stableStringify(tamperedPayload);

      const decoded = decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      });
      expect(decoded).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: `bundle.manifest.attentionAuditEvents[0].payload_json.${collection}[1]`,
        },
      });
    },
  );

  it("binds citation audit entry snapshots to their assumption identity", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const snapshot = assumptionCitationSnapshot(
      state.assumptions[0]!,
      CITATION_CAPTURED_AT,
    );
    const citations = [
      {
        revisionId,
        specId,
        elementId: "requirement-1",
        assumptionId: snapshot.assumptionId,
        snapshot,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ];
    const beforeCitationHash = computeSpecRevisionCitationHash(2, []);
    const afterCitationHash = computeSpecRevisionCitationHash(2, citations);
    const payload = {
      schemaVersion: 1,
      revisionId,
      beforeCitationVersion: 1,
      afterCitationVersion: 2,
      beforeCitationHash,
      afterCitationHash,
      added: [
        {
          elementId: "requirement-1",
          assumptionId: snapshot.assumptionId,
          snapshot,
        },
      ],
      removed: [],
      refreshed: [],
    };
    const revision = state.revisions[0]!.snapshot;
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [
        {
          snapshot: {
            ...revision,
            revision: {
              ...revision.revision,
              citationVersion: 2,
              citationHash: afterCitationHash,
            },
            assumptionCitations: citations,
          },
        },
      ],
      attentionAuditEvents: [
        {
          id: 1,
          spec_id: specId,
          event_type: "spec-assumption-citations-mutated",
          actor_json: stableStringify({
            kind: "agent",
            conversationId: "conversation-export",
          }),
          payload_json: stableStringify(payload),
          occurred_at: CREATED_AT,
        },
      ],
    });
    const manifest = JSON.parse(bundle.manifest) as {
      attentionAuditEvents: Array<{ payload_json: string }>;
    };
    const tamperedPayload = JSON.parse(
      manifest.attentionAuditEvents[0]!.payload_json,
    ) as typeof payload;
    tamperedPayload.added[0]!.snapshot.assumptionId = "other-assumption";
    manifest.attentionAuditEvents[0]!.payload_json =
      stableStringify(tamperedPayload);

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.attentionAuditEvents[0].payload_json.added[0].snapshot.assumptionId",
      },
    });
  });

  it("requires citation audit delta collections to be disjoint", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const snapshot = assumptionCitationSnapshot(
      state.assumptions[0]!,
      CITATION_CAPTURED_AT,
    );
    const removedCitation = {
      revisionId,
      specId,
      elementId: "task-1",
      assumptionId: snapshot.assumptionId,
      snapshot,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    const addedCitation = {
      ...removedCitation,
      elementId: "requirement-1",
    };
    const beforeCitationHash = computeSpecRevisionCitationHash(2, [
      removedCitation,
    ]);
    const afterCitationHash = computeSpecRevisionCitationHash(2, [
      addedCitation,
    ]);
    const payload = {
      schemaVersion: 1,
      revisionId,
      beforeCitationVersion: 1,
      afterCitationVersion: 2,
      beforeCitationHash,
      afterCitationHash,
      added: [
        {
          elementId: "requirement-1",
          assumptionId: snapshot.assumptionId,
          snapshot,
        },
      ],
      removed: [
        {
          elementId: "task-1",
          assumptionId: snapshot.assumptionId,
          snapshot,
        },
      ],
      refreshed: [],
    };
    const revision = state.revisions[0]!.snapshot;
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [
        {
          snapshot: {
            ...revision,
            revision: {
              ...revision.revision,
              citationVersion: 2,
              citationHash: afterCitationHash,
            },
            assumptionCitations: [addedCitation],
          },
        },
      ],
      attentionAuditEvents: [
        {
          id: 1,
          spec_id: specId,
          event_type: "spec-assumption-citations-mutated",
          actor_json: stableStringify({
            kind: "agent",
            conversationId: "conversation-export",
          }),
          payload_json: stableStringify(payload),
          occurred_at: CREATED_AT,
        },
      ],
    });
    const manifest = JSON.parse(bundle.manifest) as {
      attentionAuditEvents: Array<{ payload_json: string }>;
    };
    const tamperedPayload = JSON.parse(
      manifest.attentionAuditEvents[0]!.payload_json,
    ) as typeof payload;
    tamperedPayload.removed[0]!.elementId = "requirement-1";
    manifest.attentionAuditEvents[0]!.payload_json =
      stableStringify(tamperedPayload);

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.attentionAuditEvents[0].payload_json.removed[0]",
      },
    });
  });

  it("reports the exact unknown audit payload field", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const answered = state.questions[0]!;
    const open = {
      ...answered,
      record_version: answered.record_version - 1,
      status: "open" as const,
      answer: null,
      answered_at: null,
      updated_at: answered.created_at,
    };
    const payload = {
      schemaVersion: 1,
      recordKind: "question",
      recordId: state.questions[0]!.id,
      recordNumber: state.questions[0]!.number,
      attentionId: state.questions[0]!.id,
      operation: "answered",
      active: false,
      before: questionAuditSnapshot(open),
      after: questionAuditSnapshot(answered),
    };
    const bundle = renderCanonicalBundle({
      ...state,
      attentionAuditEvents: [
        {
          id: 1,
          spec_id: specId,
          event_type: "spec-review-record-mutated",
          actor_json: stableStringify({ kind: "human" }),
          payload_json: stableStringify(payload),
          occurred_at: CREATED_AT,
        },
      ],
    });
    const manifest = JSON.parse(bundle.manifest) as {
      attentionAuditEvents: Array<{ payload_json: string }>;
    };
    const tamperedPayload = JSON.parse(
      manifest.attentionAuditEvents[0]!.payload_json,
    ) as typeof payload & { after: Record<string, unknown> };
    tamperedPayload.after.unexpected = true;
    manifest.attentionAuditEvents[0]!.payload_json =
      stableStringify(tamperedPayload);

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.attentionAuditEvents[0].payload_json.after.unexpected",
      },
    });
  });

  it("requires canonical encoding for every nested JSON manifest column", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const answered = state.questions[0]!;
    const open = {
      ...answered,
      record_version: answered.record_version - 1,
      status: "open" as const,
      answer: null,
      answered_at: null,
      updated_at: answered.created_at,
    };
    const recordPayload = {
      schemaVersion: 1,
      recordKind: "question",
      recordId: answered.id,
      recordNumber: answered.number,
      attentionId: answered.id,
      operation: "answered",
      active: false,
      before: questionAuditSnapshot(open),
      after: questionAuditSnapshot(answered),
    };
    const bundle = renderCanonicalBundle({
      ...state,
      gateAdmissions: [
        {
          id: "admission-json",
          spec_id: specId,
          gate: "requirements",
          basis: "import",
          approval_id: null,
          revision_id: revisionId,
          execution_id: null,
          actor_json: JSON.stringify({
            kind: "agent",
            conversationId: "conversation-export",
          }),
          created_at: CREATED_AT,
        },
      ],
      attentionAuditEvents: [
        {
          id: 1,
          spec_id: specId,
          event_type: "spec-review-record-mutated",
          actor_json: JSON.stringify({ kind: "human" }),
          payload_json: JSON.stringify(recordPayload),
          occurred_at: answered.updated_at,
        },
      ],
    });
    const targets = [
      ["gateAdmissions", "actor_json"],
      ["questions", "provenance_json"],
      ["assumptions", "proposed_by_json"],
      ["attentionAuditEvents", "actor_json"],
      ["attentionAuditEvents", "payload_json"],
    ] as const;

    for (const [collection, field] of targets) {
      const manifest = JSON.parse(bundle.manifest) as Record<
        string,
        Array<Record<string, unknown>>
      >;
      const raw = manifest[collection]![0]![field] as string;
      manifest[collection]![0]![field] = JSON.stringify(
        JSON.parse(raw) as unknown,
        null,
        2,
      );

      expect(
        decodeCanonicalSpecBundle({
          ...bundle,
          manifest: `${stableStringify(manifest)}\n`,
        }),
      ).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        issue: {
          path: `bundle.manifest.${collection}[0].${field}`,
        },
      });
    }
  });

  it("binds human-only record events to a human actor", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const answered = state.questions[0]!;
    const open = {
      ...answered,
      record_version: answered.record_version - 1,
      status: "open" as const,
      answer: null,
      answered_at: null,
      updated_at: answered.created_at,
    };
    const payload = {
      schemaVersion: 1,
      recordKind: "question",
      recordId: answered.id,
      recordNumber: answered.number,
      attentionId: answered.id,
      operation: "answered",
      active: false,
      before: questionAuditSnapshot(open),
      after: questionAuditSnapshot(answered),
    };
    const bundle = renderCanonicalBundle({
      ...state,
      attentionAuditEvents: [
        {
          id: 1,
          spec_id: specId,
          event_type: "spec-review-record-mutated",
          actor_json: stableStringify({ kind: "human" }),
          payload_json: stableStringify(payload),
          occurred_at: answered.updated_at,
        },
      ],
    });
    const manifest = JSON.parse(bundle.manifest) as {
      attentionAuditEvents: Array<{ actor_json: string }>;
    };
    manifest.attentionAuditEvents[0]!.actor_json = stableStringify({
      kind: "agent",
      conversationId: "conversation-tampered",
    });

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.attentionAuditEvents[0].actor_json.kind",
      },
    });
  });

  it("validates each record-event operation against its lifecycle transition", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const answered = state.questions[0]!;
    const before = {
      ...answered,
      record_version: 1,
      status: "open" as const,
      answer: null,
      answered_at: null,
      updated_at: answered.created_at,
    };
    const after = {
      ...before,
      record_version: 2,
      updated_at: "2026-07-18T16:02:45.000Z",
    };
    const payload = {
      schemaVersion: 1,
      recordKind: "question",
      recordId: after.id,
      recordNumber: after.number,
      attentionId: after.id,
      operation: "edited",
      active: true,
      before: questionAuditSnapshot(before),
      after: questionAuditSnapshot(after),
    };
    const bundle = renderCanonicalBundle({
      ...state,
      questions: [after],
      attentionAuditEvents: [
        {
          id: 1,
          spec_id: specId,
          event_type: "spec-review-record-mutated",
          actor_json: stableStringify({
            kind: "agent",
            conversationId: "conversation-export",
          }),
          payload_json: stableStringify(payload),
          occurred_at: after.updated_at,
        },
      ],
    });
    const manifest = JSON.parse(bundle.manifest) as {
      attentionAuditEvents: Array<{
        actor_json: string;
        payload_json: string;
      }>;
    };
    const tamperedPayload = JSON.parse(
      manifest.attentionAuditEvents[0]!.payload_json,
    ) as typeof payload;
    tamperedPayload.operation = "answered";
    manifest.attentionAuditEvents[0]!.actor_json = stableStringify({
      kind: "human",
    });
    manifest.attentionAuditEvents[0]!.payload_json =
      stableStringify(tamperedPayload);

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.attentionAuditEvents[0].payload_json.after.status",
      },
    });
  });

  it("binds the latest record audit snapshot to the current durable record", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const answered = state.questions[0]!;
    const open = {
      ...answered,
      record_version: answered.record_version - 1,
      status: "open" as const,
      answer: null,
      answered_at: null,
      updated_at: answered.created_at,
    };
    const payload = {
      schemaVersion: 1,
      recordKind: "question" as const,
      recordId: answered.id,
      recordNumber: answered.number,
      attentionId: answered.id,
      operation: "answered" as const,
      active: false,
      before: questionAuditSnapshot(open),
      after: questionAuditSnapshot(answered),
    };
    const bundle = renderCanonicalBundle({
      ...state,
      attentionAuditEvents: [
        {
          id: 1,
          spec_id: specId,
          event_type: "spec-review-record-mutated",
          actor_json: stableStringify({ kind: "human" }),
          payload_json: stableStringify(payload),
          occurred_at: answered.updated_at,
        },
      ],
    });
    const manifest = JSON.parse(bundle.manifest) as {
      questions: Array<{ text: string }>;
    };
    manifest.questions[0]!.text = "A different durable question body";

    const decoded = decodeCanonicalSpecBundle({
      ...bundle,
      manifest: `${stableStringify(manifest)}\n`,
    });
    expect(decoded).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.attentionAuditEvents[0].payload_json.after.text",
      },
    });
    expect(JSON.stringify(decoded)).not.toContain(
      "A different durable question body",
    );
  });

  it("binds citation audit hashes to the deltas that produced the current revision", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const revision = state.revisions[0]!.snapshot;
    const snapshot = assumptionCitationSnapshot(
      state.assumptions[0]!,
      CITATION_CAPTURED_AT,
    );
    const citations = [
      {
        revisionId,
        specId,
        elementId: "requirement-1",
        assumptionId: snapshot.assumptionId,
        snapshot,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ];
    const beforeCitationHash = computeSpecRevisionCitationHash(2, []);
    const afterCitationHash = computeSpecRevisionCitationHash(2, citations);
    const payload = {
      schemaVersion: 1,
      revisionId,
      beforeCitationVersion: 1,
      afterCitationVersion: 2,
      beforeCitationHash,
      afterCitationHash,
      added: [
        {
          elementId: "requirement-1",
          assumptionId: snapshot.assumptionId,
          snapshot,
        },
      ],
      removed: [],
      refreshed: [],
    };
    const bundle = renderCanonicalBundle({
      ...state,
      revisions: [
        {
          snapshot: {
            ...revision,
            revision: {
              ...revision.revision,
              citationVersion: 2,
              citationHash: afterCitationHash,
            },
            assumptionCitations: citations,
          },
        },
      ],
      attentionAuditEvents: [
        {
          id: 1,
          spec_id: specId,
          event_type: "spec-assumption-citations-mutated",
          actor_json: stableStringify({
            kind: "agent",
            conversationId: "conversation-export",
          }),
          payload_json: stableStringify(payload),
          occurred_at: CREATED_AT,
        },
      ],
    });
    const manifest = JSON.parse(bundle.manifest) as {
      attentionAuditEvents: Array<{ payload_json: string }>;
    };
    const tamperedPayload = JSON.parse(
      manifest.attentionAuditEvents[0]!.payload_json,
    ) as typeof payload;
    tamperedPayload.beforeCitationHash = "0".repeat(64);
    manifest.attentionAuditEvents[0]!.payload_json =
      stableStringify(tamperedPayload);

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.attentionAuditEvents[0].payload_json.beforeCitationHash",
      },
    });
  });

  it("requires an element approval to name an element in its own revision", async () => {
    const secondRevisionId = "revision-export-2";
    await specs.createDraftFromBase({
      id: secondRevisionId,
      specId,
      baseRevisionId: revisionId,
      authoringStage: "plan",
      createdAt: "2026-07-19T10:00:00.000Z",
    });
    await specs.createDraftElement({
      id: "later-revision-element",
      specId,
      revisionId: secondRevisionId,
      kind: "requirement",
      parentElementId: null,
      position: 4,
      payload: {
        kind: "requirement",
        statement: "This element exists only in the later revision.",
        priority: "must",
        risk: "low",
      },
      createdAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    const state = await loadSpecExportState(exportDeps, specId);
    const bundle = renderCanonicalBundle({
      ...state,
      approvals: [
        {
          ...state.approvals[0]!,
          revision_id: revisionId,
          element_id: "later-revision-element",
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.approvals[0].element_id",
      },
    });
  });

  it("retains display attachments to element identities absent from revision snapshots", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const bundle = renderCanonicalBundle({
      ...state,
      questions: [
        {
          ...state.questions[0]!,
          element_id: "removed-element-identity",
        },
      ],
      assumptions: [
        {
          ...state.assumptions[0]!,
          element_id: "removed-element-identity",
        },
      ],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toEqual({
      ok: true,
      value: bundle,
    });
  });

  it("requires an assumption predecessor to predate its successor", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const successor = {
      ...state.assumptions[0]!,
      id: "assumption-successor",
      number: 2,
      record_version: 1,
      disposition: "proposed" as const,
      disposed_at: null,
      withdrawn_at: null,
      supersedes_assumption_id: state.assumptions[0]!.id,
      supersession_operation_id: "supersession-operation",
      supersession_request_hash: "a".repeat(64),
      created_at: "2026-07-19T16:00:00.000Z",
      updated_at: "2026-07-19T16:00:00.000Z",
    };
    const bundle = renderCanonicalBundle({
      ...state,
      assumptions: [state.assumptions[0]!, successor],
    });
    const manifest = JSON.parse(bundle.manifest) as {
      assumptions: Array<{ created_at: string; updated_at: string }>;
    };
    manifest.assumptions[1]!.created_at = "2026-07-17T16:00:00.000Z";
    manifest.assumptions[1]!.updated_at = "2026-07-17T16:00:00.000Z";

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.assumptions[1].created_at",
      },
    });
  });

  it("allows a predecessor and successor created in the same millisecond", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const predecessor = state.assumptions[0]!;
    const successor = {
      ...predecessor,
      id: "assumption-successor-same-millisecond",
      number: 2,
      record_version: 1,
      disposition: "proposed" as const,
      disposed_at: null,
      withdrawn_at: null,
      supersedes_assumption_id: predecessor.id,
      supersession_operation_id: "supersession-same-millisecond",
      supersession_request_hash: "a".repeat(64),
      created_at: predecessor.created_at,
      updated_at: predecessor.created_at,
    };
    const bundle = renderCanonicalBundle({
      ...state,
      assumptions: [predecessor, successor],
    });

    expect(decodeCanonicalSpecBundle(bundle)).toEqual({
      ok: true,
      value: bundle,
    });
  });

  it("reports malformed attention lifecycle rows at their manifest path", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const manifest = JSON.parse(bundle.manifest) as {
      questions: Array<{ answer: string | null }>;
    };
    manifest.questions[0]!.answer = null;

    expect(
      decodeCanonicalSpecBundle({
        ...bundle,
        manifest: `${stableStringify(manifest)}\n`,
      }),
    ).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest.questions[0]",
      },
    });
  });

  it("requires the manifest and markdown files to match canonical re-rendering", async () => {
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );
    const prettyManifest = `${JSON.stringify(JSON.parse(bundle.manifest), null, 2)}\n`;
    const nonCanonicalManifest = decodeCanonicalSpecBundle({
      ...bundle,
      manifest: prettyManifest,
    });
    const tamperedMarkdown = decodeCanonicalSpecBundle({
      ...bundle,
      markdownFiles: [
        {
          ...bundle.markdownFiles[0]!,
          content: `${bundle.markdownFiles[0]!.content}\ntampered authored body`,
        },
      ],
    });

    expect(nonCanonicalManifest).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.manifest",
        message: "does not match canonical format-4 rendering",
      },
    });
    expect(tamperedMarkdown).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      issue: {
        path: "bundle.markdownFiles[0].content",
        message: "does not match canonical revision rendering",
      },
    });
    expect(JSON.stringify(tamperedMarkdown)).not.toContain(
      "tampered authored body",
    );
  });

  it("rejects missing, extra, duplicate, and reordered markdown paths", async () => {
    await specs.createDraftFromBase({
      id: "revision-export-2",
      specId,
      baseRevisionId: revisionId,
      authoringStage: "plan",
      createdAt: "2026-07-19T10:00:00.000Z",
    });
    const bundle = renderCanonicalBundle(
      await loadSpecExportState(exportDeps, specId),
    );

    const missing = decodeCanonicalSpecBundle({
      ...bundle,
      markdownFiles: bundle.markdownFiles.slice(0, 1),
    });
    const extra = decodeCanonicalSpecBundle({
      ...bundle,
      markdownFiles: [
        ...bundle.markdownFiles,
        { path: "revisions/9999-draft.md", content: "" },
      ],
    });
    const duplicate = decodeCanonicalSpecBundle({
      ...bundle,
      markdownFiles: [bundle.markdownFiles[0]!, bundle.markdownFiles[0]!],
    });
    const reordered = decodeCanonicalSpecBundle({
      ...bundle,
      markdownFiles: [...bundle.markdownFiles].reverse(),
    });

    expect(missing).toMatchObject({
      ok: false,
      issue: { path: "bundle.markdownFiles[1]" },
    });
    expect(extra).toMatchObject({
      ok: false,
      issue: { path: "bundle.markdownFiles[2]" },
    });
    expect(duplicate).toMatchObject({
      ok: false,
      issue: { path: "bundle.markdownFiles[1].path" },
    });
    expect(reordered).toMatchObject({
      ok: false,
      issue: { path: "bundle.markdownFiles[0].path" },
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
        record_version: 2,
        withdrawn_at: null,
        answer: "OAuth only.",
      }),
    ]);
    expect(manifest.assumptions).toEqual([
      expect.objectContaining({
        id: "assumption-1",
        number: 1,
        disposition: "confirmed",
        record_version: 2,
        supersedes_assumption_id: null,
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

  it("rejects contradictory question and assumption lifecycle rows", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const malformedQuestion = {
      ...state.questions[0]!,
      status: "answered",
      answer: null,
      answered_at: null,
    } as (typeof state.questions)[number];
    const malformedAssumption = {
      ...state.assumptions[0]!,
      disposition: "confirmed",
      disposed_at: null,
    } as (typeof state.assumptions)[number];

    expect(() =>
      verifyExportState({
        ...state,
        questions: [malformedQuestion],
      }),
    ).toThrow(/question/i);
    expect(() =>
      verifyExportState({
        ...state,
        assumptions: [malformedAssumption],
      }),
    ).toThrow(/assumption/i);
  });

  it("rejects missing and non-unique assumption supersession lineage", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const successor = {
      ...state.assumptions[0]!,
      id: "assumption-successor-1",
      number: 2,
      disposition: "proposed" as const,
      disposed_at: null,
      supersedes_assumption_id: "assumption-missing",
      supersession_operation_id: "operation-1",
      supersession_request_hash: "a".repeat(64),
    };

    expect(() =>
      verifyExportState({
        ...state,
        assumptions: [state.assumptions[0]!, successor],
      }),
    ).toThrow(/supersession|predecessor/i);

    expect(() =>
      verifyExportState({
        ...state,
        assumptions: [
          state.assumptions[0]!,
          {
            ...successor,
            supersedes_assumption_id: "assumption-1",
          },
          {
            ...successor,
            id: "assumption-successor-2",
            number: 3,
            supersedes_assumption_id: "assumption-1",
            supersession_operation_id: "operation-2",
            supersession_request_hash: "b".repeat(64),
          },
        ],
      }),
    ).toThrow(/supersession|successor/i);
  });

  it.each([
    "spec-review-record-mutated" as const,
    "spec-assumption-citations-mutated" as const,
  ])(
    "rejects malformed %s audit events before verify or export",
    async (eventType) => {
      const state = await loadSpecExportState(exportDeps, specId);
      const malformed = {
        id: 1,
        spec_id: specId,
        occurred_at: CREATED_AT,
        event_type: eventType,
        actor_json: JSON.stringify({ kind: "human" }),
        payload_json: "{}",
      };
      const corruptState = { ...state, attentionAuditEvents: [malformed] };

      expect(() => verifyExportState(corruptState)).toThrow(/audit event/i);
      expect(() => renderCanonicalBundle(corruptState)).toThrow(/audit event/i);
    },
  );

  it("detects citation integrity drift independently of element content", async () => {
    const state = await loadSpecExportState(exportDeps, specId);
    const snapshot = state.revisions[0]!.snapshot;
    const report = verifyExportState({
      ...state,
      revisions: [
        {
          snapshot: {
            ...snapshot,
            revision: {
              ...snapshot.revision,
              citationHash: "f".repeat(64),
            },
          },
        },
      ],
    });

    expect(report).toMatchObject({
      ok: false,
      mismatches: [
        {
          revisionId,
          expectedCitationHash: "f".repeat(64),
          actualCitationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          mismatchedElementIds: [],
        },
      ],
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
   * Within canonical format 4, an undeclared optional executionLane carries no
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
        expectedCitationHash:
          state.revisions[0]!.snapshot.revision.citationHash,
        actualCitationHash: state.revisions[0]!.snapshot.revision.citationHash,
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
