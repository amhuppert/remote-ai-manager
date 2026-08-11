import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import { type OpenAmendmentResult } from "./authoring-service";
import {
  authorSpineDraft,
  createSpecSpineWorld,
  postJson,
  SPINE_PROJECT_PATH,
  type SpecSpineWorld,
} from "./spine-test-fixture";
import {
  specDetailViewSchema,
  specInventoryViewSchema,
  specStatusViewSchema,
  type SpecDetailView,
  type SpecStatusView,
} from "./view-schemas";

const SLUG = "imported-delivered";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-import-delivered",
} as const;

let world: SpecSpineWorld;

function bundle(overrides: Record<string, unknown> = {}): unknown {
  return {
    slug: SLUG,
    name: "Imported Delivered Feature",
    source: { label: "kiro:.kiro/specs/shipped-feature" },
    sections: [
      {
        role: "intent_problem",
        title: "Problem",
        body: "The feature shipped before Command Center tracked it.",
      },
    ],
    requirements: [
      {
        ref: "shipped",
        statement: "The imported work is already in production.",
        priority: "must",
        risk: "medium",
        criteria: [
          {
            text: "The shipped behavior is reachable in production.",
            validationStrategy: { kinds: ["test_run"] },
          },
        ],
      },
    ],
    decisions: [],
    questions: [],
    assumptions: [],
    ...overrides,
  };
}

async function importSpec(input: unknown = bundle()) {
  const result = await world.services.import.importSpec({
    projectPath: SPINE_PROJECT_PATH,
    bundle: input,
    actor: AGENT,
  });
  if (!result.ok) {
    throw new Error(
      `expected import to succeed, refused: ${JSON.stringify(result.refusal)}`,
    );
  }
  if (result.dryRun) {
    throw new Error("expected a real import, got a dry-run preview");
  }
  return result.value;
}

/**
 * Parsed through the canonical view schemas rather than cast to a local shape.
 * `postJson`'s generic is unchecked, so a hand-declared response type would let
 * this evidence keep passing after the real client contract drifted — and these
 * are the projections that carry import provenance, where a silent drift is
 * exactly the failure the assertions below exist to catch. The strict parse
 * also rejects any extra wire field, which is what holds the imported revision
 * to a single source on the admissions.
 */
async function readStatus(): Promise<SpecStatusView> {
  return specStatusViewSchema.parse(
    await postJson(world.getRoute("getSpecStatusGET", { slug: SLUG })),
  );
}

async function readDetail(): Promise<SpecDetailView> {
  return specDetailViewSchema.parse(
    await postJson(world.getRoute("getSpecGET", { slug: SLUG })),
  );
}

async function criterionElementIds(revisionId: string): Promise<string[]> {
  const snapshot = await world.repos.specs.getRevisionSnapshot(revisionId);
  return (snapshot?.elements ?? [])
    .filter(({ element }) => element.kind === "criterion")
    .map(({ element }) => element.id);
}

