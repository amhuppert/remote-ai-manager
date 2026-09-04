/**
 * Bridges review-service approval notices into durable spec notification rows.
 *
 * The review service reports what happened and, for a grant, WHICH open
 * requests the act answers; this module owns the notification consequences
 * alone. It creates the `spec-approval-requested` row for a request and, on a
 * grant, the matching `spec-approval-granted` rows (same gateRequestId) so the
 * Active Work "Needs You" item clears. Dedupe keys derive from the
 * gateRequestId, so repeated grants and replays collapse to one row per
 * request and outcome.
 *
 * Which act answers which ask is never re-derived here. A request's subject
 * and deep link are display, not identity: a whole-gate request at the plan
 * gate deep-links to "plan" exactly like an approval of the plan item, and
 * matching on that is what let an item approval clear the entry that was
 * asking for the revision sign-off.
 */

import { createLogger } from "@/lib/logging";
import type {
  SpecWaiverGrantNotice,
  SpecWaiverNotifier,
  SpecWaiverRequestNotice,
} from "@/lib/specs/evidence-service";
import type {
  SpecAttentionClearInput,
  SpecAttentionNotifier,
} from "@/lib/specs/execution-service";
import type {
  SpecPolicyAdmissionNotice,
  SpecPolicyAdmissionNotifier,
} from "@/lib/specs/policy-admissions";
import type { SpecApprovalRequestsClosedNotice } from "@/lib/specs/attention-records";
import type {
  SpecApprovalGrantNotice,
  SpecApprovalRequestNotice,
  SpecReviewNotifier,
} from "@/lib/specs/review-service";
import type { CreateSpecNotificationInput } from "./repo";
import type { SpecNotification } from "./schemas";

const logger = createLogger("notifications.spec-approvals");

export interface SpecApprovalNotifierDeps {
  /** Persists through the notifications service so SSE + push side effects fire. */
  createSpecNotification(input: CreateSpecNotificationInput): void;
  findSpecNotificationsBySpecId(specId: string): SpecNotification[];
  getProjectDisplayName(projectPath: string): string;
}

