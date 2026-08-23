import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { AuthoredContextOutcome } from "@/lib/workflow-graph/authored-context-outcome";
import type { LinkedSpecExecutionBindingV2 } from "./execution-binding";
import type { SpecExecutionBindingPort } from "./execution-binding-service";
import type {
  Spec,
  SpecExecutionRow,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "./schemas";
import { createDeliveryGate, type DeliveryGateDeps } from "./delivery-gate-v2";

const NOW = "2026-08-15T12:00:00.000Z";
const PROJECT_PATH = "/repo/delivery-gate-v2";
const SPEC_ID = "spec-delivery-v2";
const REVISION_ID = "revision-delivery-v2";
const SPEC_EXECUTION_ID = "spec-execution-current";
const WORKFLOW_EXECUTION_ID = "workflow-execution-current";
const CANDIDATE_ID = "candidate-current";
const CANDIDATE_HASH = `sha256:${"a".repeat(64)}`;
const CRITERION_ID = "criterion-current";

type GraphFinalCandidateOutcome =
  | { status: "pending"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "satisfied"; reason: "integration_ready" };

interface GraphDeliveryOutcomePort {
  getAuthoredContextOutcome(
    executionId: string,
    authoredContextId: string,
  ): Promise<AuthoredContextOutcome>;
  getIntegrationReadyFinalCandidate(
    executionId: string,
  ): Promise<GraphFinalCandidateOutcome>;
}

interface DeliveryVerdictFixture {
  id: string;
  specExecutionId: string;
  workflowExecutionId: string;
  candidateId: string;
  candidateHash: string;
  criterionElementId: string;
  satisfyingContextId: string;
  recordedAt: string;
}

interface DeliveryVerdictRepoFixture {
  saveDeliveryVerdict(verdict: DeliveryVerdictFixture): void;
  findDeliveryVerdictsByWorkflowExecutionId(
    workflowExecutionId: string,
  ): DeliveryVerdictFixture[];
}

type DirectDeliveryGateDeps = DeliveryGateDeps & {
  bindingPort: SpecExecutionBindingPort;
  outcomePort: GraphDeliveryOutcomePort;
  deliveryRepo: SpecDeliveryRepo & DeliveryVerdictRepoFixture;
  newVerdictId(): string;
};

interface GateFixture {
  deps: DirectDeliveryGateDeps;
  binding: LinkedSpecExecutionBindingV2;
  outcomes: Map<string, AuthoredContextOutcome>;
  verdicts: DeliveryVerdictFixture[];
  getAuthoredContextOutcome: ReturnType<typeof vi.fn>;
  getIntegrationReadyFinalCandidate: ReturnType<typeof vi.fn>;
  policyAdmitted: ReturnType<typeof vi.fn>;
  addCriterion(input: {
    criterionId: string;
    contextId: string;
    outcome: AuthoredContextOutcome;
  }): void;
  setClaims(contextIds: string[]): void;
  setDeliveryDial(dial: "gate" | "notify"): void;
  setDeliveryApproval(granted: boolean): void;
  setFinalCandidate(outcome: GraphFinalCandidateOutcome): void;
  setWaiver(waiver: SpecWaiverRow | null): void;
}

function pending(reason: "context_unsettled" = "context_unsettled") {
  return {
    status: "pending" as const,
    reason,
    executionLocation: "archived" as const,
  };
}

function skipped() {
  return {
    status: "skipped" as const,
    reason: "route_skipped" as const,
    executionLocation: "archived" as const,
  };
}

function failed(
  reason: Extract<AuthoredContextOutcome, { status: "failed" }>["reason"],
) {
  return {
    status: "failed" as const,
    reason,
    executionLocation: "archived" as const,
  };
}

function satisfied(
  reason: Extract<
    AuthoredContextOutcome,
    { status: "satisfied" }
  >["reason"] = "write_result_integrated",
) {
  return {
    status: "satisfied" as const,
    reason,
    executionLocation: "archived" as const,
  };
}

function gateInput() {
  return {
    workflowExecutionId: WORKFLOW_EXECUTION_ID,
    preparedSha: "prepared-current",
    expectedTargetSha: "target-current",
    projectPath: PROJECT_PATH,
  };
}

function createFixture(): GateFixture {
  let gatePolicy: Spec["gatePolicy"] = {
    preset: "contract-bearing",
    overrides: { delivery: "notify" },
  };
  let deliveryApprovalGranted = false;
  let finalCandidate: GraphFinalCandidateOutcome = {
    status: "satisfied",
    reason: "integration_ready",
  };
  let waiver: SpecWaiverRow | null = null;
  let sequence = 0;
  const verdicts: DeliveryVerdictFixture[] = [];
  const admissions: Array<{
    gate: string;
    execution_id: string | null;
  }> = [];
  const outcomes = new Map<string, AuthoredContextOutcome>([
    ["claimant-primary", satisfied()],
  ]);
  const binding: LinkedSpecExecutionBindingV2 = {
    specExecutionId: SPEC_EXECUTION_ID,
    workflowExecutionId: WORKFLOW_EXECUTION_ID,
    binding: {
      schemaVersion: 2,
      candidateId: CANDIDATE_ID,
      candidateHash: CANDIDATE_HASH,
      pinnedRevisionId: REVISION_ID,
      dispositions: [
        {
          criterionElementId: CRITERION_ID,
          disposition: "in_scope",
          deliveredByExecutionId: null,
        },
      ],
      claims: [
        {
          contextId: "claimant-primary",
          criterionElementIds: [CRITERION_ID],
        },
      ],
    },
    createdAt: NOW,
  };
  const execution: SpecExecutionRow = {
    id: SPEC_EXECUTION_ID,
    spec_id: SPEC_ID,
    revision_id: REVISION_ID,
    scope_json: JSON.stringify({
      selectedTaskIds: [],
      selectedCriterionIds: [CRITERION_ID],
      exclusionDispositions: [],
    }),
    state: "running",
    execution_start_dial: "gate",
    workflow_definition_id: null,
    workflow_definition_revision: null,
    workflow_seed_source_json: null,
    workflow_execution_binding_json: null,
    workflow_execution_id: WORKFLOW_EXECUTION_ID,
    session_name: "delivery-v2",
    delivered_at: null,
    abandoned_reason: null,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
  const spec: Spec = {
    id: SPEC_ID,
    projectPath: PROJECT_PATH,
    slug: "delivery-v2",
    name: "Delivery v2",
    gatePolicy,
    abandonedAt: null,
    abandonedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const snapshot = {
    revision: {
      id: REVISION_ID,
      specId: SPEC_ID,
      number: 1,
      state: "approved",
      authoringStage: "design",
      basedOnRevisionId: null,
      contentHash: "revision-hash",
      proposedAt: NOW,
      approvedAt: NOW,
      externalDelivery: null,
      createdAt: NOW,
    },
    elements: [
      {
        element: {
          id: CRITERION_ID,
          specId: SPEC_ID,
          kind: "criterion",
          number: 1,
          parentElementId: null,
          createdAt: NOW,
        },
        version: {
          revisionId: REVISION_ID,
          elementId: CRITERION_ID,
          position: 0,
          payload: {
            kind: "criterion",
            text: "The current graph outcome delivers the criterion.",
            validationStrategy: { kinds: ["test_run"] },
          },
          payloadHash: "criterion-hash",
          elementVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ],
  } as SpecRevisionSnapshot;

  const getAuthoredContextOutcome = vi.fn(
    async (executionId: string, contextId: string) => {
      if (executionId !== WORKFLOW_EXECUTION_ID) {
        return failed("execution_not_found");
      }
      return outcomes.get(contextId) ?? failed("authored_context_not_found");
    },
  );
  const getIntegrationReadyFinalCandidate = vi.fn(async () => finalCandidate);
  const policyAdmitted = vi.fn();
  const deliveryRepo = {
    findExecutionByWorkflowExecutionId(workflowExecutionId: string) {
      return workflowExecutionId === WORKFLOW_EXECUTION_ID ? execution : null;
    },
    findExecutionById(specExecutionId: string) {
      return specExecutionId === SPEC_EXECUTION_ID ? execution : null;
    },
    findCriterionDispositionsByExecution() {
      return [
        {
          execution_id: SPEC_EXECUTION_ID,
          criterion_element_id: CRITERION_ID,
          disposition: "in_scope" as const,
          waiver_id: null,
          delivered_by_execution_id: null,
          created_at: NOW,
          updated_at: NOW,
        },
      ];
    },
    findProofVerdictsByCriterionRevision() {
      return [];
    },
    findWaiverForCriterionRevision() {
      return waiver;
    },
    findWaiverById() {
      return waiver;
    },
    saveDeliveryVerdict(verdict: DeliveryVerdictFixture) {
      if (
        verdicts.some(
          (existing) =>
            existing.workflowExecutionId === verdict.workflowExecutionId &&
            existing.candidateId === verdict.candidateId &&
            existing.candidateHash === verdict.candidateHash &&
            existing.criterionElementId === verdict.criterionElementId &&
            existing.satisfyingContextId === verdict.satisfyingContextId,
        )
      ) {
        return;
      }
      verdicts.push(verdict);
    },
    findDeliveryVerdictsByWorkflowExecutionId(workflowExecutionId: string) {
      return verdicts.filter(
        (verdict) => verdict.workflowExecutionId === workflowExecutionId,
      );
    },
  } as unknown as SpecDeliveryRepo & DeliveryVerdictRepoFixture;
  const reviewRepo = {
    hasValidHumanGateApproval() {
      return deliveryApprovalGranted;
    },
    findGateAdmissionsByRevision() {
      return admissions;
    },
    insertGateAdmission(admission: {
      gate: string;
      execution_id: string | null;
    }) {
      admissions.push(admission);
    },
  } as unknown as DirectDeliveryGateDeps["reviewRepo"];
  const specsRepo = {
    async findById(id: string) {
      return id === SPEC_ID ? { ...spec, gatePolicy } : null;
    },
    async getRevisionSnapshot(id: string) {
      return id === REVISION_ID ? snapshot : null;
    },
  } as Pick<SpecsRepo, "findById" | "getRevisionSnapshot">;
  const bindingPort: SpecExecutionBindingPort = {
    resolveByWorkflowExecutionId(workflowExecutionId, expected) {
      if (workflowExecutionId !== WORKFLOW_EXECUTION_ID) return null;
      if (
        expected?.specExecutionId !== undefined &&
        expected.specExecutionId !== binding.specExecutionId
      ) {
        throw new Error("spec execution mismatch");
      }
      if (
        expected?.candidateId !== undefined &&
        expected.candidateId !== binding.binding.candidateId
      ) {
        throw new Error("candidate mismatch");
      }
      return binding;
    },
  };
  const deps = {
    bindingPort,
    outcomePort: {
      getAuthoredContextOutcome,
      getIntegrationReadyFinalCandidate,
    },
    deliveryRepo,
    reviewRepo: reviewRepo as Pick<
      SpecReviewRepo,
      | "hasValidHumanGateApproval"
      | "insertGateAdmission"
      | "findGateAdmissionsByRevision"
    >,
    specsRepo,
    newVerdictId: () => `delivery-verdict-${++sequence}`,
    newAdmissionId: () => `delivery-admission-${++sequence}`,
    events: {
      appendInTransaction(input: { sseEvent: unknown }) {
        return { durableEvent: { id: ++sequence }, sseEvent: input.sseEvent };
      },
      appendDurableInTransaction() {
        return { id: ++sequence };
      },
      publishAfterCommit: vi.fn(),
    },
    writeQueue: {
      async withWriteQueue(_label: string, fn: () => Promise<unknown>) {
        return fn();
      },
    },
    runInImmediateTransaction<T>(fn: () => T): T {
      return fn();
    },
    policyNotifier: { policyAdmitted },
    recordIntervention: vi.fn(),
    requestDeliveryApproval: vi.fn(async () => undefined),
    getProjectDisplayName: () => "Delivery v2 project",
    now: () => NOW,
  } as unknown as DirectDeliveryGateDeps;

  return {
    deps,
    binding,
    outcomes,
    verdicts,
    getAuthoredContextOutcome,
    getIntegrationReadyFinalCandidate,
    policyAdmitted,
    addCriterion({ criterionId, contextId, outcome }) {
      binding.binding.dispositions.push({
        criterionElementId: criterionId,
        disposition: "in_scope",
        deliveredByExecutionId: null,
      });
      binding.binding.claims.push({
        contextId,
        criterionElementIds: [criterionId],
      });
      const source = snapshot.elements[0]!;
      snapshot.elements.push({
        element: {
          ...source.element,
          id: criterionId,
          number: 2,
        },
        version: {
          ...source.version,
          elementId: criterionId,
          position: 1,
          payloadHash: `${criterionId}-hash`,
        },
      });
      outcomes.set(contextId, outcome);
    },
    setClaims(contextIds) {
      binding.binding.claims = contextIds.map((contextId) => ({
        contextId,
        criterionElementIds: [CRITERION_ID],
      }));
    },
    setDeliveryDial(dial) {
      gatePolicy = {
        preset: "contract-bearing",
        overrides: { delivery: dial },
      };
    },
    setDeliveryApproval(granted) {
      deliveryApprovalGranted = granted;
    },
    setFinalCandidate(outcome) {
      finalCandidate = outcome;
    },
    setWaiver(nextWaiver) {
      waiver = nextWaiver;
    },
  };
}

describe("current-execution authored-outcome delivery gate", () => {
  let fixture: GateFixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  it.each([
    ["pending", pending()],
    ["skipped", skipped()],
    ["failed", failed("execution_halted")],
  ] as const)(
    "refuses a criterion whose only claimant is %s",
    async (_, outcome) => {
      fixture.outcomes.set("claimant-primary", outcome);

      const result = await createDeliveryGate(fixture.deps).evaluate(
        gateInput(),
      );

      expect(result).toMatchObject({
        status: "refused",
        unmet: [expect.objectContaining({ criterionId: CRITERION_ID })],
      });
      expect(fixture.verdicts).toEqual([]);
    },
  );

  it("directs a criterion with no authored claimant to repair its binding", async () => {
    fixture.setClaims([]);

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "refused",
      unmet: [
        expect.objectContaining({
          reason: expect.stringContaining("no authored claimant"),
        }),
      ],
      instruction: expect.stringMatching(
        /graph execution or delivery binding/i,
      ),
    });
    expect(result.status === "refused" ? result.instruction : "").not.toMatch(
      /named claimant|recertified/i,
    );
  });

  it("records a current-attempt verdict for a satisfied claimant", async () => {
    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "pass",
      satisfied: [
        expect.objectContaining({
          criterionId: CRITERION_ID,
          outcome: "satisfied",
        }),
      ],
    });
    expect(fixture.verdicts).toEqual([
      expect.objectContaining({
        specExecutionId: SPEC_EXECUTION_ID,
        workflowExecutionId: WORKFLOW_EXECUTION_ID,
        candidateId: CANDIDATE_ID,
        candidateHash: CANDIDATE_HASH,
        criterionElementId: CRITERION_ID,
        satisfyingContextId: "claimant-primary",
      }),
    ]);
  });

  it("names a concluded-null claimant and gives an archived recovery that can change proof", async () => {
    fixture.outcomes.set("claimant-primary", {
      status: "failed",
      reason: "validation_gate_failed",
      executionLocation: "archived",
      validation: {
        status: "owed",
        reason: "round_concluded_without_pass",
        round: { seq: 1, phase: "concluded", outcome: null },
      },
    });

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "refused",
      unmet: [
        expect.objectContaining({
          criterionId: CRITERION_ID,
          outcome: "failed",
          reason: expect.stringContaining(
            "claimant-primary failed validation_gate_failed (validation round 1 is concluded with outcome null)",
          ),
        }),
      ],
      instruction: expect.stringMatching(/Studio waiver.*replacement/i),
    });
    expect(result.status === "refused" ? result.instruction : "").not.toContain(
      "prepared candidate",
    );
  });

  it("directs an active claimant back through graph recertification", async () => {
    fixture.outcomes.set("claimant-primary", {
      status: "failed",
      reason: "validation_gate_failed",
      executionLocation: "active",
      validation: {
        status: "owed",
        reason: "round_open",
        round: { seq: 2, phase: "specialists", outcome: null },
      },
    });

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "refused",
      unmet: [
        expect.objectContaining({
          reason: expect.stringContaining(
            "validation round 2 is open in phase specialists with outcome null",
          ),
        }),
      ],
      instruction: expect.stringMatching(/active graph.*recertified/i),
    });
    expect(result.status === "refused" ? result.instruction : "").not.toContain(
      "replacement delivery execution",
    );
  });

  it("records stable satisfied verdicts before refusing another criterion, then completes idempotently after correction", async () => {
    const secondaryCriterionId = "criterion-secondary";
    const secondaryContextId = "claimant-secondary";
    fixture.addCriterion({
      criterionId: secondaryCriterionId,
      contextId: secondaryContextId,
      outcome: {
        status: "failed",
        reason: "validation_gate_failed",
        executionLocation: "archived",
        validation: {
          status: "owed",
          reason: "round_concluded_without_pass",
          round: { seq: 1, phase: "concluded", outcome: null },
        },
      },
    });

    const refused = await createDeliveryGate(fixture.deps).evaluate(
      gateInput(),
    );

    expect(refused).toMatchObject({
      status: "refused",
      unmet: [expect.objectContaining({ criterionId: secondaryCriterionId })],
    });
    expect(fixture.verdicts).toEqual([
      expect.objectContaining({
        criterionElementId: CRITERION_ID,
        satisfyingContextId: "claimant-primary",
      }),
    ]);

    fixture.outcomes.set(secondaryContextId, satisfied());
    await expect(
      createDeliveryGate(fixture.deps).evaluate(gateInput()),
    ).resolves.toMatchObject({ status: "pass" });
    await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(fixture.verdicts).toEqual([
      expect.objectContaining({ criterionElementId: CRITERION_ID }),
      expect.objectContaining({ criterionElementId: secondaryCriterionId }),
    ]);
  });

  it("treats redundant claims as existential alternatives and de-duplicates repeated claimant ids", async () => {
    fixture.setClaims([
      "claimant-failed",
      "claimant-failed",
      "claimant-satisfied",
    ]);
    fixture.outcomes.set("claimant-failed", failed("validator_gate_failed"));
    fixture.outcomes.set("claimant-satisfied", satisfied());

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({ status: "pass" });
    expect(fixture.getAuthoredContextOutcome).toHaveBeenCalledTimes(2);
    expect(fixture.verdicts).toEqual([
      expect.objectContaining({
        satisfyingContextId: "claimant-satisfied",
      }),
    ]);
  });

  it("does not reuse verdicts from another execution, candidate, criterion, or unclaimed sibling", async () => {
    fixture.outcomes.set("claimant-primary", pending());
    fixture.verdicts.push(
      {
        id: "verdict-other-execution",
        specExecutionId: "spec-execution-prior",
        workflowExecutionId: "workflow-execution-prior",
        candidateId: CANDIDATE_ID,
        candidateHash: CANDIDATE_HASH,
        criterionElementId: CRITERION_ID,
        satisfyingContextId: "claimant-primary",
        recordedAt: NOW,
      },
      {
        id: "verdict-other-candidate",
        specExecutionId: SPEC_EXECUTION_ID,
        workflowExecutionId: WORKFLOW_EXECUTION_ID,
        candidateId: "candidate-prior",
        candidateHash: `sha256:${"b".repeat(64)}`,
        criterionElementId: CRITERION_ID,
        satisfyingContextId: "claimant-primary",
        recordedAt: NOW,
      },
      {
        id: "verdict-other-criterion",
        specExecutionId: SPEC_EXECUTION_ID,
        workflowExecutionId: WORKFLOW_EXECUTION_ID,
        candidateId: CANDIDATE_ID,
        candidateHash: CANDIDATE_HASH,
        criterionElementId: "criterion-sibling",
        satisfyingContextId: "claimant-primary",
        recordedAt: NOW,
      },
      {
        id: "verdict-unclaimed-sibling",
        specExecutionId: SPEC_EXECUTION_ID,
        workflowExecutionId: WORKFLOW_EXECUTION_ID,
        candidateId: CANDIDATE_ID,
        candidateHash: CANDIDATE_HASH,
        criterionElementId: CRITERION_ID,
        satisfyingContextId: "unclaimed-sibling",
        recordedAt: NOW,
      },
    );

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({ status: "refused" });
  });

  it.each([
    ["generated child", "generated_context_not_authored"],
    ["loop template", "loop_body_template_not_authored_source"],
    ["loop pass", "loop_instance_not_authored_source"],
  ] as const)(
    "refuses a claimed %s id through the graph outcome port",
    async (_, reason) => {
      fixture.outcomes.set("claimant-primary", failed(reason));

      const result = await createDeliveryGate(fixture.deps).evaluate(
        gateInput(),
      );

      expect(result).toMatchObject({ status: "refused" });
    },
  );

  it("refuses a satisfied claimant when the graph has no integration-ready final candidate", async () => {
    fixture.setFinalCandidate({
      status: "failed",
      reason: "final integration validation failed",
    });

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "refused",
      unmet: expect.arrayContaining([
        expect.objectContaining({ outcome: "integration_failed" }),
      ]),
    });
    expect(fixture.verdicts).toEqual([]);
  });

  it.each([
    ["read-only", satisfied("read_only_completed")],
    ["no-change", satisfied("write_result_integrated")],
    ["validator-disabled", satisfied("read_only_completed")],
  ] as const)(
    "accepts a graph-satisfied %s claimant without modality rules",
    async (_, outcome) => {
      fixture.outcomes.set("claimant-primary", outcome);

      const result = await createDeliveryGate(fixture.deps).evaluate(
        gateInput(),
      );

      expect(result).toMatchObject({ status: "pass" });
    },
  );

  it.each([
    ["script", "script_gate_failed"],
    ["validator cohort", "validator_gate_failed"],
    ["approval", "approval_gate_failed"],
  ] as const)(
    "refuses a claimant whose graph-configured %s gate failed",
    async (_, reason) => {
      fixture.outcomes.set("claimant-primary", failed(reason));

      const result = await createDeliveryGate(fixture.deps).evaluate(
        gateInput(),
      );

      expect(result).toMatchObject({ status: "refused" });
    },
  );

  it("credits dynamic and loop work only through its stable authored spawner", async () => {
    fixture.setClaims(["stable-spawner"]);
    fixture.outcomes.set("stable-spawner", satisfied("read_only_completed"));
    fixture.outcomes.set(
      "generated-child",
      failed("generated_context_not_authored"),
    );
    fixture.outcomes.set(
      "refine__p1__worker",
      failed("loop_instance_not_authored_source"),
    );

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({ status: "pass" });
    expect(fixture.getAuthoredContextOutcome).toHaveBeenCalledTimes(1);
    expect(fixture.getAuthoredContextOutcome).toHaveBeenCalledWith(
      WORKFLOW_EXECUTION_ID,
      "stable-spawner",
    );
    // The durable record has to key to the authored spawner too: crediting the
    // dynamic descendant here is what would force a later reader to walk
    // lineage back to a stable source.
    expect(fixture.verdicts).toEqual([
      expect.objectContaining({
        criterionElementId: CRITERION_ID,
        satisfyingContextId: "stable-spawner",
      }),
    ]);
  });

  it("accepts an explicit current-revision Studio waiver when no claimant satisfies", async () => {
    fixture.outcomes.set("claimant-primary", failed("validator_gate_failed"));
    fixture.setWaiver({
      id: "waiver-current",
      spec_id: SPEC_ID,
      criterion_element_id: CRITERION_ID,
      revision_id: REVISION_ID,
      reason: "The unavailable environment was reviewed by Alex.",
      waived_at: NOW,
      stale: 0,
    });

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "pass",
      satisfied: [
        expect.objectContaining({
          criterionId: CRITERION_ID,
          outcome: "waived",
        }),
      ],
    });
    expect(fixture.verdicts).toEqual([]);
  });

  it("keeps the blocking delivery approval dial", async () => {
    fixture.setDeliveryDial("gate");
    fixture.setDeliveryApproval(false);

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "refused",
      refusalCode: "approval_required",
    });
  });

  it("reports a Notify admission after current outcomes and final integration pass", async () => {
    fixture.setDeliveryDial("notify");
    fixture.setDeliveryApproval(false);

    const result = await createDeliveryGate(fixture.deps).evaluate(gateInput());

    expect(result).toMatchObject({ status: "pass" });
    expect(fixture.policyAdmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: "delivery",
        basis: "notify_policy",
        executionId: SPEC_EXECUTION_ID,
      }),
    );
  });
});
