import { describe, expect, it } from "vitest";
import {
  MACHINE_VALIDATION_EVIDENCE_KINDS,
  actorProvenanceSchema,
  evidenceEvaluatedStateSchema,
  evidenceKindSchema,
  isMachineValidationEvidenceKind,
  refusalCodeSchema,
  refusalSchema,
  specElementPayloadSchema,
  specAuthoringStageSchema,
  specEventTypeSchema,
  specGatePolicySchema,
  specRevisionRowSchema,
  specRevisionSchema,
  validationStrategySchema,
} from "./schemas";

const validPayloads = {
  section: {
    kind: "section",
    role: "intent_problem",
    title: "Problem",
    body: "The current workflow relies on prompt etiquette.",
  },
  requirement: {
    kind: "requirement",
    statement: "The server refuses gated transitions.",
    priority: "must",
    risk: "high",
  },
  criterion: {
    kind: "criterion",
    text: "A request without approval receives gate_blocked.",
    validationStrategy: {
      kinds: ["test_run", "validator_verdict"],
      note: "Exercise the route and CLI surfaces.",
    },
  },
  decision: {
    kind: "decision",
    title: "Store immutable revision snapshots",
    chosenApproach: "Copy the full element row set into each revision.",
    rejectedAlternatives: [
      {
        label: "Mutable current rows",
        reason: "They cannot preserve approved history.",
      },
    ],
    reason: "Stable snapshots make review and verification deterministic.",
    tracedRequirementElementIds: ["requirement-1"],
  },
  task: {
    kind: "task",
    title: "Enforce the delivery gate",
    instructions: "Evaluate every selected criterion before merge.",
    tracedRequirementElementIds: ["requirement-1"],
    tracedDecisionElementIds: ["decision-1"],
    coveredCriterionElementIds: ["criterion-1", "criterion-2"],
    dependsOnTaskElementIds: ["task-1"],
    laneGroup: "persistence",
    touchedPaths: ["src/lib/specs", "src/lib/state-store/specs-repo.ts"],
  },
} as const;

