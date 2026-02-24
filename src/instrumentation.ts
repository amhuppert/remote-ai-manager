import { recoverStaleConversations } from "./lib/state";
import { createLogger } from "./lib/logging";

const logger = createLogger("startup");

export async function register() {
  // Only run on the server (not edge runtime)
  if (typeof globalThis.process === "undefined") return;

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
}
