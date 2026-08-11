import { describe, expect, it } from "vitest";
import { laneIdViolation } from "@/lib/workflow-graph/lane-identity";
import {
  IMPORTED_VALIDATION_STRATEGY_NOTE,
  MACHINE_VALIDATION_EVIDENCE_KINDS,
  executionLaneSchema,
  actorProvenanceSchema,
  evidenceEvaluatedStateSchema,
  evidenceKindSchema,
  externalDeliverySchema,
  importBundleSchema,
  isMachineValidationEvidenceKind,
  refusalCodeSchema,
  resolveImportedValidationStrategy,
  specGateAdmissionBasisSchema,
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
    executionLane: "persistence-lane",
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
    ["task", { ...validPayloads.task, executionLane: "src/lib/specs" }],
    ["task", { ...validPayloads.task, executionLane: "-lead" }],
    ["task", { ...validPayloads.task, executionLane: "" }],
  ])("rejects a malformed %s payload", (_kind, payload) => {
    expect(specElementPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts a task payload that omits executionLane", () => {
    const { executionLane: _omitted, ...withoutLane } = validPayloads.task;
    expect(specElementPayloadSchema.parse(withoutLane)).toEqual(withoutLane);
  });
});

/**
 * R12: an executionLane becomes a compiled context's placement lane, and from
 * there a git branch name and a worktree path segment. Its grammar is mirrored
 * from `laneIdViolation` rather than imported (this module is deliberately
 * dependency-free apart from Zod), so the mirror is pinned here: a name the
 * lane machinery would refuse must never reach a compiled placement.
 */
