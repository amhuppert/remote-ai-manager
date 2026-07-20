import type { SpecApprovalRow } from "./schemas";

export interface SpecApprovalStatusReader {
  findLatestApprovalForSubject(input: {
    specId: string;
    revisionId: string;
    subjectKind: SpecApprovalRow["subject_kind"];
    elementId: string | null;
  }): SpecApprovalRow | null;
}

export interface ReadSpecApprovalStatusInput {
  specId: string;
  revisionId: string;
  subjectKind: SpecApprovalRow["subject_kind"];
  elementId: string | null;
}

export type SpecApprovalStatus =
  | { status: "pending" }
  | { status: "granted"; approvalId: string; grantedAt: string };

export function readSpecApprovalStatus(
  reader: SpecApprovalStatusReader,
  input: ReadSpecApprovalStatusInput,
): SpecApprovalStatus {
  const approval = reader.findLatestApprovalForSubject(input);
  if (!approval || approval.validity !== "valid") {
    return { status: "pending" };
  }
  return {
    status: "granted",
    approvalId: approval.id,
    grantedAt: approval.granted_at,
  };
}
