import { describe, it, expect } from "vitest";
import {
  alignmentVersionStatusSchema,
  alignmentVersionSourceSchema,
  alignmentVersionSchema,
  alignmentDecisionSchema,
  decisionProposalSchema,
  decisionProposalBatchSchema,
  alignmentStateSchema,
  beginDraftRequestSchema,
  fillDraftRequestSchema,
  approveDraftRequestSchema,
  rejectDraftRequestSchema,
  proposeDecisionsRequestSchema,
  submitCharterRequestSchema,
  resolveProposalsRequestSchema,
  rollbackRequestSchema,
  diffRequestSchema,
  alignmentDiffSchema,
  sessionAlignmentUpdatedEventSchema,
  type AlignmentVersion,
  type AlignmentDecision,
  type DecisionProposal,
  type DecisionProposalBatch,
  type AlignmentState,
  type SessionAlignmentUpdatedEvent,
} from "./schemas";
import type { SSEEvent } from "@/lib/api/sse-events";

describe("alignment version status / source enums", () => {
  it("accepts the three version statuses and rejects others", () => {
    expect(alignmentVersionStatusSchema.safeParse("draft").success).toBe(true);
    expect(alignmentVersionStatusSchema.safeParse("active").success).toBe(true);
    expect(alignmentVersionStatusSchema.safeParse("superseded").success).toBe(
      true,
    );
    expect(alignmentVersionStatusSchema.safeParse("archived").success).toBe(
      false,
    );
  });

  it("accepts the five version sources and rejects others", () => {
    for (const source of [
      "align_initial",
      "align_rerun",
      "decision",
      "rollback",
      "forked",
    ]) {
      expect(alignmentVersionSourceSchema.safeParse(source).success).toBe(true);
    }
    expect(alignmentVersionSourceSchema.safeParse("manual").success).toBe(
      false,
    );
  });
});

