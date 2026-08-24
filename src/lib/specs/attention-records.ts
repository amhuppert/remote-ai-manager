import {
  actorProvenanceSchema,
  specRecordAuditSnapshotSchema,
  type SpecAssumptionCitationSnapshot,
  type SpecAssumptionRow,
  type SpecQuestionRow,
  type SpecRecordAuditSnapshot,
} from "./schemas";

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
