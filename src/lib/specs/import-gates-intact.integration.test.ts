import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import { createDeliveryGate, type DeliveryGateDeps } from "./delivery-gate-v2";
import { createSpecExecutionBindingPorts } from "./execution-binding-service";
import { createAuthoredContextOutcomeService } from "@/lib/workflow-graph/authored-context-outcome";
import { createSpecEventsPublisher } from "./events";
import { createImportService, type ImportService } from "./import-service";
import { HUMAN_ACT_REQUIRED_RATIONALE } from "./refusal-rationale";
import { createReviewService, type ReviewService } from "./review-service";
import type { Spec, SpecRevision } from "./schemas";

const PROJECT_PATH = "/repos/spec-import-gates";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-import-gates",
} as const;
const HUMAN = { kind: "human" } as const;
const WORKFLOW_EXECUTION_ID = "workflow-execution-imported";
const AT = "2026-08-11T11:00:00.000Z";

interface Harness {
  readonly fixture: PersistenceFixture;
  readonly review: ReturnType<typeof createSpecReviewRepo>;
  readonly delivery: ReturnType<typeof createSpecDeliveryRepo>;
  readonly importing: ImportService;
  readonly authoring: AuthoringService;
  readonly reviewing: ReviewService;
  readonly bindingRepo: ReturnType<typeof createSpecExecutionBindingRepo>;
  readonly gateDeps: DeliveryGateDeps;
  readonly requestedApprovals: Array<{
    specId: string;
    revisionId: string;
    workflowExecutionId?: string;
  }>;
}

let harness: Harness;

function bundle(): unknown {
  return {
    slug: "imported-gates",
    name: "Imported Gates",
    source: { label: "kiro:.kiro/specs/legacy-gates" },
    sections: [
      {
        role: "intent_problem",
        title: "Problem",
        body: "The spec shipped outside Command Center.",
      },
    ],
    requirements: [
      {
        ref: "gates",
        statement: "An import never satisfies a human gate.",
        priority: "must",
        risk: "high",
        criteria: [
          {
            text: "Agent sign-off on an amendment is refused.",
            validationStrategy: { kinds: ["test_run"] },
          },
          {
            text: "The delivery gate still demands a human approval.",
            validationStrategy: { kinds: ["test_run"] },
          },
        ],
      },
    ],
    decisions: [
      {
        title: "Import basis is provenance, never proof",
        chosenApproach: "Record import-basis admissions and nothing else.",
        rejectedAlternatives: [
          {
            label: "Write approval rows at import",
            reason: "Would forge a human act.",
          },
        ],
        reason: "No gate may read an import record as satisfaction.",
        traces: ["gates"],
      },
    ],
    questions: [],
    assumptions: [],
  };
}

async function importedSpec(): Promise<{
  spec: Spec;
  revision: SpecRevision;
  requirementElementId: string;
  criterionElementIds: string[];
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
  const elementsOfKind = (kind: "requirement" | "criterion") =>
    (snapshot?.elements ?? [])
      .filter(({ version }) => version.payload.kind === kind)
      .map(({ element }) => element.id);
  const requirementElementId = elementsOfKind("requirement")[0];
  if (requirementElementId === undefined) {
    throw new Error("expected the imported requirement to exist");
  }
  return {
    spec: result.value.spec,
    revision: result.value.revision,
    requirementElementId,
    criterionElementIds: elementsOfKind("criterion"),
  };
}

beforeEach(() => {
  const fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const review = createSpecReviewRepo(fixture.db);
  const delivery = createSpecDeliveryRepo(fixture.db);
  const links = createSpecLinksRepo(fixture.db);
  const bindingRepo = createSpecExecutionBindingRepo(fixture.db);
  const specEvents = createSpecEventsRepo(fixture.db);
  const events = createSpecEventsPublisher({
    appendInTransaction: specEvents.appendInTransaction,
    publish: () => ({ delivered: true }),
  });
  let ids = 0;
  let times = 0;
  const deps = {
    attention: specEvents,
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
      return `2026-08-11T11:00:${String(times).padStart(2, "0")}.000Z`;
    },
  };
  const requestedApprovals: Harness["requestedApprovals"] = [];
  harness = {
    fixture,
    review,
    delivery,
    bindingRepo,
    requestedApprovals,
    importing: createImportService(deps),
    authoring: createAuthoringService(deps),
    reviewing: createReviewService({
      ...deps,
      attention: specEvents,
      delivery,
    }),
    gateDeps: {
      bindingPort: createSpecExecutionBindingPorts(bindingRepo).delivery,
      // Honest "nothing recorded" answers: an imported spec shipped elsewhere,
      // so this system holds no graph execution and therefore no authored
      // context outcome for any of its criteria.
      outcomePort: createAuthoredContextOutcomeService({
        findExecutionById: async () => null,
      }),
      deliveryRepo: delivery,
      reviewRepo: review,
      specsRepo: fixture.specs,
      attention: specEvents,
      newVerdictId: () => `delivery-verdict-${++ids}`,
      newAdmissionId: () => `admission-policy-${++ids}`,
      events,
      writeQueue: createWriteQueue(),
      runInImmediateTransaction: <T>(fn: () => T): T =>
        fixture.db.transaction(fn).immediate(),
      recordIntervention: () => undefined,
      async requestDeliveryApproval(input) {
        requestedApprovals.push(input);
      },
      getProjectDisplayName: () => "Imported Gates Project",
      now: () => AT,
    },
  };
});

