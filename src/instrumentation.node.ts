import { readState } from "./lib/state";
import { startMergeDetection } from "./lib/merge-detection";
import { initialize as initNotificationDb } from "./lib/notification-db";
import { setConfigReader } from "./lib/push-dispatcher";
import { readConfig } from "./lib/config";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "./lib/logging";
import { runGraphWorkflowContextValidatorCutover } from "./lib/workflow-graph/context-validator-cutover";
import { recoverActiveWorkflowEnvelopes } from "./lib/workflows/primitives/recover-workflow-envelopes";
import { createSessionWorkflowEnvelopeRepositoryForProduction } from "./lib/workflows/primitives/default-session-workflow-envelope-store";

const logger = createLogger("startup");

export interface StartupDeps {
  runGraphWorkflowContextValidatorCutover: typeof runGraphWorkflowContextValidatorCutover;
  loadConversationManager(): Promise<{
    rehydrateConversationActors(): Promise<number>;
  }>;
  initNotificationDb: typeof initNotificationDb;
  setConfigReader: typeof setConfigReader;
  readConfig: typeof readConfig;
  startMergeDetection: typeof startMergeDetection;
  recoverActiveWorkflowEnvelopes: typeof recoverActiveWorkflowEnvelopes;
}

const defaultStartupDeps: StartupDeps = {
  runGraphWorkflowContextValidatorCutover,
  loadConversationManager: () => import("./lib/workflows/conversation/manager"),
  initNotificationDb,
  setConfigReader,
  readConfig,
  startMergeDetection,
  recoverActiveWorkflowEnvelopes,
};

export function createStartupRegistrar(
  deps: StartupDeps = defaultStartupDeps,
): () => Promise<void> {
  return async () => {
    try {
      const cutover = await deps.runGraphWorkflowContextValidatorCutover();
      logger.info("startup.graph_workflow_cutover_checked", {
        status: cutover.status,
        stateBackupPath: cutover.stateBackupPath,
        workflowDefinitionsBackupPath: cutover.workflowDefinitionsBackupPath,
        sessionsScanned: cutover.summary.sessionsScanned,
        sessionsCleared: cutover.summary.sessionsCleared,
        activeExecutionsCleared: cutover.summary.activeExecutionsCleared,
        archivedExecutionsCleared: cutover.summary.archivedExecutionsCleared,
      });
    } catch (err) {
      logger.error("startup.graph_workflow_cutover_failed", {
        error: getErrorMessage(err),
      });
    }

    // Rehydrate conversation actors from persisted machine snapshots
    try {
      const { rehydrateConversationActors } =
        await deps.loadConversationManager();
      const rehydrated = await rehydrateConversationActors();
      if (rehydrated > 0) {
        logger.info("startup.rehydrated_conversation_actors", {
          count: rehydrated,
        });
      }
    } catch (err) {
      logger.error("startup.conversation_rehydration_failed", {
        error: getErrorMessage(err),
      });
    }

    try {
      const envelopeSummary = await deps.recoverActiveWorkflowEnvelopes({
        readState,
        createRepository: ({ projectPath, sessionName }) =>
          createSessionWorkflowEnvelopeRepositoryForProduction({
            projectPath,
            sessionName,
          }),
        // Collaboration Mode runs in-process via `createCollaborationManager`,
        // which fires `runCollaborationSlice` from a route handler and does not
        // register the slice with any cross-process worker registry. A process
        // restart therefore severs the slice; recovery surfaces this by
        // marking previously-`running` envelopes `failed` with a restart
        // errorSummary. Paused envelopes are recoverable and preserved so the
        // UI can surface a resume affordance. Once an in-memory worker
        // registry exists, swap this predicate for a lookup against it.
        isWorkerActive: () => false,
        // Collaboration envelopes are recoverable: we mark them `paused` with
        // a synthetic resume token so the UI can surface a recovery action
        // that triggers `manager.resume` and replays the slice from the last
        // completed round. Other workflow types fall through to the default
        // `markFailed` behavior.
        resolveInactiveAction: ({ envelope }) => {
          if (envelope.workflowType === "collaboration") {
            return {
              kind: "preserve_paused",
              pauseGateKind: "human_approval",
              resumeToken: `recovery-${envelope.workflowId}`,
            };
          }
          return { kind: "fail" };
        },
      });
      if (
        envelopeSummary.failed > 0 ||
        envelopeSummary.preservedPaused > 0 ||
        envelopeSummary.preservedRunning > 0 ||
        envelopeSummary.movedToPaused > 0
      ) {
        logger.info("startup.recovered_workflow_envelopes", {
          ...envelopeSummary,
        });
      }
    } catch (err) {
      logger.error("startup.workflow_envelope_recovery_failed", {
        error: getErrorMessage(err),
      });
    }

    try {
      deps.initNotificationDb();
      logger.info("startup.notification_db_initialized");
    } catch (err) {
      logger.error("startup.notification_db_failed", {
        error: getErrorMessage(err),
      });
    }

    // Wire up push notification config reader
    deps.setConfigReader(deps.readConfig);

    try {
      await deps.startMergeDetection();
    } catch (err) {
      logger.error("startup.merge_detection_failed", {
        error: getErrorMessage(err),
      });
    }
  };
}

export const register = createStartupRegistrar();
