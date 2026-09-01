import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";

import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import { authoringReviewProjection } from "./authoring-review-projection";
import { createSpecEventsPublisher } from "./events";
import { createImportService, type ImportService } from "./import-service";
import { loadProposalState } from "./review-state";
import { createReviewService, type ReviewService } from "./review-service";
import type { Spec, SpecRevision } from "./schemas";

const PROJECT_PATH = "/repos/spec-import-carry-forward";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-import-amend",
} as const;
const HUMAN = { kind: "human" } as const;

interface Harness {
  readonly fixture: PersistenceFixture;
  readonly review: ReturnType<typeof createSpecReviewRepo>;
  readonly links: ReturnType<typeof createSpecLinksRepo>;
  readonly importing: ImportService;
  readonly authoring: AuthoringService;
  readonly reviewing: ReviewService;
}

let harness: Harness;

function bundle(): unknown {
  return {
    slug: "imported-carry-forward",
    name: "Imported Carry Forward",
    source: { label: "kiro:.kiro/specs/legacy-carry-forward" },
    sections: [
      {
        role: "intent_problem",
        title: "Problem",
        body: "The spec was authored outside Command Center.",
      },
    ],
    requirements: [
      {
        ref: "carry",
        statement: "An amendment asks a human only about what it changed.",
        priority: "must",
        risk: "high",
        criteria: [
          {
            text: "Untouched imported requirements are not approval subjects.",
            validationStrategy: { kinds: ["test_run"] },
          },
        ],
      },
      {
        ref: "untouched",
        statement: "An untouched imported requirement stays admitted.",
        priority: "should",
        risk: "medium",
        criteria: [
          {
            text: "No approval row is ever written by an import.",
            validationStrategy: { kinds: ["test_run"] },
          },
        ],
      },
    ],
    decisions: [
      {
        title: "Carry forward from the import baseline",
        chosenApproach:
          "Treat an element matching its imported payload hash as approved.",
        rejectedAlternatives: [
          {
            label: "Re-ask for every imported element",
            reason: "Would drown the first amendment in re-approvals.",
          },
        ],
        reason: "Only changed content owes a human act.",
        traces: ["carry", "untouched"],
      },
    ],
    questions: [],
    assumptions: [],
  };
}

async function importedSpec(): Promise<{
  spec: Spec;
  revision: SpecRevision;
  elementIdByStatement: Map<string, string>;
  criterionIdByText: Map<string, string>;
}> {
  const result = await harness.importing.importSpec({
    projectPath: PROJECT_PATH,
    bundle: bundle(),
    actor: AGENT,
  });
  if (!result.ok) {
    throw new Error(
      `expected the import to succeed, refused: ${JSON.stringify(result.refusal)}`,
    );
  }
  if (result.dryRun) {
    throw new Error("expected a real import, got a dry-run preview");
  }
  const snapshot = await harness.fixture.specs.getRevisionSnapshot(
    result.value.revision.id,
  );
  const elementIdByStatement = new Map(
    (snapshot?.elements ?? []).flatMap(({ element, version }) =>
      version.payload.kind === "requirement"
        ? [[version.payload.statement, element.id] as const]
        : [],
    ),
  );
  const criterionIdByText = new Map(
    (snapshot?.elements ?? []).flatMap(({ element, version }) =>
      version.payload.kind === "criterion"
        ? [[version.payload.text, element.id] as const]
        : [],
    ),
  );
  return {
    spec: result.value.spec,
    revision: result.value.revision,
    elementIdByStatement,
    criterionIdByText,
  };
}

/**
 * The status read every surface renders, composed exactly as the read routes
 * compose it — so what the pending list says here is what a human is shown.
 */