afterEach(() => harness.fixture.close());

/**
 * The two claims the whole import feature rests on: nothing it writes lets an
 * agent conclude a review, and nothing it writes satisfies the delivery gate.
 */
describe("an imported spec keeps every human gate", () => {
  it("refuses an agent sign-off on an amendment exactly as a natively authored spec does", async () => {
    const imported = await importedSpec();
    const design = await harness.authoring.openAmendment({
      specId: imported.spec.id,
      actor: AGENT,
    });
    const amendment = await harness.authoring.returnToRequirements({
      specId: imported.spec.id,
      expectedRevisionId: design.revision.id,
      reason: "Revise the imported Requirements contract.",
      actor: AGENT,
    });
    await harness.authoring.upsertDraftElement({
      specId: imported.spec.id,
      revisionId: amendment.revision.id,
      elementId: imported.requirementElementId,
      kind: "requirement",
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "An import never satisfies any human gate, ever.",
        priority: "must",
        risk: "high",
      },
      baseElementVersion: 1,
      actor: AGENT,
    });
    await expect(
      harness.authoring.proposeRevision({
        specId: imported.spec.id,
        revisionId: amendment.revision.id,
        actor: AGENT,
      }),
    ).resolves.toMatchObject({ ok: true, absorbedSignOff: false });

    const importedRefusal = await harness.reviewing.signOffRevision({
      specId: imported.spec.id,
      revisionId: amendment.revision.id,
      approver: "the importing agent",
      actor: AGENT,
    });

    expect(importedRefusal).toEqual({
      ok: false,
      refusal: {
        code: "human_act_required",
        unmetConditions: [
          "The configured sign-off gates require a human actor.",
        ],
        rationale: HUMAN_ACT_REQUIRED_RATIONALE,
        instruction: "Ask a human to sign off the revision in Spec Studio.",
      },
    });
    expect(importedRefusal).toEqual(await nativeAgentSignOffRefusal());
    // The refusal is the whole story only if nothing was written: an agent
    // sign-off that refused but approved the revision would be worse.
    const revisions = await harness.fixture.specs.listRevisions(
      imported.spec.id,
    );
    expect(
      revisions.find(({ id }) => id === amendment.revision.id)?.state,
    ).toBe("proposed");
    expect(harness.review.findApprovalsBySpecId(imported.spec.id)).toEqual([]);
  });

  it("blocks delivery on a real execution until a human approves, with the import records present", async () => {
    const imported = await importedSpec();
    // The two records D3 forbids the delivery gate from reading, both present.
    await harness.fixture.specs.recordExternalDelivery({
      revisionId: imported.revision.id,
      externalDelivery: {
        at: "2026-01-09T12:00:00.000Z",
        actor: AGENT,
        source: { label: "kiro:.kiro/specs/legacy-gates" },
      },
    });
    expect(
      harness.review
        .findGateAdmissionsByRevision(imported.revision.id)
        .map(({ gate, basis }) => `${gate}:${basis}`)
        .sort(),
    ).toEqual(["design:import", "requirements:import"]);

    const executionId = "spec-execution-imported";
    harness.delivery.insertExecution({
      id: executionId,
      spec_id: imported.spec.id,
      revision_id: imported.revision.id,
      scope_json: JSON.stringify({
        selectedTaskIds: [],
        selectedCriterionIds: imported.criterionElementIds,
        exclusionDispositions: [],
      }),
      state: "running",
      execution_start_dial: null,
      workflow_definition_id: "workflow-definition-imported",
      workflow_definition_revision: null,
      workflow_execution_id: WORKFLOW_EXECUTION_ID,
      session_name: "imported-gates-session",
      delivered_at: null,
      abandoned_reason: null,
      cleanup_phase: null,
      linked_workflow_execution_id: null,
      cleanup_last_error: null,
      cleanup_last_error_at: null,
      created_at: AT,
      updated_at: AT,
    });
    // The typed link the direct path gates on. Every imported criterion is in
    // scope and nothing claims any of them, which is exactly the state of a
    // spec whose delivery happened outside this system.
    harness.bindingRepo.insert({
      specExecutionId: executionId,
      workflowExecutionId: WORKFLOW_EXECUTION_ID,
      binding: {
        schemaVersion: 2,
        candidateId: "candidate-imported",
        candidateHash: `sha256:${"b".repeat(64)}`,
        pinnedRevisionId: imported.revision.id,
        dispositions: imported.criterionElementIds.map(
          (criterionElementId) => ({
            criterionElementId,
            disposition: "in_scope",
            deliveredByExecutionId: null,
          }),
        ),
        claims: [],
      },
      createdAt: AT,
    });

    const blocked = await createDeliveryGate(harness.gateDeps).evaluate({
      workflowExecutionId: WORKFLOW_EXECUTION_ID,
      preparedSha: "candidate-sha",
      expectedTargetSha: "target-sha",
      projectPath: PROJECT_PATH,
    });

    expect(blocked).toMatchObject({
      status: "refused",
      refusalCode: "approval_required",
      unmet: expect.arrayContaining([
        expect.objectContaining({
          outcome: "approval_required",
          reason: "The delivery gate requires human approval.",
        }),
        expect.objectContaining({ outcome: "missing_claimant" }),
        expect.objectContaining({ outcome: "integration_failed" }),
      ]),
    });
    expect(harness.requestedApprovals).toEqual([
      {
        specId: imported.spec.id,
        revisionId: imported.revision.id,
        workflowExecutionId: WORKFLOW_EXECUTION_ID,
      },
    ]);

    // Only the human act clears it — and it clears it while the same import
    // admissions and external-delivery record sit untouched beside it.
    await expect(
      harness.reviewing.grantGateApproval({
        specId: imported.spec.id,
        revisionId: imported.revision.id,
        executionId,
        gate: "delivery",
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: true });

    const approved = await createDeliveryGate(harness.gateDeps).evaluate({
      workflowExecutionId: WORKFLOW_EXECUTION_ID,
      preparedSha: "candidate-sha",
      expectedTargetSha: "target-sha",
      projectPath: PROJECT_PATH,
    });

    // The human approval is what moved the gate off the approval refusal. What
    // it does NOT do is deliver the criteria: no authored context claims them
    // and no graph execution integrated them, which is the honest state of a
    // spec whose delivery happened somewhere else. The execution-keyed row is
    // the integration check the direct gate reports alongside the criteria.
    expect(approved).toMatchObject({ status: "refused" });
    expect(approved).not.toMatchObject({ refusalCode: "approval_required" });
    expect(
      approved.status === "refused"
        ? approved.unmet.map(({ criterionId }) => criterionId).sort()
        : [],
    ).toEqual([...imported.criterionElementIds, executionId].sort());
    expect(harness.requestedApprovals).toHaveLength(1);
    expect(
      (await harness.fixture.specs.findRevision(imported.revision.id))
        ?.externalDelivery,
    ).not.toBeNull();
  });
});

