import path from "node:path";
import { getConfigDirPath } from "@/lib/config/loader";

/**
 * The Command Center-owned root for a conversation's SDK agent store. Under the
 * CC config directory rather than the worktree, so a ref survives worktree
 * removal and the SDK never writes into a repository checkout.
 */
export function cursorAgentStorePath(conversationId: string): string {
  return path.join(getConfigDirPath(), "cursor", "agents", conversationId);
}
