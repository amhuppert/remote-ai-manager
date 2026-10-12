import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { CustodyRefusedEnd } from "@/lib/conversation-core/executor";
import type { InteractiveConversation } from "@/lib/conversation-core/schemas";
import {
  closedSessionRefusal,
  type ClosedSessionRefusal,
} from "@/lib/runs/session-guard";

/** What each closed-session cause tells the agent whose background work it stopped. */
const CLOSED: Record<ClosedSessionRefusal["code"], CustodyRefusedEnd> = {
  session_deleted: "deleted",
  session_finalizing: "merging",
  session_finished: "merged",
};

/**
 * Why no custody may open for a conversation now (design C5b §5), or null.
 * Its session closes by the rule a run's launch reads (a merge delivers it,
 * it is finished or gone), so once a merge has started no background work
 * outlives a turn there. An archived conversation, session or project closes
 * too: nothing would show its background work or offer to stop it. A project
 * conversation has no session for a merge to close; its custody on the
 * project checkout is a stated limit.
 */
export function custodyFence(
  place: InteractiveConversation,
  read: {
    session(
      projectPath: string,
      sessionName: string,
    ): { finished: boolean; archived: boolean } | null;
    finalizingMerge(
      projectPath: string,
      sessionName: string,
    ): { jobId: string } | null;
    conversationArchived(place: InteractiveConversation): boolean;
    projectArchived(projectPath: string): boolean;
  },
): CustodyRefusedEnd | null {
  if (scopeRefFromStoreSessionName(place.sessionName).scope === "session") {
    const session = read.session(place.projectPath, place.sessionName);
    const closed = closedSessionRefusal({
      session,
      finalizingMerge: read.finalizingMerge(
        place.projectPath,
        place.sessionName,
      ),
    });
    if (closed !== null) return CLOSED[closed.code];
    if (session?.archived === true) return "archived";
  }
  return read.conversationArchived(place) ||
    read.projectArchived(place.projectPath)
    ? "archived"
    : null;
}
