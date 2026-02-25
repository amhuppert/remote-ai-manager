import { recoverStaleConversations } from "./lib/state";
import { startMergeDetection } from "./lib/merge-detection";
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
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await startMergeDetection();
  } catch (err) {
    logger.error("startup.merge_detection_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
