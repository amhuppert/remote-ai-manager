import type { SpecGate } from "./schemas";
export interface SpecPolicyAdmissionNotice {
  specId: string;
  specSlug: string;
  specName: string;
  projectPath: string;
  gate: SpecGate;
  basis: "notify_policy";
  admissionId: string;
  revisionId: string;
  occurredAt: string;
}
export interface SpecPolicyAdmissionNotifier {
  policyAdmitted(notice: SpecPolicyAdmissionNotice): void;
}
