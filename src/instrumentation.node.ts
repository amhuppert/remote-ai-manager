import { recoverStaleConversations } from "./lib/state";
import { startMergeDetection } from "./lib/merge-detection";
import { initialize as initNotificationDb } from "./lib/notification-db";
import { setConfigReader } from "./lib/push-dispatcher";
import { readConfig } from "./lib/config";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "./lib/logging";

const logger = createLogger("startup");

export async function register() {
  try {
    const recovered = await recoverStaleConversations();
    if (recovered > 0) {
      logger.info("startup.recovered_stale_conversations", { recovered });
    }
  } catch (err) {
    logger.error("startup.recovery_failed", {
      error: getErrorMessage(err),
    });
  }

  // Rehydrate conversation actors from persisted machine snapshots
  try {
    const { rehydrateConversationActors } =
      await import("./lib/workflows/conversation/manager");
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
    initNotificationDb();
    logger.info("startup.notification_db_initialized");
  } catch (err) {
    logger.error("startup.notification_db_failed", {
      error: getErrorMessage(err),
    });
  }

  // Wire up push notification config reader
  setConfigReader(readConfig);

  try {
    await startMergeDetection();
  } catch (err) {
    logger.error("startup.merge_detection_failed", {
      error: getErrorMessage(err),
    });
  }
}
