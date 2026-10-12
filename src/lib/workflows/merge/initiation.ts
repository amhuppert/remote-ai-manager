import {
  evaluateSessionMergeAdmission,
  type SessionMergeAdmission,
} from "@/lib/workflow-graph/session-merge-admission";
import {
  currentRunRefusal,
  type CurrentRun,
  type CurrentRunRefusal,
} from "@/lib/runs/session-guard";
import {
  backgroundWorkRefusal,
  type BackgroundWorkRefusal,
  type SessionBackgroundWork,
} from "./background-work-guard";
import type { MergeAssociationResolver } from "./association-port";
import type { DeliveryGateEvaluator } from "./types";
import { createLogger } from "@/lib/logging";

const logger = createLogger("merge.initiation");

export type MergeInitiationInput = Parameters<
  typeof evaluateSessionMergeAdmission
>[0] & {
  projectName?: string;
  association: MergeAssociationResolver;
  gate: DeliveryGateEvaluator;
  /** The session's runs that have not finished; a merge waits for every one. */
  readCurrentRuns: (
    projectPath: string,
    sessionName: string,
  ) => readonly CurrentRun[];
  /** The session's conversations whose background work custody holds between turns; a merge waits for each. */
  readBackgroundWork: (
    projectPath: string,
    sessionName: string,
  ) => readonly SessionBackgroundWork[];
};
export type MergeInitiation =
  | SessionMergeAdmission
  | { admitted: false; refusal: CurrentRunRefusal }
  | { admitted: false; refusal: BackgroundWorkRefusal }
  | {
      admitted: false;
      refusal: {
        code: "SPEC_DELIVERY_REVIEW_REQUIRED";
        message: string;
        reviewUrl: string | null;
        blockers: string[];
      };
    };

export async function evaluateMergeInitiation(
  input: MergeInitiationInput,
): Promise<MergeInitiation> {
  const runRefusal = currentRunRefusal(
    input.readCurrentRuns(input.projectPath, input.sessionName),
    "merging this session",
  );
  if (runRefusal !== null) {
    logger.warn("merge.initiation.run_current_refused", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      surface: input.surface,
      runId: runRefusal.runId,
      runProgress: runRefusal.progress,
    });
    return { admitted: false, refusal: runRefusal };
  }
  const workRefusal = backgroundWorkRefusal(
    input.readBackgroundWork(input.projectPath, input.sessionName),
    "merging this session",
  );
  if (workRefusal !== null) {
    logger.warn("merge.initiation.background_work_refused", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      surface: input.surface,
      conversationId: workRefusal.conversationId,
    });
    return { admitted: false, refusal: workRefusal };
  }
  const lease = await evaluateSessionMergeAdmission(input);
  const projectName =
    input.projectName ??
    input.projectPath.split("/").filter(Boolean).at(-1) ??
    "";
  const association = input.association.resolve({
    projectPath: input.projectPath,
    projectName,
    sessionName: input.sessionName,
  });
  if (association.kind === "none") return lease;
  if (association.kind === "refused" && !association.specExecutionId) {
    return {
      admitted: false,
      refusal: {
        code: "SPEC_DELIVERY_REVIEW_REQUIRED",
        reviewUrl: null,
        blockers: [association.reason],
        message: `${association.reason} ${association.instruction}`,
      },
    };
  }
  const gate = await input.gate.evaluate({
    projectPath: input.projectPath,
    preparedSha: "",
    expectedTargetSha: "",
    workflowExecutionId:
      association.kind === "linked" ? association.executionId : undefined,
    specExecutionId: association.specExecutionId,
    ...(association.kind === "refused" ? { readOnly: true } : {}),
  });
  if (gate.status === "pass") {
    if (association.kind === "linked") return lease;
    return {
      admitted: false,
      refusal: {
        code: "SPEC_DELIVERY_REVIEW_REQUIRED",
        reviewUrl: null,
        blockers: [association.reason],
        message: `${association.reason} ${association.instruction}`,
      },
    };
  }
  const executionId =
    association.specExecutionId ??
    (association.kind === "linked" ? association.executionId : undefined);
  const reviewUrl = gate.spec
    ? `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(gate.spec.specSlug)}?el=delivery&execution=${encodeURIComponent(executionId ?? "")}&mergeSession=${encodeURIComponent(input.sessionName)}`
    : null;
  const blockers = [
    ...(association.kind === "refused" ? [association.reason] : []),
    ...gate.unmet.map(
      (item) => item.reason ?? `${item.criterionHandle}: ${item.outcome}`,
    ),
    ...(lease.admitted ? [] : [lease.refusal.message]),
  ];
  logger.info("merge.initiation.delivery-review-required", {
    projectName,
    sessionName: input.sessionName,
    surface: input.surface,
    executionId,
    blockerCount: blockers.length,
  });
  return {
    admitted: false,
    refusal: {
      code: "SPEC_DELIVERY_REVIEW_REQUIRED",
      reviewUrl,
      blockers,
      message: `Delivery needs review before merge. ${blockers.join(" ")}${reviewUrl ? ` [Review delivery](${reviewUrl}).` : ` ${gate.instruction}`}`,
    },
  };
}