describe("spec element payload schemas", () => {
  it.each(Object.entries(validPayloads))(
    "parses a valid %s payload",
    (_kind, payload) => {
      expect(specElementPayloadSchema.parse(payload)).toEqual(payload);
    },
  );

  it.each([
    ["section", { ...validPayloads.section, role: "implementation" }],
    ["requirement", { ...validPayloads.requirement, priority: "urgent" }],
    [
      "criterion",
      {
        ...validPayloads.criterion,
        validationStrategy: { kinds: ["benchmark"] },
      },
    ],
    [
      "decision",
      { ...validPayloads.decision, rejectedAlternatives: ["mutable rows"] },
    ],
    [
      "decision",
      { ...validPayloads.decision, tracedRequirementElementIds: undefined },
    ],
    [
      "task",
      { ...validPayloads.task, coveredCriterionElementIds: "criterion-1" },
    ],
    ["task", { ...validPayloads.task, tracedDecisionElementIds: undefined }],
    ["task", { ...validPayloads.task, touchedPaths: ["/src/lib/specs"] }],
    ["task", { ...validPayloads.task, touchedPaths: ["src/lib/specs/"] }],
    ["task", { ...validPayloads.task, touchedPaths: ["src/../specs"] }],
    ["task", { ...validPayloads.task, touchedPaths: ["src\\lib\\specs"] }],
  ])("rejects a malformed %s payload", (_kind, payload) => {
    expect(specElementPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe("spec authoring stage schema", () => {
  it.each(["requirements", "design", "plan"])(
    "accepts the %s authoring stage",
    (stage) => {
      expect(specAuthoringStageSchema.parse(stage)).toBe(stage);
    },
  );

  it("persists the stage in revision row and domain schemas", () => {
    expect(
      specRevisionRowSchema.parse({
        id: "revision-1",
        spec_id: "spec-1",
        number: 1,
        state: "draft",
        authoring_stage: "design",
        based_on_revision_id: null,
        content_hash: null,
        proposed_at: null,
        approved_at: null,
        created_at: "2026-07-22T12:00:00.000Z",
      }).authoring_stage,
    ).toBe("design");
    expect(
      specRevisionSchema.parse({
        id: "revision-1",
        specId: "spec-1",
        number: 1,
        state: "draft",
        authoringStage: "design",
        basedOnRevisionId: null,
        contentHash: null,
        proposedAt: null,
        approvedAt: null,
        createdAt: "2026-07-22T12:00:00.000Z",
      }).authoringStage,
    ).toBe("design");
  });
});

describe("spec gate policy schema", () => {
  it("parses a preset with sparse per-gate overrides", () => {
    const policy = {
      preset: "exploratory",
      overrides: {
        requirements: "gate",
        delivery: "notify",
      },
    } as const;

    expect(specGatePolicySchema.parse(policy)).toEqual(policy);
  });

  it("rejects an unknown gate override", () => {
    expect(
      specGatePolicySchema.safeParse({
        preset: "contract-bearing",
        overrides: { deployment: "gate" },
      }).success,
    ).toBe(false);
  });
});

describe("shared spec contracts", () => {
  it("accepts exactly the machine-producible evidence kinds", () => {
    expect(evidenceKindSchema.options).toEqual([
      "commit",
      "test_run",
      "validator_verdict",
    ]);
  });

  it.each(["diff", "screenshot", "human_signoff"])(
    "rejects the dropped %s evidence kind",
    (kind) => {
      expect(evidenceKindSchema.safeParse(kind).success).toBe(false);
    },
  );

  it("requires at least one machine-provable kind in a validation strategy", () => {
    for (const kinds of [[], ["commit"]]) {
      const parsed = validationStrategySchema.safeParse({ kinds });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toContain(
          "machine-provable evidence kind",
        );
      }
    }
    expect(
      validationStrategySchema.safeParse({
        kinds: ["commit", "validator_verdict"],
      }).success,
    ).toBe(true);
  });

  it("splits kinds into machine-validation kinds and commit", () => {
    expect(MACHINE_VALIDATION_EVIDENCE_KINDS).toEqual([
      "test_run",
      "validator_verdict",
    ]);
    expect(isMachineValidationEvidenceKind("test_run")).toBe(true);
    expect(isMachineValidationEvidenceKind("validator_verdict")).toBe(true);
    expect(isMachineValidationEvidenceKind("commit")).toBe(false);
  });

  it("keeps the retained-historical surfaceId readable in evaluated state", () => {
    const state = {
      commitSha: "abc123",
      relevantPaths: ["src/lib/specs/schemas.ts"],
      relevantTreeHash: "tree123",
      surfaceId: "spec-studio/review",
    };
    expect(evidenceEvaluatedStateSchema.parse(state)).toEqual(state);
  });

  it.each([
    { kind: "agent", conversationId: "conversation-1", backend: "codex" },
    { kind: "human" },
  ])("parses actor provenance %#", (actor) => {
    expect(actorProvenanceSchema.parse(actor)).toEqual(actor);
  });

  it("parses every refusal code through the shared refusal shape", () => {
    for (const code of refusalCodeSchema.options) {
      const refusal = {
        code,
        unmetConditions: ["A required transition predicate is not satisfied."],
        findings: [{ code: "example" }],
        instruction: "Resolve the named condition and retry.",
      };
      expect(refusalSchema.parse(refusal)).toEqual(refusal);
    }
  });

  it("carries a refusal code for a write that would leave a reference dangling", () => {
    expect(refusalCodeSchema.safeParse("dangling_reference").success).toBe(
      true,
    );
  });

  it("carries a refusal code for an element id the spec already owns historically", () => {
    expect(refusalCodeSchema.safeParse("historical_element_id").success).toBe(
      true,
    );
  });

  it.each([
    "spec-changed",
    "spec-revision-changed",
    "spec-approval-changed",
    "spec-execution-changed",
    "spec-evidence-changed",
    "spec-attention-changed",
    "spec-review-commented",
    "spec-review-changes-requested",
    "spec-review-item-approved",
    "spec-review-revision-signed-off",
  ])("registers durable event type %s", (eventType) => {
    expect(specEventTypeSchema.safeParse(eventType).success).toBe(true);
  });
});