function countRows(table: string, specId: string): number {
  return (
    world.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE spec_id = ?`)
      .get(specId) as { count: number }
  ).count;
}

beforeEach(() => {
  resetJobQueue();
  _resetDeliveryGateEvaluatorForTesting();
  resetGraphExecutionLifecycleCallbacksForTesting();
  world = createSpecSpineWorld();
});

afterEach(() => {
  resetJobQueue();
  _resetDeliveryGateEvaluatorForTesting();
  resetGraphExecutionLifecycleCallbacksForTesting();
});

describe("an import's external-delivery record projects Delivered without proof (R4.1, R9.2)", () => {
  it("reads Delivered with no execution, waiver, proof verdict, or delivery admission behind it", async () => {
    const receipt = await importSpec();

    const status = await readStatus();
    expect(status.phase.primary).toBe("delivered");
    // The delivered tally counts the externally-delivered criterion; the proof
    // tally does not, so no surface can render the testimony as merged proof.
    expect(status.delivery).toEqual({
      allWaived: false,
      deliveredCount: 1,
      deliveredExternallyCriterionIds: await criterionElementIds(
        receipt.revision.id,
      ),
      provenCount: 0,
      totalInScope: 1,
    });

    // Nothing an execution, a waiver, or a proof would have written exists —
    // the phase is carried by the record alone, and the delivery gate has
    // admitted nothing.
    expect(countRows("spec_executions", receipt.spec.id)).toBe(0);
    expect(countRows("spec_waivers", receipt.spec.id)).toBe(0);
    expect(countRows("spec_proof_verdicts", receipt.spec.id)).toBe(0);
    expect(
      world.repos.review
        .findGateAdmissionsBySpecId(receipt.spec.id)
        .map(({ gate, basis }) => ({ gate, basis })),
    ).toEqual([
      { gate: "requirements", basis: "import" },
      { gate: "design", basis: "import" },
    ]);
  });

  /**
   * The requirement rollup is a proof surface, so the externally-delivered
   * criterion must reach it as its own state. Mapping it to `proven` on the way
   * would let the detail's requirement chip claim a proof this system never
   * took (R9.4).
   */
  it("rolls the requirement up as delivered externally rather than proven", async () => {
    await importSpec();

    const detail = await readDetail();
    expect(
      detail.elementStatuses.requirements.map(({ status }) => status.proof),
    ).toEqual(["delivered_externally"]);
  });

  it("reads Approved with no record when the bundle opts out of delivered marking", async () => {
    await importSpec(bundle({ delivered: false }));

    const status = await readStatus();
    expect(status.phase.primary).toBe("approved");
    expect(status.delivery).toEqual({
      allWaived: false,
      deliveredCount: 0,
      deliveredExternallyCriterionIds: [],
      provenCount: 0,
      totalInScope: 1,
    });
  });
});

describe("the spec views expose import provenance without a human approver (R9.1)", () => {
  it("reports imported on the status and summary views, derived from the import admission basis", async () => {
    await importSpec();
    await authorSpineDraft(world, "authored-natively");

    const status = await readStatus();
    expect(status.imported).toBe(true);

    const inventory = specInventoryViewSchema.parse(
      await postJson(world.getRoute("listSpecsGET", {})),
    );
    expect(
      inventory.specs.map(({ spec, imported }) => [spec.slug, imported]),
    ).toEqual(
      expect.arrayContaining([
        [SLUG, true],
        ["authored-natively", false],
      ]),
    );
  });

  /**
   * History reconstructs the import from its durable event, so the detail has
   * to carry that event's source label and content counts. Nothing else on the
   * wire holds them: a spec imported without a delivery record leaves no other
   * trace of where its content came from (R9.6).
   */
  it("carries the spec-imported event's source label and content counts on the detail", async () => {
    await importSpec();

    const detail = await readDetail();
    // Event-only data, and nothing more. Which revision the import created is
    // absent on purpose: the admissions below already state it, and a second
    // copy is a provenance source that can drift from the one the gates are
    // keyed to.
    expect(detail.importRecord).toEqual({
      occurredAt: expect.any(String),
      sourceLabel: "kiro:.kiro/specs/shipped-feature",
      counts: {
        sections: 1,
        requirements: 1,
        criteria: 1,
        decisions: 0,
        questions: 0,
        assumptions: 0,
      },
    });
  });

  /**
   * The canonical provenance the Studio reads. It has to name the imported
   * revision and the import instant on its own, because the event projection
   * goes null whenever its payload is unreadable and a surface that derived
   * attribution from the event would then present the import as a human act.
   */
  it("states the imported revision and instant on the import-basis admissions", async () => {
    const receipt = await importSpec();

    const detail = await readDetail();
    const imported = detail.gateAdmissions.filter(
      (admission) => admission.basis === "import",
    );
    expect(imported).not.toHaveLength(0);
    for (const admission of imported) {
      expect(admission.revisionId).toBe(receipt.revision.id);
      expect(admission.createdAt).toBe(detail.importRecord?.occurredAt);
    }
  });

  it("names no human approver anywhere on the imported revision's sign-off surfaces", async () => {
    const receipt = await importSpec();

    const status = await readStatus();
    // Born past the authoring gates on an external document's word: no
    // approval row exists to name an approver, and the sign-off facet carries
    // none either.
    expect(status.revisionSignOff?.approval ?? null).toBeNull();
    expect(countRows("spec_approvals", receipt.spec.id)).toBe(0);

    const detail = await readDetail();
    expect(detail.approvals).toEqual([]);
    expect(detail.status.imported).toBe(true);
    // Asserted non-empty first: the loop below passes vacuously on an empty
    // array, which is exactly the state the detail projection was in when its
    // pinned-revision filter dropped every admission an import writes.
    expect(detail.gateAdmissions).not.toHaveLength(0);
    for (const admission of detail.gateAdmissions) {
      expect(admission.basis).toBe("import");
      expect(admission.approvalId).toBeNull();
    }
  });

  it("keeps the provenance after an amendment forks the imported revision", async () => {
    await importSpec();
    const amendment = await postJson<OpenAmendmentResult>(
      world.postAction(SLUG, "open-amendment", {}, "agent"),
    );
    await postJson(
      world.postAction(
        SLUG,
        "propose",
        { revisionId: amendment.revision.id },
        "agent",
      ),
    );
    await postJson(
      world.postAction(
        SLUG,
        "approve-remaining-and-sign-off",
        { revisionId: amendment.revision.id },
        "human",
      ),
    );

    // The amendment carries no import admission of its own, but the content it
    // forked entered by import: provenance is read over the approved
    // revision's lineage, so amending a spec cannot launder its origin.
    expect((await readStatus()).imported).toBe(true);
  });
});

describe("the external-delivery record is pinned to the imported revision (R4.3)", () => {
  it("drops back to Approved once an amendment becomes the current approved revision", async () => {
    const receipt = await importSpec();
    expect((await readStatus()).phase.primary).toBe("delivered");

    // Amend through the ordinary authoring path: the amendment forks the
    // imported revision at the next stage, so it carries the content but not
    // the external-delivery claim that was made about the imported content.
    const amendment = await postJson<OpenAmendmentResult>(
      world.postAction(SLUG, "open-amendment", {}, "agent"),
    );
    await postJson(
      world.postAction(
        SLUG,
        "draft-upsert",
        {
          revisionId: amendment.revision.id,
          elementId: "element-amendment-section",
          kind: "section",
          parentElementId: null,
          position: 1,
          payload: {
            kind: "section",
            role: "design_narrative",
            title: "Amended design",
            body: "The imported content is being changed here.",
          },
          baseElementVersion: null,
        },
        "agent",
      ),
    );
    await postJson(
      world.postAction(
        SLUG,
        "propose",
        { revisionId: amendment.revision.id },
        "agent",
      ),
    );
    await postJson(
      world.postAction(
        SLUG,
        "approve-remaining-and-sign-off",
        { revisionId: amendment.revision.id },
        "human",
      ),
    );

    const status = await readStatus();
    expect(status.phase.primary).toBe("approved");
    expect(status.delivery).toEqual({
      allWaived: false,
      deliveredCount: 0,
      deliveredExternallyCriterionIds: [],
      provenCount: 0,
      totalInScope: 1,
    });
    // The record itself is untouched: it is testimony about the revision it
    // was made on, and that revision is still what it was.
    const revisions = await world.repos.specs.listRevisions(receipt.spec.id);
    expect(
      revisions.find(({ id }) => id === receipt.revision.id)?.externalDelivery,
    ).not.toBeNull();
    expect(
      revisions.find(({ id }) => id === amendment.revision.id)
        ?.externalDelivery,
    ).toBeNull();
  });
});
