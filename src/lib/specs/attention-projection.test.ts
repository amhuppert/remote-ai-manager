import { describe, expect, it } from "vitest";

import type {
  Spec,
  SpecAssumptionRow,
  SpecEventRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionSnapshot,
} from "./schemas";
import { projectAttentionRecords } from "./attention-projection";

const AT = "2026-08-23T12:00:00.000Z";
const LATER = "2026-08-23T13:00:00.000Z";
const SPEC: Spec = {
  id: "spec-1",
  projectPath: "/repos/attention",
  slug: "attention",
  name: "Attention",
  gatePolicy: { preset: "contract-bearing" },
  createdAt: AT,
  updatedAt: AT,
  abandonedAt: null,
  abandonedReason: null,
};

function revision(
  id: string,
  number: number,
  state: SpecRevision["state"],
): SpecRevision {
  return {
    id,
    specId: SPEC.id,
    number,
    state,
    authoringStage: "requirements",
    basedOnRevisionId: null,
    contentHash: state === "draft" ? null : "a".repeat(64),
    citationContractVersion: 2,
    citationVersion: 2,
    citationHash: "b".repeat(64),
    proposedAt: state === "draft" ? null : AT,
    approvedAt: state === "approved" ? AT : null,
    externalDelivery: null,
    createdAt: AT,
  };
}

function question(
  id: string,
  number: number,
  status: SpecQuestionRow["status"],
): SpecQuestionRow {
  return {
    id,
    spec_id: SPEC.id,
    number,
    element_id: null,
    text: `Question ${number}`,
    provenance_json: JSON.stringify({
      kind: "agent",
      conversationId: "creator",
    }),
    record_version: status === "open" ? 1 : 2,
    status,
    answer: status === "answered" ? "Answer" : null,
    answered_at: status === "answered" ? LATER : null,
    withdrawn_at: status === "withdrawn" ? LATER : null,
    created_at: AT,
    updated_at: status === "open" ? AT : LATER,
  };
}

function assumption(
  id: string,
  number: number,
  disposition: SpecAssumptionRow["disposition"],
  supersedes: string | null = null,
): SpecAssumptionRow {
  return {
    id,
    spec_id: SPEC.id,
    number,
    element_id: "requirement-1",
    text: `Assumption ${number}`,
    proposed_by_json: JSON.stringify({
      kind: "agent",
      conversationId: "creator",
    }),
    record_version: disposition === "proposed" ? 1 : 2,
    disposition,
    disposed_at: ["confirmed", "rejected", "deferred"].includes(disposition)
      ? LATER
      : null,
    withdrawn_at: disposition === "withdrawn" ? LATER : null,
    supersedes_assumption_id: supersedes,
    supersession_operation_id: supersedes === null ? null : `op-${number}`,
    supersession_request_hash: supersedes === null ? null : "c".repeat(64),
    created_at: AT,
    updated_at: disposition === "proposed" ? AT : LATER,
  };
}

function citationSnapshot(row: SpecAssumptionRow) {
  return {
    schemaVersion: 1 as const,
    captureKind: "native" as const,
    capturedAt: AT,
    assumptionId: row.id,
    number: row.number,
    recordVersion: row.record_version,
    text: row.text,
    elementId: row.element_id,
    proposedBy: { kind: "agent" as const, conversationId: "creator" },
    disposition: row.disposition,
    disposedAt: row.disposed_at,
    withdrawnAt: row.withdrawn_at,
    supersedesAssumptionId: row.supersedes_assumption_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

describe("projectAttentionRecords", () => {
  it("partitions current truth from history and derives active, mutation, lineage, citations, and human capability", () => {
    const frozen = revision("revision-1", 1, "proposed");
    const open = {
      ...question("question-open", 2, "open"),
      record_version: 2,
      updated_at: LATER,
    };
    const answered = question("question-answered", 1, "answered");
    const withdrawn = question("question-withdrawn", 3, "withdrawn");
    const predecessor = assumption("assumption-1", 1, "confirmed");
    const successor = assumption("assumption-2", 2, "proposed", predecessor.id);
    const proposed = assumption("assumption-3", 3, "proposed");
    const frozenSnapshot: SpecRevisionSnapshot = {
      revision: frozen,
      elements: [],
      assumptionCitations: [
        {
          revisionId: frozen.id,
          specId: SPEC.id,
          elementId: "requirement-1",
          assumptionId: proposed.id,
          snapshot: citationSnapshot(proposed),
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    };
    const event: SpecEventRow = {
      id: 1,
      spec_id: SPEC.id,
      occurred_at: LATER,
      event_type: "spec-review-record-mutated",
      actor_json: JSON.stringify({ kind: "agent", conversationId: "later" }),
      payload_json: JSON.stringify({
        schemaVersion: 1,
        recordKind: "question",
        recordId: open.id,
        recordNumber: open.number,
        attentionId: open.id,
        operation: "edited",
        active: true,
        before: {
          kind: "question",
          recordId: open.id,
          number: open.number,
          recordVersion: 1,
          text: "Earlier",
          elementId: null,
          provenance: { kind: "agent", conversationId: "creator" },
          status: "open",
          answer: null,
          answeredAt: null,
          withdrawnAt: null,
          createdAt: AT,
          updatedAt: AT,
        },
        after: {
          kind: "question",
          recordId: open.id,
          number: open.number,
          recordVersion: 2,
          text: open.text,
          elementId: null,
          provenance: { kind: "agent", conversationId: "creator" },
          status: "open",
          answer: null,
          answeredAt: null,
          withdrawnAt: null,
          createdAt: AT,
          updatedAt: LATER,
        },
      }),
    };

    const projection = projectAttentionRecords({
      spec: SPEC,
      revisions: [frozen],
      currentDraftSnapshot: null,
      frozenSnapshots: [frozenSnapshot],
      questions: [withdrawn, open, answered],
      assumptions: [successor, predecessor, proposed],
      events: [event],
    });

    expect(projection.currentQuestions.map(({ row }) => row.id)).toEqual([
      open.id,
      answered.id,
    ]);
    expect(projection.currentQuestions[0]?.presentation).toMatchObject({
      state: "current",
      attentionActive: true,
      lastMutation: {
        operation: "edited",
        actor: { kind: "agent", conversationId: "later" },
        occurredAt: LATER,
      },
      humanCapability: { kind: "answer", allowed: true },
    });
    expect(projection.currentAssumptions.map(({ row }) => row.id)).toEqual([
      successor.id,
      proposed.id,
    ]);
    expect(
      projection.currentAssumptions[1]?.presentation.humanCapability,
    ).toMatchObject({
      kind: "dispose",
      allowed: false,
      code: "amendment_required",
      blockingRevisionId: frozen.id,
    });
    expect(projection.history.map(({ row }) => row.id)).toEqual([
      predecessor.id,
      withdrawn.id,
    ]);
    expect(projection.history[0]).toMatchObject({
      kind: "assumption",
      supersededByAssumptionId: successor.id,
      presentation: {
        state: "history",
        attentionActive: false,
        humanCapability: {
          kind: "dispose",
          allowed: false,
          code: "terminal",
        },
      },
    });
  });
});
