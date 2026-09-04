import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import {
  actorProvenanceSchema,
  specRecordAuditSnapshotSchema,
  type ActorProvenance,
  type Spec,
  type SpecAssumptionCitationSnapshot,
  type SpecAssumptionRow,
  type SpecQuestionRow,
  type SpecRecordAuditSnapshot,
} from "./schemas";

/**
 * Requests that end without ever being answered: the revision they belong to
 * was withdrawn or sent back, the request predates request scope and has
 * been retired, or the run's gate proceeded under a policy dial and no human
 * act was ever recorded. They close, they do not report a grant.
 */
export interface SpecApprovalRequestsClosedNotice {
  specId: string;
  attentionIds: string[];
  reason: string;
  occurredAt: string;
}

/**
 * Ends an approval request that will never be answered. The request event
 * stays as history; this is what takes it out of request identity and out of
 * every later act's resolution, so a retired ask can neither be reused nor
 * clear something else. Every owner that ends a request — the review acts and
 * the execution-scoped policy admissions alike — writes this one event shape,
 * because the register's open-request query recognizes exactly this kind.
 */
export function prepareApprovalRequestRetirement(
  events: SpecEventsPublisher,
  input: {
    spec: Spec;
    actor: ActorProvenance | { kind: "system" };
    occurredAt: string;
    attentionId: string;
    reason: string;
  },
): PreparedSpecEventPublication {
  return events.appendInTransaction({
    actor: input.actor,
    durableEventType: "spec-attention-changed",
    durablePayload: {
      kind: "approval-request-retired",
      attentionId: input.attentionId,
      reason: input.reason,
      active: false,
    },
    sseEvent: {
      type: "spec-attention-changed",
      kind: "approval-request-retired",
      projectPath: input.spec.projectPath,
      specId: input.spec.id,
      specSlug: input.spec.slug,
      occurredAt: input.occurredAt,
      attentionId: input.attentionId,
      active: false,
    },
  });
}

export function questionAuditSnapshot(
  row: SpecQuestionRow,
): SpecRecordAuditSnapshot {
  return specRecordAuditSnapshotSchema.parse({
    kind: "question",
    recordId: row.id,
    number: row.number,
    recordVersion: row.record_version,
    text: row.text,
    elementId: row.element_id,
    provenance: actorProvenanceSchema.parse(JSON.parse(row.provenance_json)),
    status: row.status,
    answer: row.answer,
    answeredAt: row.answered_at,
    withdrawnAt: row.withdrawn_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function assumptionAuditSnapshot(
  row: SpecAssumptionRow,
  supersededByAssumptionId: string | null,
): SpecRecordAuditSnapshot {
  return specRecordAuditSnapshotSchema.parse({
    kind: "assumption",
    recordId: row.id,
    number: row.number,
    recordVersion: row.record_version,
    text: row.text,
    elementId: row.element_id,
    proposedBy: actorProvenanceSchema.parse(JSON.parse(row.proposed_by_json)),
    disposition: row.disposition,
    disposedAt: row.disposed_at,
    withdrawnAt: row.withdrawn_at,
    supersedesAssumptionId: row.supersedes_assumption_id,
    supersededByAssumptionId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function assumptionCitationSnapshot(
  row: SpecAssumptionRow,
  capturedAt: string,
): SpecAssumptionCitationSnapshot {
  return {
    schemaVersion: 1,
    captureKind: "native",
    capturedAt,
    assumptionId: row.id,
    number: row.number,
    recordVersion: row.record_version,
    text: row.text,
    elementId: row.element_id,
    proposedBy: actorProvenanceSchema.parse(JSON.parse(row.proposed_by_json)),
    disposition: row.disposition,
    disposedAt: row.disposed_at,
    withdrawnAt: row.withdrawn_at,
    supersedesAssumptionId: row.supersedes_assumption_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
