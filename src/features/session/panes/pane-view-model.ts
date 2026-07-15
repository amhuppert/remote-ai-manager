import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";

export interface PaneViewModel {
  id: string;
  title: string;
  status: SessionActiveConversation["status"];
  projectName: string;
  sessionName: string | null;
  pendingQuestion: string | null;
  statusLine: string | null;
  relativeTime: string;
}

const UNTITLED_TITLE = "Untitled conversation";

export function toPaneViewModel(
  c: SessionActiveConversation,
  now: number = Date.now(),
): PaneViewModel {
  const trimmedName = c.name?.trim();
  return {
    id: c.id,
    title: trimmedName ? trimmedName : UNTITLED_TITLE,
    status: c.status,
    projectName: c.projectName,
    sessionName: c.sessionName,
    pendingQuestion: c.pendingQuestion,
    statusLine: c.lastActivitySummary,
    relativeTime: formatRelativeTime(c.lastActivityAt, { now }),
  };
}
