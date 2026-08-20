/**
 * Startup recovery for durable workflow envelopes.
 *
 * Walks every (project, session) pair, lists active
 * (`running` or `paused`) envelopes for each session, and reconciles them
 * against the in-memory worker registry supplied by the caller:
 *
 *  - `running` envelope with no in-memory worker → transition to `failed`
 *    with an `errorSummary` noting the process restart. The envelope stays
 *    discoverable for history (`listAll`), but is excluded from `listActive`
 *    so the UI does not advertise stale work.
 *  - `running` envelope with a live worker → leave as-is. The worker is
 *    presumed to own the lifecycle.
 *  - `paused` envelope → leave as-is. Pause projections are themselves
 *    durable and recoverable; resuming is the caller's responsibility.
 *
 * Recovery decisions are logged through the project's structured logger so
 * an operator can audit which envelopes were transitioned at startup.
 */
import type { SessionConversationListItem } from "@/lib/state-store";
import { createLogger } from "@/lib/logging";
import type { GateKind } from "./gate-vocabulary";
import type { WorkflowEnvelope } from "./workflow-envelope-vocabulary";
import type { WorkflowEnvelopeRepository } from "./workflow-envelope-repository";

const logger = createLogger("workflows.primitives.workflow-envelope.recovery");

const PROCESS_RESTART_ERROR_SUMMARY =
  "process restart - in-memory worker not found";

type RecoveryAction =
  /** `featureSnapshotPatch` rides the SAME update as the status change, so a
   *  workflow type whose resumability is decided from its snapshot never has a
   *  window where it reads as failed without saying why. */
  | { kind: "fail"; featureSnapshotPatch?: Record<string, unknown> }
  | { kind: "preserve_paused"; pauseGateKind: GateKind; resumeToken: string };

type RecoveryActionResolver = (input: {
  envelope: WorkflowEnvelope;
  projectPath: string;
  sessionName: string;
}) => RecoveryAction;

export interface RecoverActiveWorkflowEnvelopesDeps {
  listSessionConversationListItems(): Promise<SessionConversationListItem[]>;
  createRepository(input: {
    projectPath: string;
    sessionName: string;
  }): WorkflowEnvelopeRepository;
  isWorkerActive(workflowId: string): boolean;
  /**
   * Optional override for what to do with a `running` envelope that has no
   * in-memory worker. Default behavior marks the envelope failed. Workflow
   * types that can resume across process restarts (e.g. collaboration) can
   * return `{ kind: "preserve_paused", ... }` to mark the envelope paused
   * with a synthetic resume token instead.
   */
  resolveInactiveAction?: RecoveryActionResolver;
}

export interface RecoverActiveWorkflowEnvelopesSummary {
  scanned: number;
  failed: number;
  preservedPaused: number;
  preservedRunning: number;
  movedToPaused: number;
}

export async function recoverActiveWorkflowEnvelopes(
  deps: RecoverActiveWorkflowEnvelopesDeps,
): Promise<RecoverActiveWorkflowEnvelopesSummary> {
  const items = await deps.listSessionConversationListItems();
  const summary: RecoverActiveWorkflowEnvelopesSummary = {
    scanned: 0,
    failed: 0,
    preservedPaused: 0,
    preservedRunning: 0,
    movedToPaused: 0,
  };

  for (const { projectPath, session } of items) {
    const sessionName = session.sessionName;
    if (
      !session.workflowEnvelopes ||
      Object.keys(session.workflowEnvelopes).length === 0
    ) {
      continue;
    }

    const repo = deps.createRepository({ projectPath, sessionName });
    const active = await repo.listActive();
    summary.scanned += active.length;

    for (const envelope of active) {
      if (envelope.status === "paused") {
        summary.preservedPaused++;
        logger.info("workflow-envelope.recovery.paused_preserved", {
          projectPath,
          sessionName,
          workflowId: envelope.workflowId,
          workflowType: envelope.workflowType,
          phase: envelope.phase,
          pauseGateKind: envelope.pause?.gateKind,
          pauseKind: envelope.pause?.pauseKind,
        });
        continue;
      }

      if (deps.isWorkerActive(envelope.workflowId)) {
        summary.preservedRunning++;
        logger.info("workflow-envelope.recovery.running_preserved", {
          projectPath,
          sessionName,
          workflowId: envelope.workflowId,
          workflowType: envelope.workflowType,
          phase: envelope.phase,
        });
        continue;
      }

      const action: RecoveryAction = deps.resolveInactiveAction
        ? deps.resolveInactiveAction({
            envelope,
            projectPath,
            sessionName,
          })
        : { kind: "fail" };

      if (action.kind === "preserve_paused") {
        await repo.markPaused(envelope.workflowId, {
          pauseKind: "post_turn",
          gateKind: action.pauseGateKind,
          resumeToken: action.resumeToken,
          reason: PROCESS_RESTART_ERROR_SUMMARY,
        });
        summary.movedToPaused++;
        logger.info("workflow-envelope.recovery.moved_to_paused", {
          projectPath,
          sessionName,
          workflowId: envelope.workflowId,
          workflowType: envelope.workflowType,
          phase: envelope.phase,
        });
        continue;
      }

      const existingSnapshot =
        envelope.featureSnapshot &&
        typeof envelope.featureSnapshot === "object" &&
        !Array.isArray(envelope.featureSnapshot)
          ? (envelope.featureSnapshot as Record<string, unknown>)
          : {};
      await repo.update(envelope.workflowId, {
        status: "failed",
        errorSummary: PROCESS_RESTART_ERROR_SUMMARY,
        ...(action.featureSnapshotPatch
          ? {
              featureSnapshot: {
                ...existingSnapshot,
                ...action.featureSnapshotPatch,
              },
            }
          : {}),
      });
      summary.failed++;
      logger.warn("workflow-envelope.recovery.running_failed", {
        projectPath,
        sessionName,
        workflowId: envelope.workflowId,
        workflowType: envelope.workflowType,
        phase: envelope.phase,
        reason: PROCESS_RESTART_ERROR_SUMMARY,
      });
    }
  }

  if (
    summary.failed > 0 ||
    summary.preservedPaused > 0 ||
    summary.preservedRunning > 0 ||
    summary.movedToPaused > 0
  ) {
    logger.info("workflow-envelope.recovery.summary", { ...summary });
  }

  return summary;
}
