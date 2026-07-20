import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import { resolveDial } from "./policy";
import type { Spec, SpecExecutionRow, SpecGate } from "./schemas";

/**
 * Policy-basis admissions for the execution-scoped gates (execution_start,
 * delivery). Under the Notify/Off dials an admitted transition still needs
 * the full gate record: the `spec_gate_admissions` row naming its policy
 * basis (R10.2), a typed gate event committed atomically with the row
 * (R19.1), and — Notify only — a human-facing notice so the transition is
 * surfaced for post-hoc review (R11.2). This module owns that bundle; the
 * caller provides the transaction and publishes/forwards after commit.
 */

export type PolicyAdmittedGate = "execution_start" | "delivery";
export type PolicyAdmissionBasis = "notify_policy" | "off_policy";

export interface SpecPolicyAdmissionNotice {
  specId: string;
  specSlug: string;
  specName: string;
  projectPath: string;
  /**
   * Any of the five governed gates: authoring gates (requirements, design,
   * plan) are admitted at propose/sign-off with no execution in play, so
   * their notices carry a null executionId (R11.2 covers every gate).
   */
  gate: SpecGate;
  basis: "notify_policy";
  admissionId: string;
  revisionId: string;
  executionId: string | null;
  occurredAt: string;
}

/** Outbound port for post-hoc review notifications; called after commit. */
export interface SpecPolicyAdmissionNotifier {
  policyAdmitted(notice: SpecPolicyAdmissionNotice): void;
}

export interface RecordedPolicyAdmission {
  admissionId: string;
  basis: PolicyAdmissionBasis;
  /** Publish after the surrounding transaction commits. */
  prepared: PreparedSpecEventPublication;
  /** Forward to the notifier after commit; null under the Off dial. */
  notice: SpecPolicyAdmissionNotice | null;
}

export interface PolicyAdmissionDeps {
  reviewRepo: Pick<
    SpecReviewRepo,
    "insertGateAdmission" | "findGateAdmissionsByRevision"
  >;
  events: SpecEventsPublisher;
  newAdmissionId(): string;
  now(): string;
}

const GATE_EVENT_KIND: Record<PolicyAdmittedGate, string> = {
  execution_start: "execution-start-policy-admitted",
  delivery: "delivery-policy-admitted",
};

/**
 * Runs inside the caller's transaction. Returns null when the gate's dial
 * requires a human (the grant path already wrote the admission) or when this
 * execution's admission already exists (replayed reports keep one row, one
 * event, one notice).
 */
export function recordPolicyGateAdmissionInTransaction(
  deps: PolicyAdmissionDeps,
  input: {
    spec: Spec;
    gate: PolicyAdmittedGate;
    execution: SpecExecutionRow;
  },
): RecordedPolicyAdmission | null {
  const dial = resolveDial(input.spec.gatePolicy, input.gate);
  if (dial !== "notify" && dial !== "off") return null;
  const alreadyAdmitted = deps.reviewRepo
    .findGateAdmissionsByRevision(input.execution.revision_id)
    .some(
      (admission) =>
        admission.gate === input.gate &&
        admission.execution_id === input.execution.id,
    );
  if (alreadyAdmitted) return null;

  const basis: PolicyAdmissionBasis =
    dial === "notify" ? "notify_policy" : "off_policy";
  const admissionId = deps.newAdmissionId();
  const occurredAt = deps.now();
  deps.reviewRepo.insertGateAdmission({
    id: admissionId,
    spec_id: input.execution.spec_id,
    gate: input.gate,
    basis,
    approval_id: null,
    revision_id: input.execution.revision_id,
    execution_id: input.execution.id,
    actor_json: JSON.stringify({ kind: "system" }),
    created_at: occurredAt,
  });
  const kind = GATE_EVENT_KIND[input.gate];
  const prepared = deps.events.appendInTransaction({
    actor: { kind: "system" },
    durableEventType: "spec-approval-changed",
    durablePayload: {
      kind,
      gate: input.gate,
      basis,
      admissionId,
      revisionId: input.execution.revision_id,
      executionId: input.execution.id,
    },
    sseEvent: {
      type: "spec-approval-changed",
      kind,
      projectPath: input.spec.projectPath,
      specId: input.spec.id,
      specSlug: input.spec.slug,
      occurredAt,
      revisionId: input.execution.revision_id,
      subjectId: input.execution.id,
    },
  });
  return {
    admissionId,
    basis,
    prepared,
    notice:
      basis === "notify_policy"
        ? {
            specId: input.spec.id,
            specSlug: input.spec.slug,
            specName: input.spec.name,
            projectPath: input.spec.projectPath,
            gate: input.gate,
            basis,
            admissionId,
            revisionId: input.execution.revision_id,
            executionId: input.execution.id,
            occurredAt,
          }
        : null,
  };
}
