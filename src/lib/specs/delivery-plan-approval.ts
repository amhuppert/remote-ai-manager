import { stableStringify } from "@/lib/state-store/serialization";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";

import type { DeliveryPlanCandidateIdentity } from "./delivery-plan";
import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import { dialRequiresHumanApproval, resolveDial } from "./policy";
import type { SpecPolicyAdmissionNotice } from "./policy-admissions";
import type {
  ActorProvenance,
  ResolvedGateDial,
  Spec,
  SpecApprovalRow,
  SpecGateAdmissionBasis,
} from "./schemas";

/**
 * The execution-start gate's half of a delivery-plan sign-off (design §5).
 *
 * The plan sign-off is the one default human approval: it approves the stored
 * candidate AND admits `execution_start`, so no second human act stands between
 * a proposal and its launch. This module writes that admission, and it writes
 * it with a null `execution_id` because the whole point of the slot-free
 * prelaunch path is that no execution exists yet — the admission is addressed
 * by the pinned revision and the attempt it approved.
 *
 * It mirrors `policy-admissions.ts` rather than reusing it: that module's
 * dedupe and addressing are both keyed on a `SpecExecutionRow`, which is
 * exactly the row this path does not have.
 */

export interface DeliveryPlanAdmissionDeps {
  reviewRepo: Pick<SpecReviewRepo, "saveApproval" | "insertGateAdmission">;
  events: SpecEventsPublisher;
  nextId(): string;
}

export interface DeliveryPlanExecutionStartAdmission {
  /** The dial the admission was resolved under, so a receipt can explain it. */
  dial: ResolvedGateDial;
  basis: SpecGateAdmissionBasis;
  admissionId: string;
  /** The human approval row, or null when policy admitted the gate. */
  approvalId: string | null;
  /** Publish after the surrounding transaction commits. */
  prepared: PreparedSpecEventPublication;
  /** Forward to the notifier after commit; null outside the Notify dial. */
  notice: SpecPolicyAdmissionNotice | null;
}

export interface AdmitExecutionStartForAttemptInput {
  spec: Spec;
  pinnedRevisionId: string;
  attemptId: string;
  candidate: DeliveryPlanCandidateIdentity;
  actor: ActorProvenance;
  approver: string;
  occurredAt: string;
}

const HUMAN_EVENT_KIND = "execution-start-approval-granted";
const POLICY_EVENT_KIND = "execution-start-policy-admitted";

/**
 * Runs inside the caller's transaction, beside the attempt's own status write,
 * so the approval and the admission it satisfies can never be separated
 * (`audited-transitions`).
 */
export function admitExecutionStartForAttemptInTransaction(
  deps: DeliveryPlanAdmissionDeps,
  input: AdmitExecutionStartForAttemptInput,
): DeliveryPlanExecutionStartAdmission {
  const dial = resolveDial(input.spec.gatePolicy, "execution_start");
  const humanRequired = dialRequiresHumanApproval(dial);
  const basis: SpecGateAdmissionBasis = humanRequired
    ? "human_approval"
    : dial === "notify"
      ? "notify_policy"
      : "off_policy";

  let approval: SpecApprovalRow | null = null;
  if (humanRequired) {
    approval = {
      id: deps.nextId(),
      spec_id: input.spec.id,
      // The same subject kind the run-scoped grant records: an execution gate
      // admits the pinned revision as a whole, never one element of it.
      subject_kind: "revision",
      element_id: null,
      revision_id: input.pinnedRevisionId,
      approver: input.approver,
      granted_at: input.occurredAt,
      validity: "valid",
    };
    deps.reviewRepo.saveApproval(approval);
  }

  const admissionId = deps.nextId();
  deps.reviewRepo.insertGateAdmission({
    id: admissionId,
    spec_id: input.spec.id,
    gate: "execution_start",
    basis,
    approval_id: approval?.id ?? null,
    revision_id: input.pinnedRevisionId,
    execution_id: null,
    actor_json: stableStringify(
      humanRequired ? input.actor : { kind: "system" },
    ),
    created_at: input.occurredAt,
  });

  const kind = humanRequired ? HUMAN_EVENT_KIND : POLICY_EVENT_KIND;
  const prepared = deps.events.appendInTransaction({
    actor: humanRequired ? input.actor : { kind: "system" },
    durableEventType: humanRequired
      ? "spec-review-item-approved"
      : "spec-approval-changed",
    durablePayload: {
      kind,
      gate: "execution_start",
      basis,
      admissionId,
      revisionId: input.pinnedRevisionId,
      attemptId: input.attemptId,
      candidateId: input.candidate.candidateId,
      planHash: input.candidate.planHash,
      compiledDefinitionHash: input.candidate.compiledDefinitionHash,
      ...(approval === null ? {} : { approvalId: approval.id }),
    },
    sseEvent: {
      type: "spec-approval-changed",
      kind,
      projectPath: input.spec.projectPath,
      specId: input.spec.id,
      specSlug: input.spec.slug,
      occurredAt: input.occurredAt,
      revisionId: input.pinnedRevisionId,
      subjectId: input.attemptId,
    },
  });

  return {
    dial,
    basis,
    admissionId,
    approvalId: approval?.id ?? null,
    prepared,
    notice:
      basis === "notify_policy"
        ? {
            specId: input.spec.id,
            specSlug: input.spec.slug,
            specName: input.spec.name,
            projectPath: input.spec.projectPath,
            gate: "execution_start",
            basis,
            admissionId,
            revisionId: input.pinnedRevisionId,
            // No execution exists at sign-off time; the notice names the
            // admission and the revision it was granted against instead.
            executionId: null,
            occurredAt: input.occurredAt,
          }
        : null,
  };
}
