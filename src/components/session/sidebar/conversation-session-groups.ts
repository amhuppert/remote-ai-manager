import { isWorkflowLaneRole } from "@/lib/conversations/schemas";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import {
  annotateSessionPos,
  filterConversations,
  filterBySession,
  groupByKey,
  isClosedProjectConversation,
  type SidebarListFilter,
  type SidebarSection,
} from "./ConversationSidebar.helpers";

export interface SessionGroup extends SidebarSection<ActiveConversation> {
  total: number;
  expanded: boolean;
}

export interface SessionGroupOptions {
  query: string;
  project: string | null;
  includeArchived: boolean;
  includeGraphWorkflows: boolean;
  filter: SidebarListFilter;
  sessionScope: { projectName: string; sessionName: string } | null;
  expandedKeys: ReadonlySet<string>;
  activeConversationId: string;
}

export function needsAttention(row: ActiveConversation): boolean {
  return (
    !row.archived &&
    !isClosedProjectConversation(row) &&
    (row.pendingApproval !== null || row.status === "waiting_for_input")
  );
}

export function isRunning(row: ActiveConversation): boolean {
  return (
    !row.archived &&
    !isClosedProjectConversation(row) &&
    (row.status === "running" || row.backgroundActivity !== null)
  );
}

export function isUnread(row: ActiveConversation): boolean {
  return (
    !row.archived &&
    !isClosedProjectConversation(row) &&
    row.unread &&
    row.status === "awaiting" &&
    !needsAttention(row)
  );
}

export function filterSidebarScope(
  rows: ActiveConversation[],
  options: Pick<
    SessionGroupOptions,
    "project" | "includeArchived" | "includeGraphWorkflows"
  >,
): ActiveConversation[] {
  return rows.filter(
    (row) =>
      (options.includeArchived || !row.archived) &&
      (options.project === null || row.projectName === options.project) &&
      (options.includeGraphWorkflows ||
        !isWorkflowLaneRole(row.role) ||
        needsAttention(row)),
  );
}

function filterSidebarRows(
  rows: ActiveConversation[],
  options: SessionGroupOptions,
): ActiveConversation[] {
  let filtered = filterConversations(
    filterSidebarScope(rows, options),
    options.query,
  );
  if (options.filter === "session")
    filtered = filterBySession(filtered, options.sessionScope);
  if (options.filter === "needs") filtered = filtered.filter(needsAttention);
  if (options.filter === "running") filtered = filtered.filter(isRunning);
  if (options.filter === "unread") filtered = filtered.filter(isUnread);
  return filtered;
}

export function buildSessionGroups(
  rows: ActiveConversation[],
  options: SessionGroupOptions,
): SessionGroup[] {
  const filtered = filterSidebarRows(rows, options).filter(
    (row) => !needsAttention(row),
  );
  const ordered = [...filtered].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
  return groupByKey(ordered, "session").map((group) => {
    const expanded = options.expandedKeys.has(group.groupKey);
    const revealMatches =
      options.query.trim().length > 0 ||
      options.filter === "needs" ||
      options.filter === "running" ||
      options.filter === "unread";
    const latest =
      group.items.find(
        (row) => !row.archived && !isClosedProjectConversation(row),
      ) ?? group.items[0];
    const visible =
      expanded || revealMatches
        ? group.items
        : group.items.filter(
            (row) =>
              row.id === latest?.id ||
              row.id === options.activeConversationId ||
              isRunning(row) ||
              (options.includeArchived && row.archived),
          );
    return {
      ...group,
      kind: "session",
      tone: null,
      total: group.items.length,
      expanded,
      items: annotateSessionPos(visible),
    };
  });
}

export function buildSidebarContent(
  rows: ActiveConversation[],
  options: SessionGroupOptions,
) {
  return {
    needsInput: annotateSessionPos(
      filterSidebarRows(rows, options)
        .filter(needsAttention)
        .sort(
          (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
        ),
    ),
    groups: buildSessionGroups(rows, options),
  };
}