async function statusProjection(spec: Spec, revisionId: string) {
  const snapshot = await harness.fixture.specs.getRevisionSnapshot(revisionId);
  if (snapshot === null) throw new Error("expected a revision snapshot");
  const revisions = await harness.fixture.specs.listRevisions(spec.id);
  const findings = await harness.authoring.lintDraft(spec.id, revisionId);
  return harness.fixture.specs.transaction("test.projection", (repo) => {
    const loaded = loadProposalState(
      repo,
      harness.review,
      harness.links,
      spec,
      snapshot,
    );
    return authoringReviewProjection({
      policy: spec.gatePolicy,
      snapshot,
      governanceBaseSnapshot: loaded.governanceBaseSnapshot,
      importBaselineRows: loaded.importBaselineRows,
      importBaselineCitationState: loaded.importBaselineCitationState,
      approvals: harness.review.findApprovalsBySpecId(spec.id),
      admissions: harness.review.findGateAdmissionsBySpecId(spec.id),
      currentExecution: null,
      revisionNumberById: new Map(
        revisions.map((candidate) => [candidate.id, candidate.number]),
      ),
      applies: loaded.approvalApplies,
      blockingThreads: loaded.reviewSnapshot.blockingThreads,
      signOffFindings: findings.filter(
        (finding) => finding.severity === "blocks_signoff",
      ),
    });
  });
}

beforeEach(() => {
  const fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const review = createSpecReviewRepo(fixture.db);
  const links = createSpecLinksRepo(fixture.db);
  const specEvents = createSpecEventsRepo(fixture.db);
  const events = createSpecEventsPublisher({
    appendInTransaction: specEvents.appendInTransaction,
    publish: () => ({ delivered: true }),
  });
  let ids = 0;
  let times = 0;
  const deps = {
    specs: fixture.specs,
    review,
    links,
    events,
    newId(prefix: string) {
      ids += 1;
      return `${prefix}-${ids}`;
    },
    now() {
      times += 1;
      return `2026-08-11T10:00:${String(times).padStart(2, "0")}.000Z`;
    },
  };
  harness = {
    fixture,
    review,
    links,
    importing: createImportService(deps),
    authoring: createAuthoringService(deps),
    reviewing: createReviewService({
      ...deps,
      attention: specEvents,
      delivery: createSpecDeliveryRepo(fixture.db),
    }),
  };
});

afterEach(() => harness.fixture.close());

/**
 * An imported spec carries no approval row at all: its gates were admitted on
 * import basis. The first amendment must therefore ask a human about what it
 * changed and nothing else, or every imported element would be re-litigated.
 */
