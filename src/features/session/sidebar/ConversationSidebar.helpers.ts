import type {
  ActiveConversation,
  SessionActiveConversation,
} from "@/lib/active-conversations/schemas";
import { activeConversationHref } from "@/lib/active-conversations/row-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActiveSidebarConversation = ActiveConversation;
export type SidebarConversation = SessionActiveConversation;

export type NeedsTone = "approval" | "question" | "finished";

export type ActiveRowActionScope =
  | {
      scope: "session";
      projectName: string;
      sessionName: string;
      conversationId: string;
    }
  | {
      scope: "project";
      projectName: string;
      conversationId: string;
    };

export interface ActiveRowDescriptor {
  groupKey: string;
  groupLabel: string;
  projectLabel: string;
  contextLabel: string;
  href: string;
  actionScope: ActiveRowActionScope;
  supportsSessionPeek: boolean;
  searchFields: (string | null)[];
}

function contextLabel(row: ActiveSidebarConversation): string {
  return row.scope === "session" ? row.sessionName : "main";
}

function contextKey(row: ActiveSidebarConversation): string {
  return `${row.projectPath}::${contextLabel(row)}`;
}

function routeHref(row: ActiveSidebarConversation): string {
  return activeConversationHref(row);
}

function actionScope(row: ActiveSidebarConversation): ActiveRowActionScope {
  if (row.scope === "session") {
    return {
      scope: "session",
      projectName: row.projectName,
      sessionName: row.sessionName,
      conversationId: row.id,
    };
  }
  return {
    scope: "project",
    projectName: row.projectName,
    conversationId: row.id,
  };
}

function searchFields(row: ActiveSidebarConversation): (string | null)[] {
  return [row.name, row.summary, row.projectName, contextLabel(row)];
}

export function describeActiveRow(
  row: ActiveSidebarConversation,
): ActiveRowDescriptor {
  const label = contextLabel(row);
  return {
    groupKey: contextKey(row),
    groupLabel: `${row.projectName} / ${label}`,
    projectLabel: row.projectName,
    contextLabel: label,
    href: routeHref(row),
    actionScope: actionScope(row),
    supportsSessionPeek: row.scope === "session",
    searchFields: searchFields(row),
  };
}

// ---------------------------------------------------------------------------
// filterConversations
// ---------------------------------------------------------------------------

export function filterConversations<T extends ActiveSidebarConversation>(
  rows: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter((row) => {
    const fields = searchFields(row);
    return fields.some(
      (value) => value !== null && value.toLowerCase().includes(needle),
    );
  });
}

// ---------------------------------------------------------------------------
// filterBySession
// ---------------------------------------------------------------------------

export function filterBySession<T extends ActiveSidebarConversation>(
  rows: T[],
  scope: { projectName: string; sessionName: string } | null,
): T[] {
  if (scope === null) return rows;
  return rows.filter(
    (row) =>
      row.scope === "session" &&
      row.projectName === scope.projectName &&
      row.sessionName === scope.sessionName,
  );
}

// ---------------------------------------------------------------------------
// splitNeedsYou
// ---------------------------------------------------------------------------

export function splitNeedsYou<T extends ActiveSidebarConversation>(
  rows: T[],
): { approvals: T[]; questions: T[]; finished: T[]; others: T[] } {
  const approvals: T[] = [];
  const questions: T[] = [];
  const finished: T[] = [];
  const others: T[] = [];
  for (const row of rows) {
    if (row.pendingApproval !== null) {
      approvals.push(row);
    } else if (row.status === "waiting_for_input") {
      questions.push(row);
    } else if (row.unread) {
      finished.push(row);
    } else {
      others.push(row);
    }
  }
  return { approvals, questions, finished, others };
}

export function isClosedProjectConversation(
  row: ActiveSidebarConversation,
): boolean {
  return row.scope === "project" && row.open === false;
}

