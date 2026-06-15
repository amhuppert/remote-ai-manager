import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";

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

// Mirrors the private `formatRelativeTime` in ConversationSidebar.tsx (not
// exported, out of this task's boundary) so panes read consistently with the
// sidebar. A future shared-util extraction is deferred.
function formatRelativeTime(isoDate: string, now: number): string {
  const diff = now - Date.parse(isoDate);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

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
    relativeTime: formatRelativeTime(c.lastActivityAt, now),
  };
}
