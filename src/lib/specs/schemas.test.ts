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
  specAssumptionCitationRowSchema,
  specAssumptionCitationSchema,
  specAssumptionCitationSnapshotSchema,
  specAssumptionRowSchema,
  specQuestionRowSchema,
  specRevisionRowSchema,
  specRevisionSchema,
  specRevisionSnapshotSchema,
  specAssumptionCitationsMutatedEventPayloadSchema,
  specAttentionEditPayloadSchema,
  specAttentionMutationReceiptSchema,
  specAttentionRecordPresentationSchema,
  specRecordAuditSnapshotSchema,
  specReviewRecordMutatedEventPayloadSchema,
  specReviewRecordOperationSchema,
  specSupersedeAssumptionPayloadSchema,
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
        citation_contract_version: 2,
        citation_version: 1,
        citation_hash: "a".repeat(64),
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
        citationContractVersion: 2,
        citationVersion: 1,
        citationHash: "a".repeat(64),
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

  it("carries an optional server-authored rationale beside the refusal", () => {
    const withRationale = {
      code: "stage_blocked" as const,
      unmetConditions: [
        "A design cannot be authored during the requirements stage.",
      ],
      rationale:
        "requirements settle before design so solution choices cannot shape the contract around themselves",
      instruction:
        "Advance the requirements stage before authoring design content.",
    };
    expect(refusalSchema.parse(withRationale)).toEqual(withRationale);

    const withoutRationale = {
      code: "stage_blocked" as const,
      unmetConditions: [
        "A design cannot be authored during the requirements stage.",
      ],
      instruction:
        "Advance the requirements stage before authoring design content.",
    };
    const parsed = refusalSchema.parse(withoutRationale);
    expect(parsed).toEqual(withoutRationale);
    expect("rationale" in parsed).toBe(false);
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

  it("carries a refusal code for an update that would move an element to another parent", () => {
    expect(refusalCodeSchema.safeParse("parent_immutable").success).toBe(true);
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

describe("attention record lifecycle schemas", () => {
  const question = {
    id: "question-1",
    spec_id: "spec-1",
    number: 1,
    element_id: null,
    text: "Which rollout owns the cutover?",
    provenance_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-1",
    }),
    record_version: 1,
    status: "open",
    answer: null,
    answered_at: null,
    withdrawn_at: null,
    created_at: "2026-08-23T10:00:00.000Z",
    updated_at: "2026-08-23T10:00:00.000Z",
  } as const;

  const assumption = {
    id: "assumption-1",
    spec_id: "spec-1",
    number: 1,
    element_id: "requirement-1",
    text: "The cutover can quiesce all writers.",
    proposed_by_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-1",
    }),
    record_version: 1,
    disposition: "proposed",
    disposed_at: null,
    withdrawn_at: null,
    supersedes_assumption_id: null,
    supersession_operation_id: null,
    supersession_request_hash: null,
    created_at: "2026-08-23T10:00:00.000Z",
    updated_at: "2026-08-23T10:00:00.000Z",
  } as const;

  it.each([
    question,
    {
      ...question,
      status: "answered",
      answer: "The release coordinator owns it.",
      answered_at: "2026-08-23T10:05:00.000Z",
    },
    {
      ...question,
      status: "withdrawn",
      withdrawn_at: "2026-08-23T10:04:00.000Z",
    },
  ])("accepts a legal question lifecycle %#", (row) => {
    expect(specQuestionRowSchema.parse(row)).toEqual(row);
  });

  it.each([
    { ...question, record_version: 0 },
    { ...question, answer: "An answer on an open question." },
    { ...question, answered_at: "2026-08-23T10:05:00.000Z" },
    { ...question, withdrawn_at: "2026-08-23T10:04:00.000Z" },
    { ...question, status: "answered", answer: "", answered_at: null },
    {
      ...question,
      status: "answered",
      answer: "Answered and withdrawn cannot coexist.",
      answered_at: "2026-08-23T10:05:00.000Z",
      withdrawn_at: "2026-08-23T10:06:00.000Z",
    },
    { ...question, status: "withdrawn", withdrawn_at: null },
  ])("rejects a contradictory question lifecycle %#", (row) => {
    expect(specQuestionRowSchema.safeParse(row).success).toBe(false);
  });

  it.each([
    assumption,
    {
      ...assumption,
      disposition: "confirmed",
      disposed_at: "2026-08-23T10:05:00.000Z",
    },
    {
      ...assumption,
      disposition: "rejected",
      disposed_at: "2026-08-23T10:05:00.000Z",
    },
    {
      ...assumption,
      disposition: "deferred",
      disposed_at: "2026-08-23T10:05:00.000Z",
    },
    {
      ...assumption,
      disposition: "withdrawn",
      withdrawn_at: "2026-08-23T10:04:00.000Z",
    },
    {
      ...assumption,
      id: "assumption-2",
      number: 2,
      supersedes_assumption_id: "assumption-1",
      supersession_operation_id: "operation-1",
      supersession_request_hash: "a".repeat(64),
    },
  ])("accepts a legal assumption lifecycle %#", (row) => {
    expect(specAssumptionRowSchema.parse(row)).toEqual(row);
  });

  it.each([
    { ...assumption, record_version: 0 },
    { ...assumption, disposed_at: "2026-08-23T10:05:00.000Z" },
    { ...assumption, withdrawn_at: "2026-08-23T10:04:00.000Z" },
    { ...assumption, disposition: "confirmed", disposed_at: null },
    {
      ...assumption,
      disposition: "confirmed",
      disposed_at: "2026-08-23T10:05:00.000Z",
      withdrawn_at: "2026-08-23T10:06:00.000Z",
    },
    { ...assumption, disposition: "withdrawn", withdrawn_at: null },
    {
      ...assumption,
      supersedes_assumption_id: "assumption-1",
      supersession_operation_id: null,
      supersession_request_hash: "a".repeat(64),
    },
    {
      ...assumption,
      supersession_operation_id: "operation-1",
      supersession_request_hash: "a".repeat(64),
    },
    {
      ...assumption,
      supersedes_assumption_id: "assumption-1",
      supersession_operation_id: "operation-1",
      supersession_request_hash: null,
    },
    {
      ...assumption,
      supersedes_assumption_id: "assumption-1",
      supersession_operation_id: "operation-1",
      supersession_request_hash: "not-a-sha256-hash",
    },
  ])("rejects a contradictory assumption lifecycle %#", (row) => {
    expect(specAssumptionRowSchema.safeParse(row).success).toBe(false);
  });

  it("registers the attention mutation refusal vocabulary", () => {
    for (const code of [
      "authoring_agent_required",
      "stale_attention_record",
      "stale_citation_set",
      "attention_state_conflict",
      "idempotency_conflict",
    ]) {
      expect(refusalCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});

describe("revision citation integrity metadata", () => {
  const revisionRow = {
    id: "revision-1",
    spec_id: "spec-1",
    number: 1,
    state: "draft",
    authoring_stage: "requirements",
    based_on_revision_id: null,
    content_hash: null,
    citation_contract_version: 2,
    citation_version: 1,
    citation_hash: "a".repeat(64),
    proposed_at: null,
    approved_at: null,
    external_delivery_json: null,
    created_at: "2026-08-23T10:00:00.000Z",
  } as const;

  const revision = {
    id: "revision-1",
    specId: "spec-1",
    number: 1,
    state: "draft",
    authoringStage: "requirements",
    basedOnRevisionId: null,
    contentHash: null,
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: "a".repeat(64),
    proposedAt: null,
    approvedAt: null,
    externalDelivery: null,
    createdAt: "2026-08-23T10:00:00.000Z",
  } as const;

  it("retains citation contract, compare-and-swap, and hash fields on revision rows and views", () => {
    expect(specRevisionRowSchema.parse(revisionRow)).toEqual(revisionRow);
    expect(specRevisionSchema.parse(revision)).toEqual(revision);
  });

  it.each([
    { ...revisionRow, citation_contract_version: 0 },
    { ...revisionRow, citation_contract_version: 3 },
    { ...revisionRow, citation_version: 0 },
    { ...revisionRow, citation_hash: "not-a-sha256-hash" },
  ])("rejects invalid revision citation metadata %#", (row) => {
    expect(specRevisionRowSchema.safeParse(row).success).toBe(false);
  });

  it("requires an explicit sorted citation collection on revision snapshots", () => {
    const snapshot = {
      revision,
      elements: [],
      assumptionCitations: [],
    };

    expect(specRevisionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      specRevisionSnapshotSchema.safeParse({ revision, elements: [] }).success,
    ).toBe(false);
  });
});

describe("revision-owned assumption citation schemas", () => {
  const snapshot = {
    schemaVersion: 1,
    captureKind: "native",
    capturedAt: "2026-08-23T10:01:00.000Z",
    assumptionId: "assumption-1",
    number: 1,
    recordVersion: 2,
    text: "The cutover can quiesce all writers.",
    elementId: "requirement-1",
    proposedBy: { kind: "agent", conversationId: "conversation-1" },
    disposition: "confirmed",
    disposedAt: "2026-08-23T10:00:30.000Z",
    withdrawnAt: null,
    supersedesAssumptionId: null,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:30.000Z",
  } as const;

  const citation = {
    revisionId: "revision-1",
    specId: "spec-1",
    elementId: "requirement-1",
    assumptionId: "assumption-1",
    snapshot,
    createdAt: "2026-08-23T10:01:00.000Z",
    updatedAt: "2026-08-23T10:01:00.000Z",
  } as const;

  it("strictly parses native and legacy citation snapshots", () => {
    expect(specAssumptionCitationSnapshotSchema.parse(snapshot)).toEqual(
      snapshot,
    );
    expect(
      specAssumptionCitationSnapshotSchema.parse({
        ...snapshot,
        captureKind: "legacy_backfill",
      }),
    ).toEqual({ ...snapshot, captureKind: "legacy_backfill" });
  });

  it.each([
    { ...snapshot, schemaVersion: 2 },
    { ...snapshot, captureKind: "inferred" },
    { ...snapshot, recordVersion: 0 },
    { ...snapshot, disposition: "proposed", disposedAt: snapshot.disposedAt },
    { ...snapshot, disposition: "confirmed", disposedAt: null },
    {
      ...snapshot,
      disposition: "withdrawn",
      disposedAt: null,
      withdrawnAt: null,
    },
    { ...snapshot, unknown: true },
  ])("rejects an ambiguous or non-strict citation snapshot %#", (value) => {
    expect(specAssumptionCitationSnapshotSchema.safeParse(value).success).toBe(
      false,
    );
  });

  it("parses database and domain citation rows without losing ownership fields", () => {
    const row = {
      revision_id: citation.revisionId,
      spec_id: citation.specId,
      element_id: citation.elementId,
      assumption_id: citation.assumptionId,
      assumption_snapshot_json: JSON.stringify(snapshot),
      created_at: citation.createdAt,
      updated_at: citation.updatedAt,
    };

    expect(specAssumptionCitationRowSchema.parse(row)).toEqual(row);
    expect(specAssumptionCitationSchema.parse(citation)).toEqual(citation);
  });

  it("rejects citation rows with missing identity or unknown domain fields", () => {
    const { assumptionId: _omitted, ...withoutAssumption } = citation;
    expect(
      specAssumptionCitationSchema.safeParse(withoutAssumption).success,
    ).toBe(false);
    expect(
      specAssumptionCitationSchema.safeParse({ ...citation, inferred: true })
        .success,
    ).toBe(false);
  });

  it("requires revision citations in canonical element-and-assumption order", () => {
    const revision = {
      id: "revision-1",
      specId: "spec-1",
      number: 1,
      state: "draft",
      authoringStage: "requirements",
      basedOnRevisionId: null,
      contentHash: null,
      citationContractVersion: 2,
      citationVersion: 1,
      citationHash: "a".repeat(64),
      proposedAt: null,
      approvedAt: null,
      externalDelivery: null,
      createdAt: "2026-08-23T10:00:00.000Z",
    } as const;
    const later = {
      ...citation,
      elementId: "requirement-2",
      assumptionId: "assumption-2",
      snapshot: {
        ...snapshot,
        assumptionId: "assumption-2",
        number: 2,
      },
    };

    expect(
      specRevisionSnapshotSchema.safeParse({
        revision,
        elements: [],
        assumptionCitations: [citation, later],
      }).success,
    ).toBe(true);
    expect(
      specRevisionSnapshotSchema.safeParse({
        revision,
        elements: [],
        assumptionCitations: [later, citation],
      }).success,
    ).toBe(false);
    expect(
      specRevisionSnapshotSchema.safeParse({
        revision,
        elements: [],
        assumptionCitations: [citation, citation],
      }).success,
    ).toBe(false);
  });
});

describe("attention audit event schemas", () => {
  const questionBefore = {
    kind: "question",
    recordId: "question-1",
    number: 1,
    recordVersion: 1,
    text: "Which rollout owns the cutover?",
    elementId: null,
    provenance: { kind: "agent", conversationId: "conversation-1" },
    status: "open",
    answer: null,
    answeredAt: null,
    withdrawnAt: null,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:00.000Z",
  } as const;
  const questionAfter = {
    ...questionBefore,
    recordVersion: 2,
    text: "Which release coordinator owns the cutover?",
    updatedAt: "2026-08-23T10:01:00.000Z",
  } as const;
  const assumptionSnapshot = {
    schemaVersion: 1,
    captureKind: "native",
    capturedAt: "2026-08-23T10:01:00.000Z",
    assumptionId: "assumption-1",
    number: 1,
    recordVersion: 1,
    text: "All writers can quiesce.",
    elementId: "requirement-1",
    proposedBy: { kind: "agent", conversationId: "conversation-1" },
    disposition: "proposed",
    disposedAt: null,
    withdrawnAt: null,
    supersedesAssumptionId: null,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:00.000Z",
  } as const;

  it("registers the two strict audit event families and operation vocabulary", () => {
    expect(
      specEventTypeSchema.safeParse("spec-review-record-mutated").success,
    ).toBe(true);
    expect(
      specEventTypeSchema.safeParse("spec-assumption-citations-mutated")
        .success,
    ).toBe(true);
    for (const operation of [
      "opened",
      "proposed",
      "imported",
      "edited",
      "answered",
      "disposed",
      "withdrawn",
      "superseded",
    ]) {
      expect(specReviewRecordOperationSchema.safeParse(operation).success).toBe(
        true,
      );
    }
  });

  it("parses strict question and assumption audit snapshots", () => {
    const assumption = {
      kind: "assumption",
      recordId: "assumption-1",
      number: 1,
      recordVersion: 1,
      text: assumptionSnapshot.text,
      elementId: assumptionSnapshot.elementId,
      proposedBy: assumptionSnapshot.proposedBy,
      disposition: "proposed",
      disposedAt: null,
      withdrawnAt: null,
      supersedesAssumptionId: null,
      supersededByAssumptionId: null,
      createdAt: assumptionSnapshot.createdAt,
      updatedAt: assumptionSnapshot.updatedAt,
    } as const;

    expect(specRecordAuditSnapshotSchema.parse(questionBefore)).toEqual(
      questionBefore,
    );
    expect(specRecordAuditSnapshotSchema.parse(assumption)).toEqual(assumption);
    expect(
      specRecordAuditSnapshotSchema.safeParse({
        ...questionBefore,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("accepts a versioned record mutation event whose operation matches its snapshots", () => {
    const event = {
      schemaVersion: 1,
      recordKind: "question",
      recordId: "question-1",
      recordNumber: 1,
      attentionId: "question-1",
      operation: "edited",
      active: true,
      before: questionBefore,
      after: questionAfter,
    } as const;

    expect(specReviewRecordMutatedEventPayloadSchema.parse(event)).toEqual(
      event,
    );
  });

  it.each([
    {
      schemaVersion: 1,
      recordKind: "question",
      recordId: "question-1",
      recordNumber: 1,
      attentionId: "question-1",
      operation: "edited",
      active: true,
      before: null,
      after: questionAfter,
    },
    {
      schemaVersion: 1,
      recordKind: "question",
      recordId: "question-1",
      recordNumber: 1,
      attentionId: "question-1",
      operation: "withdrawn",
      active: false,
      before: questionBefore,
      after: {
        ...questionAfter,
        status: "withdrawn",
        withdrawnAt: "2026-08-23T10:01:00.000Z",
      },
    },
    {
      schemaVersion: 1,
      recordKind: "assumption",
      recordId: "assumption-1",
      recordNumber: 1,
      attentionId: "assumption-1",
      operation: "proposed",
      active: true,
      before: null,
      after: questionAfter,
    },
    {
      schemaVersion: 1,
      recordKind: "question",
      recordId: "question-1",
      recordNumber: 1,
      attentionId: "question-1",
      operation: "edited",
      active: false,
      before: questionBefore,
      after: questionAfter,
    },
  ])("rejects an inconsistent record mutation event %#", (event) => {
    expect(
      specReviewRecordMutatedEventPayloadSchema.safeParse(event).success,
    ).toBe(false);
  });

  it("parses a citation mutation event with ordered snapshot deltas", () => {
    const event = {
      schemaVersion: 1,
      revisionId: "revision-1",
      beforeCitationVersion: 1,
      afterCitationVersion: 2,
      beforeCitationHash: "a".repeat(64),
      afterCitationHash: "b".repeat(64),
      added: [
        {
          elementId: "requirement-1",
          assumptionId: "assumption-1",
          snapshot: assumptionSnapshot,
        },
      ],
      removed: [],
      refreshed: [],
    } as const;

    expect(
      specAssumptionCitationsMutatedEventPayloadSchema.parse(event),
    ).toEqual(event);
    expect(
      specAssumptionCitationsMutatedEventPayloadSchema.safeParse({
        ...event,
        afterCitationVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      specAssumptionCitationsMutatedEventPayloadSchema.safeParse({
        ...event,
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

describe("attention mutation and presentation contracts", () => {
  it.each([
    { kind: "question", text: "Which release coordinator owns this?" },
    {
      kind: "question",
      attachment: { kind: "element", handle: "R2" },
    },
    { kind: "assumption", text: "Every writer can quiesce." },
    {
      kind: "assumption",
      attachment: { kind: "element", handle: "R2" },
      citationIntent: {
        kind: "replace",
        revisionId: "revision-2",
        elementHandles: ["R2"],
      },
    },
    {
      kind: "assumption",
      attachment: { kind: "spec" },
      citationIntent: { kind: "preserve" },
    },
  ])("parses a strict edit document %#", (payload) => {
    expect(specAttentionEditPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    { kind: "question" },
    { kind: "assumption" },
    {
      kind: "assumption",
      attachment: { kind: "element", handle: "R2" },
    },
    {
      kind: "assumption",
      text: "Every writer can quiesce.",
      unexpected: true,
    },
    {
      kind: "assumption",
      attachment: { kind: "element", handle: "R2" },
      citationIntent: {
        kind: "replace",
        revisionId: "revision-2",
        elementHandles: [],
      },
    },
  ])(
    "rejects an empty, ambiguous, or non-strict edit document %#",
    (payload) => {
      expect(specAttentionEditPayloadSchema.safeParse(payload).success).toBe(
        false,
      );
    },
  );

  it("parses a strict supersession document with explicit citation replacement", () => {
    const payload = {
      operationId: "operation-1",
      reason: "The human decision changed the premise.",
      text: "Only the release coordinator writes during cutover.",
      attachment: { kind: "element", handle: "R2" },
      citations: { kind: "replace", elementHandles: ["R2", "R3"] },
    } as const;

    expect(specSupersedeAssumptionPayloadSchema.parse(payload)).toEqual(
      payload,
    );
    expect(
      specSupersedeAssumptionPayloadSchema.parse({
        ...payload,
        citations: { kind: "clear" },
      }),
    ).toEqual({ ...payload, citations: { kind: "clear" } });
    expect(
      specSupersedeAssumptionPayloadSchema.safeParse({
        ...payload,
        citations: { kind: "replace", elementHandles: ["R2", "R2"] },
      }).success,
    ).toBe(false);
  });

  it("parses a bounded supersession receipt without authored bodies", () => {
    const receipt = {
      operation: "superseded",
      recordKind: "assumption",
      recordId: "assumption-1",
      recordHandle: "A1",
      previousRecordVersion: 2,
      newRecordVersion: 3,
      lifecycle: "rejected",
      draftRevisionId: "revision-2",
      previousCitationVersion: 4,
      newCitationVersion: 5,
      citationChanges: {
        added: ["R2"],
        removed: ["R1"],
        refreshed: [],
      },
      successor: { id: "assumption-2", handle: "A2" },
      idempotentReplay: false,
    } as const;

    expect(specAttentionMutationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(
      specAttentionMutationReceiptSchema.safeParse({
        ...receipt,
        text: "The receipt must not echo authored content.",
      }).success,
    ).toBe(false);
    expect(
      specAttentionMutationReceiptSchema.safeParse({
        ...receipt,
        newRecordVersion: 2,
      }).success,
    ).toBe(false);
  });

  it("parses server-derived current and history presentation capabilities", () => {
    const current = {
      state: "current",
      attentionActive: true,
      lastMutation: {
        operation: "edited",
        actor: { kind: "agent", conversationId: "conversation-2" },
        occurredAt: "2026-08-23T10:05:00.000Z",
      },
      humanCapability: { kind: "answer", allowed: true },
    } as const;
    const history = {
      state: "history",
      attentionActive: false,
      lastMutation: null,
      humanCapability: {
        kind: "dispose",
        allowed: false,
        code: "terminal",
        blockingRevisionId: null,
        instruction: "Read the successor record.",
      },
    } as const;

    expect(specAttentionRecordPresentationSchema.parse(current)).toEqual(
      current,
    );
    expect(specAttentionRecordPresentationSchema.parse(history)).toEqual(
      history,
    );
    expect(
      specAttentionRecordPresentationSchema.safeParse({
        ...history,
        attentionActive: true,
      }).success,
    ).toBe(false);
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