describe("execution lane schema", () => {
  it.each([
    "compiler",
    "lane-1",
    "Lane_1",
    "a.b",
    "session",
    "__session__",
    "x",
    "",
    "src/lib",
    "lane group",
    ".hidden",
    "-lead",
    "trail-",
    "trail.",
    "a..b",
    "lane.lock",
    "lane\\name",
    "läne",
  ])("agrees with the lane-id grammar for %j", (candidate) => {
    expect(executionLaneSchema.safeParse(candidate).success).toBe(
      candidate.length > 0 && laneIdViolation(candidate) === null,
    );
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
        external_delivery_json: null,
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
        externalDelivery: null,
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

describe("import provenance contracts", () => {
  it("admits an import basis alongside the human and policy bases", () => {
    expect(specGateAdmissionBasisSchema.options).toEqual([
      "human_approval",
      "notify_policy",
      "off_policy",
      "import",
    ]);
  });

  it("registers the durable spec_imported event type", () => {
    expect(specEventTypeSchema.safeParse("spec_imported").success).toBe(true);
  });

  it("carries the external-delivery record as actor-attributed source provenance", () => {
    const record = {
      at: "2026-08-10T09:00:00.000Z",
      actor: { kind: "agent", conversationId: "conversation-import" },
      source: { label: "kiro:.kiro/specs/imported-feature" },
    };

    expect(externalDeliverySchema.parse(record)).toEqual(record);
  });

  it("refuses an external-delivery record without a source label or with unknown keys", () => {
    const base = {
      at: "2026-08-10T09:00:00.000Z",
      actor: { kind: "human" },
      source: { label: "external" },
    };

    expect(
      externalDeliverySchema.safeParse({ ...base, source: { label: "" } })
        .success,
    ).toBe(false);
    expect(
      externalDeliverySchema.safeParse({ ...base, verdict: "passed" }).success,
    ).toBe(false);
  });

  it.each([
    "not-an-iso-timestamp",
    "2026-08-10",
    "10/08/2026",
    "2026-08-10 09:00:00",
    "",
  ])("refuses %j as an external-delivery timestamp", (at) => {
    // The claim's whole content is when the work shipped and who says so. A
    // free-text `at` would persist an unorderable, uncomparable date that no
    // surface could honestly render against this system's own timestamps.
    expect(
      externalDeliverySchema.safeParse({
        at,
        actor: { kind: "human" },
        source: { label: "external" },
      }).success,
    ).toBe(false);
  });
});

const maximalBundle = {
  slug: "imported-feature",
  name: "Imported feature",
  gatePolicy: { preset: "exploratory", overrides: { delivery: "notify" } },
  source: { label: "kiro:.kiro/specs/imported-feature" },
  sections: [
    {
      role: "intent_problem",
      title: "Problem",
      body: "The external spec has no native record.",
    },
    {
      role: "design_narrative",
      title: "Approach",
      body: "Translate the external document into native elements.",
    },
  ],
  requirements: [
    {
      ref: "R1",
      statement: "The importer creates a new spec.",
      priority: "must",
      risk: "high",
      criteria: [
        {
          text: "An existing slug is refused.",
          validationStrategy: {
            kinds: ["test_run"],
            note: "Covered by the refusal tests.",
          },
        },
        { text: "The imported revision is born at design." },
      ],
    },
  ],
  decisions: [
    {
      title: "Import is one-shot",
      chosenApproach: "Write the whole bundle in one transaction.",
      rejectedAlternatives: [
        { label: "Incremental import", reason: "Leaves half-imported specs." },
      ],
      reason: "A partial import cannot be reviewed honestly.",
      traces: ["R1"],
    },
  ],
  questions: [
    { text: "Which external formats ship first?", answer: "Kiro only." },
    { text: "Does import ever amend?" },
  ],
  assumptions: [
    {
      text: "The external spec was reviewed by a human.",
      disposition: "proposed",
    },
    { text: "External delivery already shipped." },
  ],
  delivered: false,
  dryRun: true,
} as const;

describe("import bundle schema", () => {
  it("parses a maximal bundle unchanged", () => {
    expect(importBundleSchema.parse(maximalBundle)).toEqual(maximalBundle);
  });

  it("defaults the gate policy to the contract-bearing preset and delivered to true", () => {
    const parsed = importBundleSchema.parse({
      slug: "minimal-import",
      name: "Minimal import",
      source: { label: "external" },
      sections: [],
      requirements: [],
      decisions: [],
      questions: [],
      assumptions: [],
    });

    expect(parsed.gatePolicy).toEqual({ preset: "contract-bearing" });
    expect(parsed.delivered).toBe(true);
    // A bundle that says nothing about rehearsing must import for real. The
    // opposite default would let a caller believe it had imported a spec that
    // was only ever previewed.
    expect(parsed.dryRun).toBe(false);
  });

  it("refuses a non-canonical slug, an empty source label, and unknown keys", () => {
    expect(
      importBundleSchema.safeParse({ ...maximalBundle, slug: "Not A Slug" })
        .success,
    ).toBe(false);
    expect(
      importBundleSchema.safeParse({ ...maximalBundle, source: { label: "" } })
        .success,
    ).toBe(false);
    expect(
      importBundleSchema.safeParse({ ...maximalBundle, extra: "surprise" })
        .success,
    ).toBe(false);
  });
});

describe("imported criterion validation strategy", () => {
  it("defaults an absent strategy to a machine-provable kind with an honest imported note", () => {
    const defaulted = resolveImportedValidationStrategy(undefined);

    expect(defaulted).toEqual({
      kinds: ["validator_verdict"],
      note: IMPORTED_VALIDATION_STRATEGY_NOTE,
    });
    expect(defaulted.kinds.some(isMachineValidationEvidenceKind)).toBe(true);
    expect(IMPORTED_VALIDATION_STRATEGY_NOTE).toBe(
      "Imported; not machine-verified.",
    );
  });

  it("passes an explicit bundle strategy through untouched", () => {
    const explicit = validationStrategySchema.parse({
      kinds: ["test_run", "commit"],
      note: "Proven by the import round-trip test.",
    });

    expect(resolveImportedValidationStrategy(explicit)).toEqual(explicit);
  });

  it("keeps an explicit strategy that omits its note noteless", () => {
    expect(
      resolveImportedValidationStrategy({ kinds: ["validator_verdict"] }),
    ).toEqual({ kinds: ["validator_verdict"] });
  });

  it("hands every caller its own default rather than one shared object", () => {
    const first = resolveImportedValidationStrategy(undefined);
    first.kinds.push("commit");

    // A shared constant would carry one caller's edit into the obligation
    // every later imported criterion is born with.
    expect(resolveImportedValidationStrategy(undefined).kinds).toEqual([
      "validator_verdict",
    ]);
  });
});