function gateLabel(gate: SpecNotification["gate"]): string {
  const spaced = gate.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * What the human reads in the queue. A whole-gate entry has to name what it is
 * asking for: one line saying "requirements" for a gate with twelve
 * outstanding subjects is an entry nobody can act on. The subjects are the
 * snapshot the review domain took when the ask was made — the entry is not
 * rewritten as they are approved, so it never claims to be live.
 */
function requestMessage(notice: SpecApprovalRequestNotice): string {
  if (notice.scope === "item") return `${notice.specName}: ${notice.subject}`;
  const gate = gateLabel(notice.gate).toLowerCase();
  const outstanding = notice.outstandingSubjects;
  if (outstanding.length > 0) {
    return `${notice.specName}: ${outstanding.length} ${gate} ${
      outstanding.length === 1 ? "subject" : "subjects"
    } outstanding — ${outstanding.join(", ")}`;
  }
  return notice.signOffOutstanding
    ? `${notice.specName}: every ${gate} subject is approved; the revision awaits sign-off`
    : `${notice.specName}: the ${gate} gate awaits admission`;
}

const OPEN_REQUEST_TYPES = new Set<SpecNotification["type"]>([
  "spec-approval-requested",
  "spec-waiver-requested",
]);

const RESOLVING_TYPES = new Set<SpecNotification["type"]>([
  "spec-approval-granted",
  "spec-attention-resolved",
]);

// Requests an execution abandonment moots; authoring-gate requests stay open
// because the revision may still be under concurrent review (R3.6).
const EXECUTION_SCOPED_GATES = new Set<SpecNotification["gate"]>([
  "execution_start",
  "delivery",
]);

export function createSpecApprovalNotifier(
  deps: SpecApprovalNotifierDeps,
): SpecReviewNotifier &
  SpecPolicyAdmissionNotifier &
  SpecWaiverNotifier &
  SpecAttentionNotifier {
  function resolveOpenRequest(
    row: SpecNotification,
    title: string,
    message: string,
  ): void {
    // Display fields derive from the matched open row, so resolution callers
    // only pass ids; projectName on the row is already the display name.
    deps.createSpecNotification({
      type: "spec-attention-resolved",
      title,
      message,
      projectName: row.projectName,
      sessionName: row.sessionName,
      specId: row.specId,
      specSlug: row.specSlug,
      specName: row.specName,
      gate: row.gate,
      gateRequestId: row.gateRequestId,
      deepLinkId: row.deepLinkId,
      dedupeKey: `spec-attention-resolved:${row.gateRequestId}`,
    });
  }

  return {
    approvalRequested(notice: SpecApprovalRequestNotice): void {
      deps.createSpecNotification({
        type: "spec-approval-requested",
        title: `${gateLabel(notice.gate)} approval requested`,
        message: requestMessage(notice),
        projectName: deps.getProjectDisplayName(notice.projectPath),
        sessionName: null,
        specId: notice.specId,
        specSlug: notice.specSlug,
        specName: notice.specName,
        gate: notice.gate,
        gateRequestId: notice.gateRequestId,
        deepLinkId: notice.subject,
        dedupeKey: `spec-approval-requested:${notice.gateRequestId}`,
      });
    },

    approvalGranted(notice: SpecApprovalGrantNotice): void {
      const rows = deps.findSpecNotificationsBySpecId(notice.specId);
      const grantedRequestIds = new Set(
        rows
          .filter((row) => row.type === "spec-approval-granted")
          .map((row) => row.gateRequestId),
      );
      const satisfied = new Set(notice.satisfiedAttentionIds);
      for (const row of rows) {
        if (row.type !== "spec-approval-requested") continue;
        if (grantedRequestIds.has(row.gateRequestId)) continue;
        if (!satisfied.has(row.gateRequestId)) continue;
        deps.createSpecNotification({
          type: "spec-approval-granted",
          title: `${gateLabel(row.gate)} approval granted`,
          message: `${notice.specName}: ${row.deepLinkId}`,
          projectName: deps.getProjectDisplayName(notice.projectPath),
          sessionName: row.sessionName,
          specId: notice.specId,
          specSlug: notice.specSlug,
          specName: notice.specName,
          gate: row.gate,
          gateRequestId: row.gateRequestId,
          deepLinkId: row.deepLinkId,
          ...(notice.approvalId === null
            ? {}
            : { approvalId: notice.approvalId }),
          dedupeKey: `spec-approval-granted:${row.gateRequestId}`,
        });
        logger.info("notifications.spec-approval.granted", {
          specId: notice.specId,
          gate: row.gate,
          gateRequestId: row.gateRequestId,
        });
      }
    },

    approvalRequestsClosed(notice: SpecApprovalRequestsClosedNotice): void {
      const rows = deps.findSpecNotificationsBySpecId(notice.specId);
      const resolvedRequestIds = new Set(
        rows
          .filter((row) => RESOLVING_TYPES.has(row.type))
          .map((row) => row.gateRequestId),
      );
      const closing = new Set(notice.attentionIds);
      for (const row of rows) {
        if (row.type !== "spec-approval-requested") continue;
        if (resolvedRequestIds.has(row.gateRequestId)) continue;
        if (!closing.has(row.gateRequestId)) continue;
        resolveOpenRequest(
          row,
          `${gateLabel(row.gate)} request closed`,
          `${row.specName}: ${notice.reason}`,
        );
        logger.info("notifications.spec-approval.request_closed", {
          specId: notice.specId,
          gate: row.gate,
          gateRequestId: row.gateRequestId,
        });
      }
    },

    policyAdmitted(notice: SpecPolicyAdmissionNotice): void {
      // Post-hoc review notice, not a request: the transition already
      // proceeded under the Notify dial (R11.2), so no Needs You item opens
      // — the admission id keys dedupe so replays keep one row.
      deps.createSpecNotification({
        type: "spec-policy-admitted",
        title: `${gateLabel(notice.gate)} proceeded under Notify`,
        message: `${notice.specName}: review the policy-admitted ${gateLabel(notice.gate).toLowerCase()} gate`,
        projectName: deps.getProjectDisplayName(notice.projectPath),
        sessionName: null,
        specId: notice.specId,
        specSlug: notice.specSlug,
        specName: notice.specName,
        gate: notice.gate,
        gateRequestId: notice.admissionId,
        deepLinkId: notice.gate,
        dedupeKey: `spec-policy-admitted:${notice.admissionId}`,
      });
      logger.info("notifications.spec-policy.admitted", {
        specId: notice.specId,
        gate: notice.gate,
        admissionId: notice.admissionId,
      });
    },

    waiverRequested(notice: SpecWaiverRequestNotice): void {
      // Waivers gate deliveries (R14): the request opens a delivery-gate
      // Needs You item deep-linked to the criterion awaiting the decision.
      deps.createSpecNotification({
        type: "spec-waiver-requested",
        title: "Delivery waiver requested",
        message: `${notice.specName}: ${notice.reason}`,
        projectName: deps.getProjectDisplayName(notice.projectPath),
        sessionName: null,
        specId: notice.specId,
        specSlug: notice.specSlug,
        specName: notice.specName,
        gate: "delivery",
        gateRequestId: notice.attentionId,
        // Deep-link with the criterion handle when resolvable: the Studio
        // ?el= resolver parses handles, never raw element ids.
        deepLinkId: notice.criterionHandle ?? notice.criterionElementId,
        dedupeKey: `spec-waiver-requested:${notice.attentionId}`,
      });
      logger.info("notifications.spec-waiver.requested", {
        specId: notice.specId,
        attentionId: notice.attentionId,
        criterionElementId: notice.criterionElementId,
      });
    },

    waiverGranted(notice: SpecWaiverGrantNotice): void {
      const rows = deps.findSpecNotificationsBySpecId(notice.specId);
      const resolvedRequestIds = new Set(
        rows
          .filter((row) => RESOLVING_TYPES.has(row.type))
          .map((row) => row.gateRequestId),
      );
      const criterionKeys = new Set(
        notice.criterionHandle === null || notice.criterionHandle === undefined
          ? [notice.criterionElementId]
          : [notice.criterionElementId, notice.criterionHandle],
      );
      for (const row of rows) {
        if (row.type !== "spec-waiver-requested") continue;
        if (resolvedRequestIds.has(row.gateRequestId)) continue;
        if (!criterionKeys.has(row.deepLinkId)) continue;
        resolveOpenRequest(
          row,
          "Waiver granted",
          `${row.specName}: waiver granted for the requested criterion`,
        );
        logger.info("notifications.spec-waiver.granted", {
          specId: notice.specId,
          gateRequestId: row.gateRequestId,
          waiverId: notice.waiverId,
        });
      }
    },

    specAttentionCleared(input: SpecAttentionClearInput): void {
      const rows = deps.findSpecNotificationsBySpecId(input.specId);
      const resolvedRequestIds = new Set(
        rows
          .filter((row) => RESOLVING_TYPES.has(row.type))
          .map((row) => row.gateRequestId),
      );
      for (const row of rows) {
        if (!OPEN_REQUEST_TYPES.has(row.type)) continue;
        if (resolvedRequestIds.has(row.gateRequestId)) continue;
        if (
          input.scope === "execution" &&
          row.type === "spec-approval-requested" &&
          !EXECUTION_SCOPED_GATES.has(row.gate)
        ) {
          continue;
        }
        resolveOpenRequest(
          row,
          `${gateLabel(row.gate)} request closed`,
          `${row.specName}: ${input.reason}`,
        );
        logger.info("notifications.spec-attention.cleared", {
          specId: input.specId,
          scope: input.scope,
          gate: row.gate,
          gateRequestId: row.gateRequestId,
        });
      }
    },
  };
}