describe("alignmentVersionSchema", () => {
  const draft: AlignmentVersion = {
    id: "v-draft",
    version: null,
    content: "# Mission\n…",
    contentHash: "abc123",
    status: "draft",
    source: "align_initial",
    authorConversationId: null,
    autoActivate: false,
    linkedDecisionIds: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    activatedAt: null,
    approver: null,
  };

  it("parses a draft version with version=null and empty linked decisions", () => {
    const parsed = alignmentVersionSchema.safeParse(draft);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBeNull();
      expect(parsed.data.linkedDecisionIds).toEqual([]);
    }
  });

  it("parses an activated version with a numeric version and linked decisions", () => {
    const activated: AlignmentVersion = {
      ...draft,
      id: "v-1",
      version: 1,
      status: "active",
      source: "decision",
      authorConversationId: "conv-1",
      autoActivate: true,
      linkedDecisionIds: ["d-1", "d-2"],
      activatedAt: "2026-06-26T01:00:00.000Z",
      approver: "alex",
    };
    const parsed = alignmentVersionSchema.safeParse(activated);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe(1);
      expect(parsed.data.linkedDecisionIds).toEqual(["d-1", "d-2"]);
    }
  });

  it("defaults linkedDecisionIds to an empty array when omitted", () => {
    const { linkedDecisionIds: _omit, ...withoutLinks } = draft;
    const parsed = alignmentVersionSchema.safeParse(withoutLinks);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.linkedDecisionIds).toEqual([]);
    }
  });

  it("rejects a non-string member of linkedDecisionIds", () => {
    const parsed = alignmentVersionSchema.safeParse({
      ...draft,
      linkedDecisionIds: ["ok", 42],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("alignmentDecisionSchema", () => {
  it("round-trips a fully populated decision and allows null rationale/producedVersion", () => {
    const decision: AlignmentDecision = {
      id: "d-1",
      statement: "Use SQLite as the source of truth",
      rationale: null,
      originConversationId: "conv-1",
      originMessageId: null,
      producedVersion: null,
      approver: "alex",
      approvedAt: "2026-06-26T01:00:00.000Z",
      createdAt: "2026-06-26T00:30:00.000Z",
    };
    const parsed = alignmentDecisionSchema.safeParse(decision);
    expect(parsed.success).toBe(true);
  });

  it("requires originConversationId", () => {
    const parsed = alignmentDecisionSchema.safeParse({
      id: "d-1",
      statement: "x",
      rationale: null,
      originMessageId: null,
      producedVersion: 2,
      approver: null,
      approvedAt: "2026-06-26T01:00:00.000Z",
      createdAt: "2026-06-26T00:30:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("decision proposal schemas", () => {
  const proposal: DecisionProposal = {
    id: "p-1",
    projectPath: "/repo",
    sessionName: "feat",
    conversationId: "conv-1",
    batchId: "batch-1",
    statement: "Adopt the new schema",
    rationale: null,
    context: null,
    originMessageId: null,
    createdAt: "2026-06-26T00:00:00.000Z",
  };

  it("parses a transient proposal with null rationale/context/originMessageId", () => {
    expect(decisionProposalSchema.safeParse(proposal).success).toBe(true);
  });

  it("groups proposals into a batch", () => {
    const batch: DecisionProposalBatch = {
      batchId: "batch-1",
      proposals: [proposal],
    };
    const parsed = decisionProposalBatchSchema.safeParse(batch);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.proposals).toHaveLength(1);
    }
  });
});

describe("alignmentStateSchema", () => {
  it("parses an empty aggregate state with nulls and empty collections", () => {
    const state: AlignmentState = {
      active: null,
      draft: null,
      history: [],
      decisions: [],
      pendingProposals: [],
      preview: null,
    };
    const parsed = alignmentStateSchema.safeParse(state);
    expect(parsed.success).toBe(true);
  });

  it("rejects a malformed history entry", () => {
    const parsed = alignmentStateSchema.safeParse({
      active: null,
      draft: null,
      history: [{ id: "x" }],
      decisions: [],
      pendingProposals: [],
      preview: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("REST request payloads", () => {
  it("charter submissions require non-whitespace content", () => {
    expect(fillDraftRequestSchema.safeParse({ content: "" }).success).toBe(
      false,
    );
    expect(fillDraftRequestSchema.safeParse({ content: " \n\t" }).success).toBe(
      false,
    );
    expect(
      fillDraftRequestSchema.safeParse({ content: "real charter" }).success,
    ).toBe(true);
    expect(
      submitCharterRequestSchema.safeParse({
        conversationId: "conv-1",
        content: " \n\t",
      }).success,
    ).toBe(false);
  });

  it("beginDraft accepts an optional conversation id", () => {
    expect(beginDraftRequestSchema.safeParse({}).success).toBe(true);
    expect(
      beginDraftRequestSchema.safeParse({ conversationId: "conv-1" }).success,
    ).toBe(true);
  });

  it("approveDraft accepts a draftId and optional approver; reject accepts a draftId", () => {
    expect(
      approveDraftRequestSchema.safeParse({ draftId: "v-draft" }).success,
    ).toBe(true);
    expect(
      approveDraftRequestSchema.safeParse({
        draftId: "v-draft",
        approver: "alex",
      }).success,
    ).toBe(true);
    expect(approveDraftRequestSchema.safeParse({}).success).toBe(false);
    expect(
      rejectDraftRequestSchema.safeParse({ draftId: "v-draft" }).success,
    ).toBe(true);
  });

  it("proposeDecisions requires at least one decision with a statement", () => {
    expect(
      proposeDecisionsRequestSchema.safeParse({ decisions: [] }).success,
    ).toBe(false);
    expect(
      proposeDecisionsRequestSchema.safeParse({
        decisions: [
          { statement: "Decide X", rationale: "because", context: "" },
        ],
      }).success,
    ).toBe(true);
    expect(
      proposeDecisionsRequestSchema.safeParse({
        decisions: [{ statement: "" }],
      }).success,
    ).toBe(false);
  });

  it("resolveProposals validates a per-decision resolution body", () => {
    const ok = resolveProposalsRequestSchema.safeParse({
      batchId: "batch-1",
      resolutions: [
        { proposalId: "p-1", approve: true },
        { proposalId: "p-2", approve: false, feedback: "not yet" },
      ],
    });
    expect(ok.success).toBe(true);

    expect(
      resolveProposalsRequestSchema.safeParse({
        batchId: "batch-1",
        resolutions: [],
      }).success,
    ).toBe(false);

    expect(
      resolveProposalsRequestSchema.safeParse({
        batchId: "batch-1",
        resolutions: [{ proposalId: "p-1" }],
      }).success,
    ).toBe(false);
  });

  it("rollback requires a target version number", () => {
    expect(rollbackRequestSchema.safeParse({ version: 2 }).success).toBe(true);
    expect(rollbackRequestSchema.safeParse({ version: "2" }).success).toBe(
      false,
    );
    expect(rollbackRequestSchema.safeParse({}).success).toBe(false);
  });

  it("diff requires numeric from/to versions", () => {
    expect(diffRequestSchema.safeParse({ from: 1, to: 2 }).success).toBe(true);
    expect(diffRequestSchema.safeParse({ from: 1 }).success).toBe(false);
  });

  it("alignmentDiff carries from/to and the two contents", () => {
    const parsed = alignmentDiffSchema.safeParse({
      from: 1,
      to: 2,
      fromContent: "old",
      toContent: "new",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("session-alignment-updated SSE event", () => {
  const sample: SessionAlignmentUpdatedEvent = {
    type: "session-alignment-updated",
    projectPath: "/repo",
    sessionName: "feat",
    activeVersion: 3,
    hasDraft: true,
    pendingProposalBatchIds: ["batch-1"],
  };

  it("parses a valid payload and allows a null activeVersion", () => {
    expect(sessionAlignmentUpdatedEventSchema.safeParse(sample).success).toBe(
      true,
    );
    expect(
      sessionAlignmentUpdatedEventSchema.safeParse({
        ...sample,
        activeVersion: null,
      }).success,
    ).toBe(true);
  });

  it("pins the exact type literal", () => {
    expect(
      sessionAlignmentUpdatedEventSchema.safeParse({
        ...sample,
        type: "alignment-updated",
      }).success,
    ).toBe(false);
  });

  it("is assignable to the SSEEvent union", () => {
    const asUnion: SSEEvent = sample;
    expect(asUnion.type).toBe("session-alignment-updated");
  });
});
