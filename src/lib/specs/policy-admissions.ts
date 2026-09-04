import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  prepareApprovalRequestRetirement,
  type SpecApprovalRequestsClosedNotice,
} from "./attention-records";
import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import { resolveDial } from "./policy";
import type { Spec, SpecExecutionRow, SpecGate, SpecGateDial } from "./schemas";

/**
 * Policy-basis admissions for the execution-scoped gates (execution_start,
 * delivery). Under the Notify/Off dials an admitted transition still needs
 * the full gate record: the `spec_gate_admissions` row naming its policy
 * basis (R10.2), a typed gate event committed atomically with the row
 * (R19.1), and — Notify only — a human-facing notice so the transition is
 * surfaced for post-hoc review (R11.2). This module owns that bundle; the
 * caller provides the transaction and publishes/forwards after commit.
 *
 * The admission also answers the run's open approval request at that gate.
 * A refusal under the Gate dial files a durable Needs You ask; when a human
 * then relaxes the dial instead of granting, the run proceeds and nothing
 * else ever touches that ask, so it would sit in the queue demanding an
 * approval the spec no longer wants (#108). The retirement rides the same
 * transaction as the admission row, exactly as a grant's retirement does.
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

/**
 * The port the execution-scoped gates need: besides the post-hoc notice, a
 * policy admission closes the Needs You entries of the requests it answered.
 */
export interface SpecExecutionGateAdmissionNotifier extends SpecPolicyAdmissionNotifier {
  approvalRequestsClosed(notice: SpecApprovalRequestsClosedNotice): void;
}

export interface RecordedPolicyAdmission {
  admissionId: string;
  basis: PolicyAdmissionBasis;
  /** Publish after the surrounding transaction commits, in order. */
  prepared: PreparedSpecEventPublication[];
  /** Forward to the notifier after commit; null under the Off dial. */
  notice: SpecPolicyAdmissionNotice | null;
  /**
   * The open requests this admission answered, to forward after commit; null
   * when the run had none open at this gate.
   */
  requestsClosed: SpecApprovalRequestsClosedNotice | null;
}

export interface PolicyAdmissionDeps {
  reviewRepo: Pick<
    SpecReviewRepo,
    "insertGateAdmission" | "findGateAdmissionsByRevision"
  >;
  attention: Pick<SpecEventsRepo, "listOpenApprovalRequests">;
  events: SpecEventsPublisher;
  newAdmissionId(): string;
  now(): string;
}

const GATE_EVENT_KIND: Record<PolicyAdmittedGate, string> = {
  execution_start: "execution-start-policy-admitted",
  delivery: "delivery-policy-admitted",
};

const GATE_LABEL: Record<PolicyAdmittedGate, string> = {
  execution_start: "execution start",
  delivery: "delivery",
};

const DIAL_LABEL: Record<PolicyAdmissionBasis, string> = {
  notify_policy: "Notify",
  off_policy: "Off",
};

/**
 * A per-run gate admits the run as a whole, so the admission answers every
 * ask filed at that gate for that run. Requests written before runs entered
 * request identity carry no execution id and belong to the only run that
 * could have opened them — the same reading a human grant applies.
 */
function requestsAnsweredByAdmission(
  deps: PolicyAdmissionDeps,
  gate: PolicyAdmittedGate,
  execution: SpecExecutionRow,
): string[] {
  return deps.attention
    .listOpenApprovalRequests(execution.spec_id)
    .filter(
      (request) =>
        request.gate === gate &&
        (request.executionId === execution.id || request.executionId === null),
    )
    .map((request) => request.attentionId);
}

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
    frozenDial?: SpecGateDial;
  },
): RecordedPolicyAdmission | null {
  const dial =
    input.frozenDial ?? resolveDial(input.spec.gatePolicy, input.gate);
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
  const admissionEvent = deps.events.appendInTransaction({
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
  const answered = requestsAnsweredByAdmission(
    deps,
    input.gate,
    input.execution,
  );
  const closeReason = `the ${GATE_LABEL[input.gate]} gate admitted the run under ${DIAL_LABEL[basis]}`;
  const retirements = answered.map((attentionId) =>
    prepareApprovalRequestRetirement(deps.events, {
      spec: input.spec,
      actor: { kind: "system" },
      occurredAt,
      attentionId,
      reason: closeReason,
    }),
  );
  return {
    admissionId,
    basis,
    prepared: [admissionEvent, ...retirements],
    requestsClosed:
      answered.length === 0
        ? null
        : {
            specId: input.spec.id,
            attentionIds: answered,
            reason: closeReason,
            occurredAt,
          },
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
