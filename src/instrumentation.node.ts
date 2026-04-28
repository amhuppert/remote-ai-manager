import { startMergeDetection } from "./lib/merge-detection";
import { initialize as initNotificationDb } from "./lib/notification-db";
import { setConfigReader } from "./lib/push-dispatcher";
import { readConfig } from "./lib/config";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "./lib/logging";
import { runGraphWorkflowContextValidatorCutover } from "./lib/workflow-graph/context-validator-cutover";

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
}

const defaultStartupDeps: StartupDeps = {
  runGraphWorkflowContextValidatorCutover,
  loadConversationManager: () => import("./lib/workflows/conversation/manager"),
  initNotificationDb,
  setConfigReader,
  readConfig,
  startMergeDetection,
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