describe("amending an imported spec", () => {
  it("lists only the changed requirement as outstanding and signs off once it is approved", async () => {
    const imported = await importedSpec();
    const changedElementId = imported.elementIdByStatement.get(
      "An amendment asks a human only about what it changed.",
    );
    if (changedElementId === undefined) {
      throw new Error("expected the imported requirement to exist");
    }

    const amendment = await harness.authoring.openAmendment({
      specId: imported.spec.id,
      actor: AGENT,
    });
    await harness.authoring.upsertDraftElement({
      specId: imported.spec.id,
      revisionId: amendment.revision.id,
      elementId: changedElementId,
      kind: "requirement",
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "An amendment asks a human only about the changed subject.",
        priority: "must",
        risk: "high",
      },
      baseElementVersion: 1,
      actor: AGENT,
    });
    const proposed = await harness.authoring.proposeRevision({
      specId: imported.spec.id,
      revisionId: amendment.revision.id,
      actor: AGENT,
    });
    expect(proposed).toMatchObject({ ok: true });

    const projection = await statusProjection(
      imported.spec,
      amendment.revision.id,
    );
    expect(projection.pendingApprovals).toEqual([
      { gate: "requirements", subject: "R1", elementId: changedElementId },
    ]);
    expect(projection.revisionSignOff?.unmetConditions).toEqual([
      `Requirement R1 needs a valid approval for ${amendment.revision.id}.`,
    ]);

    // The carry-forward is only real if the human act it leaves is sufficient:
    // approving the one changed subject must complete the sign-off.
    await expect(
      harness.reviewing.approveItem({
        specId: imported.spec.id,
        revisionId: amendment.revision.id,
        subjectKind: "requirement",
        elementId: changedElementId,
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: true });

    // Honest provenance: with the one human act recorded, the status read must
    // still separate what a human approved from what the import carried — the
    // approval rows say R1 and nothing else.
    const settled = await statusProjection(
      imported.spec,
      amendment.revision.id,
    );
    expect(settled.pendingApprovals).toEqual([]);
    expect(
      settled.importCarriedApprovals.map(({ gate, subject }) => [
        gate,
        subject,
      ]),
    ).toEqual([["requirements", "R2"]]);
    expect(settled.pendingBlock?.display).not.toContain(
      "every consulted subject approved",
    );
    expect(
      harness.review
        .findApprovalsBySpecId(imported.spec.id)
        .filter((row) => row.subject_kind !== "revision")
        .map((row) => row.element_id),
    ).toEqual([changedElementId]);

    await expect(
      harness.reviewing.signOffRevision({
        specId: imported.spec.id,
        revisionId: amendment.revision.id,
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  /**
   * A criterion is not an approval subject of its own — approving a
   * requirement approves what would satisfy it — so rewriting one changes the
   * parent's subject and owes that parent a human approval.
   */
  it("owes the parent requirement when the amendment rewrote only its criterion", async () => {
    const imported = await importedSpec();
    const criterionId = imported.criterionIdByText.get(
      "No approval row is ever written by an import.",
    );
    const parentRequirementId = imported.elementIdByStatement.get(
      "An untouched imported requirement stays admitted.",
    );
    if (criterionId === undefined || parentRequirementId === undefined) {
      throw new Error(
        "expected the imported criterion and its parent to exist",
      );
    }

    const amendment = await harness.authoring.openAmendment({
      specId: imported.spec.id,
      actor: AGENT,
    });
    await harness.authoring.upsertDraftElement({
      specId: imported.spec.id,
      revisionId: amendment.revision.id,
      elementId: criterionId,
      kind: "criterion",
      parentElementId: parentRequirementId,
      payload: {
        kind: "criterion",
        text: "No approval row is ever written by an import, in any basis.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: 1,
      actor: AGENT,
    });
    const proposed = await harness.authoring.proposeRevision({
      specId: imported.spec.id,
      revisionId: amendment.revision.id,
      actor: AGENT,
    });
    expect(proposed).toMatchObject({ ok: true });

    const projection = await statusProjection(
      imported.spec,
      amendment.revision.id,
    );
    expect(projection.pendingApprovals).toEqual([
      { gate: "requirements", subject: "R2", elementId: parentRequirementId },
    ]);
    expect(projection.revisionSignOff?.unmetConditions).toEqual([
      `Requirement R2 needs a valid approval for ${amendment.revision.id}.`,
    ]);
  });

  it("owes approval for an element the import baseline never carried", async () => {
    const imported = await importedSpec();

    const amendment = await harness.authoring.openAmendment({
      specId: imported.spec.id,
      actor: AGENT,
    });
    await harness.authoring.upsertDraftElement({
      specId: imported.spec.id,
      revisionId: amendment.revision.id,
      elementId: "requirement-added",
      kind: "requirement",
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "A new requirement owes a human approval.",
        priority: "must",
        risk: "high",
      },
      baseElementVersion: null,
      actor: AGENT,
    });
    await harness.authoring.upsertDraftElement({
      specId: imported.spec.id,
      revisionId: amendment.revision.id,
      elementId: "criterion-added",
      kind: "criterion",
      parentElementId: "requirement-added",
      payload: {
        kind: "criterion",
        text: "The new requirement appears as an outstanding subject.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
      actor: AGENT,
    });
    const proposed = await harness.authoring.proposeRevision({
      specId: imported.spec.id,
      revisionId: amendment.revision.id,
      actor: AGENT,
    });
    expect(proposed).toMatchObject({ ok: true });

    const projection = await statusProjection(
      imported.spec,
      amendment.revision.id,
    );
    expect(projection.pendingApprovals).toEqual([
      {
        gate: "requirements",
        subject: "R3",
        elementId: "requirement-added",
      },
    ]);
  });
});