function splitClosedProjectConversations<T extends ActiveSidebarConversation>(
  rows: T[],
): { openRows: T[]; closedRows: T[] } {
  const openRows: T[] = [];
  const closedRows: T[] = [];
  for (const row of rows) {
    if (isClosedProjectConversation(row)) {
      closedRows.push(row);
    } else {
      openRows.push(row);
    }
  }
  return { openRows, closedRows };
}

// ---------------------------------------------------------------------------
// clusterBySession
// ---------------------------------------------------------------------------

function sessionKey(row: ActiveSidebarConversation): string {
  return contextKey(row);
}

export function clusterBySession<T extends ActiveSidebarConversation>(
  rows: T[],
): T[] {
  const clusters = new Map<string, T[]>();
  for (const row of rows) {
    const key = sessionKey(row);
    const bucket = clusters.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      clusters.set(key, [row]);
    }
  }

  const clusterMaxActivity = new Map<string, number>();
  for (const [key, bucket] of clusters) {
    let max = -Infinity;
    for (const row of bucket) {
      const t = new Date(row.lastActivityAt).getTime();
      if (t > max) max = t;
    }
    clusterMaxActivity.set(key, max);
  }

  const orderedKeys = [...clusters.keys()].sort((a, b) => {
    const aMax = clusterMaxActivity.get(a) ?? 0;
    const bMax = clusterMaxActivity.get(b) ?? 0;
    return bMax - aMax;
  });

  const result: T[] = [];
  for (const key of orderedKeys) {
    const bucket = clusters.get(key);
    if (bucket) result.push(...bucket);
  }
  return result;
}

// ---------------------------------------------------------------------------
// annotateSessionPos
// ---------------------------------------------------------------------------

type SessionPosition = "first" | "middle" | "last" | "only";

export type AnnotatedSidebarConversation<T extends ActiveSidebarConversation> =
  T & {
    isFirstInSession: boolean;
    isLastInSession: boolean;
    sessionPosition: SessionPosition;
  };

export function annotateSessionPos<T extends ActiveSidebarConversation>(
  rows: T[],
): AnnotatedSidebarConversation<T>[] {
  return rows.map((row, idx) => {
    const key = sessionKey(row);
    const prev = idx > 0 ? rows[idx - 1] : undefined;
    const next = idx < rows.length - 1 ? rows[idx + 1] : undefined;
    const samePrev = prev !== undefined && sessionKey(prev) === key;
    const sameNext = next !== undefined && sessionKey(next) === key;
    const isFirstInSession = !samePrev;
    const isLastInSession = !sameNext;
    let sessionPosition: SessionPosition;
    if (isFirstInSession && isLastInSession) sessionPosition = "only";
    else if (isFirstInSession) sessionPosition = "first";
    else if (isLastInSession) sessionPosition = "last";
    else sessionPosition = "middle";
    return {
      ...row,
      isFirstInSession,
      isLastInSession,
      sessionPosition,
    };
  });
}

// ---------------------------------------------------------------------------
// groupByKey
// ---------------------------------------------------------------------------

export type SidebarGroupBy = "session" | "project";
export type SidebarListFilter = "all" | "needs" | "running" | "session";

export interface SidebarGroup<T extends ActiveSidebarConversation> {
  groupKey: string;
  label: string;
  projectLabel?: string;
  sessionLabel?: string;
  items: T[];
}

function getGroupDescriptor(
  row: ActiveSidebarConversation,
  key: SidebarGroupBy,
): {
  groupKey: string;
  label: string;
  projectLabel?: string;
  sessionLabel?: string;
} {
  switch (key) {
    case "session":
      if (row.scope === "session") {
        return {
          groupKey: sessionKey(row),
          label: describeActiveRow(row).groupLabel,
          projectLabel: row.projectName,
          sessionLabel: row.sessionName,
        };
      }
      return {
        groupKey: sessionKey(row),
        label: describeActiveRow(row).groupLabel,
        projectLabel: row.projectName,
      };
    case "project":
      return { groupKey: row.projectName, label: row.projectName };
  }
}