/**
 * The same act on a spec this system authored end to end. Its refusal is the
 * yardstick: an imported spec that refused differently would be a spec whose
 * gates are described by different rules.
 */
async function nativeAgentSignOffRefusal() {
  const created = await harness.authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug: "natively-authored-gates",
    name: "Natively Authored Gates",
    gatePolicy: { preset: "contract-bearing" },
    initialElement: {
      elementId: "native-requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "A native spec refuses an agent sign-off.",
        priority: "must",
        risk: "high",
      },
    },
    actor: AGENT,
  });
  await harness.authoring.upsertDraftElement({
    specId: created.spec.id,
    revisionId: created.draft.id,
    elementId: "native-criterion-1",
    kind: "criterion",
    parentElementId: "native-requirement-1",
    position: 1,
    payload: {
      kind: "criterion",
      text: "The refusal names the human actor the gates require.",
      validationStrategy: { kinds: ["test_run"] },
    },
    baseElementVersion: null,
    actor: AGENT,
  });
  await harness.authoring.proposeRevision({
    specId: created.spec.id,
    revisionId: created.draft.id,
    actor: AGENT,
  });
  return harness.reviewing.signOffRevision({
    specId: created.spec.id,
    revisionId: created.draft.id,
    approver: "the authoring agent",
    actor: AGENT,
  });
}
