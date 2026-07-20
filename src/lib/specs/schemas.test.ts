import { describe, expect, it } from "vitest";
import {
  actorProvenanceSchema,
  evidenceEvaluatedStateSchema,
  evidenceKindSchema,
  refusalCodeSchema,
  refusalSchema,
  specElementPayloadSchema,
  specEventTypeSchema,
  specGatePolicySchema,
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
  ])("rejects a malformed %s payload", (_kind, payload) => {
    expect(specElementPayloadSchema.safeParse(payload).success).toBe(false);
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
  it.each([
    "diff",
    "commit",
    "test_run",
    "validator_verdict",
    "screenshot",
    "human_signoff",
  ])("accepts the %s evidence kind", (kind) => {
    expect(evidenceKindSchema.safeParse(kind).success).toBe(true);
  });

  it("parses the evaluated code and surface state", () => {
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