export function groupByKey<T extends ActiveSidebarConversation>(
  rows: T[],
  key: SidebarGroupBy,
): SidebarGroup<T>[] {
  const groups = new Map<string, SidebarGroup<T>>();
  for (const row of rows) {
    const { groupKey, label, projectLabel, sessionLabel } = getGroupDescriptor(
      row,
      key,
    );
    const existing = groups.get(groupKey);
    if (existing) {
      existing.items.push(row);
    } else {
      groups.set(groupKey, {
        groupKey,
        label,
        projectLabel,
        sessionLabel,
        items: [row],
      });
    }
  }
  return [...groups.values()];
}

export interface SidebarSection<T extends ActiveSidebarConversation> {
  kind: "needs" | "closed" | SidebarGroupBy;
  tone: NeedsTone | null;
  groupKey: string;
  label: string;
  projectLabel?: string;
  sessionLabel?: string;
  items: AnnotatedSidebarConversation<T>[];
}

function annotateCluster<T extends ActiveSidebarConversation>(
  rows: T[],
): AnnotatedSidebarConversation<T>[] {
  return annotateSessionPos(clusterBySession(rows));
}

function pinnedSections<T extends ActiveSidebarConversation>(
  approvals: T[],
  questions: T[],
  finished: T[],
): SidebarSection<T>[] {
  const sections: SidebarSection<T>[] = [];
  if (approvals.length > 0) {
    sections.push({
      kind: "needs",
      tone: "approval",
      groupKey: "needs-you-approvals",
      label: "Needs approval",
      items: annotateCluster(approvals),
    });
  }
  if (questions.length > 0) {
    sections.push({
      kind: "needs",
      tone: "question",
      groupKey: "needs-you-questions",
      label: "Needs you",
      items: annotateCluster(questions),
    });
  }
  if (finished.length > 0) {
    sections.push({
      kind: "needs",
      tone: "finished",
      groupKey: "needs-you-finished",
      label: "Finished \u2014 unread",
      items: annotateCluster(finished),
    });
  }
  return sections;
}

export function buildConversationSidebarSections<
  T extends ActiveSidebarConversation,
>(
  rows: T[],
  options: {
    filter: SidebarListFilter;
    groupBy: SidebarGroupBy;
    sessionScope: { projectName: string; sessionName: string } | null;
  },
): SidebarSection<T>[] {
  const scopedRows =
    options.filter === "session"
      ? filterBySession(rows, options.sessionScope)
      : rows;
  const { openRows, closedRows } = splitClosedProjectConversations(scopedRows);

  if (options.filter === "needs") {
    const { approvals, questions, finished } = splitNeedsYou(openRows);
    return pinnedSections(approvals, questions, finished);
  }

  if (options.filter === "running") {
    const sections: SidebarSection<T>[] = [];
    for (const group of groupByKey(
      openRows.filter((row) => row.status === "running"),
      options.groupBy,
    )) {
      sections.push({
        kind: options.groupBy,
        tone: null,
        groupKey: group.groupKey,
        label: group.label,
        projectLabel: group.projectLabel,
        sessionLabel: group.sessionLabel,
        items: annotateCluster(group.items),
      });
    }
    return sections;
  }

  const { approvals, questions, finished, others } = splitNeedsYou(openRows);
  const sections: SidebarSection<T>[] = pinnedSections(
    approvals,
    questions,
    finished,
  );
  for (const group of groupByKey(others, options.groupBy)) {
    sections.push({
      kind: options.groupBy,
      tone: null,
      groupKey: group.groupKey,
      label: group.label,
      projectLabel: group.projectLabel,
      sessionLabel: group.sessionLabel,
      items: annotateCluster(group.items),
    });
  }
  if (closedRows.length > 0) {
    sections.push({
      kind: "closed",
      tone: null,
      groupKey: "closed-project-conversations",
      label: "Closed",
      items: annotateCluster(closedRows),
    });
  }
  return sections;
}
