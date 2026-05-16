import type { z } from "zod";
import type { activeConversationSchema } from "@/lib/api-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActiveConversationBase = z.infer<typeof activeConversationSchema>;

/**
 * The shape sidebar presentation helpers operate on. The base type is the
 * Zod-inferred `ActiveConversation` from `api-client.ts`; the enriched fields
 * (`summary`, `branchName`) are added by the backend so the sidebar can
 * search and display them. This alias accepts either form: if the enriched
 * fields are present on the inferred type, the intersection collapses to it;
 * if not, callers can still satisfy the shape by providing the extras.
 */
export type SidebarConversation = ActiveConversationBase & {
  summary: string | null;
  branchName: string | null;
};

export type SidebarStatus = SidebarConversation["status"];

const NEEDS_YOU_STATUSES = new Set<SidebarStatus>(["waiting_for_input"]);

// ---------------------------------------------------------------------------
// filterConversations
// ---------------------------------------------------------------------------

export function filterConversations<T extends SidebarConversation>(
  rows: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter((row) => {
    const fields: (string | null)[] = [
      row.name,
      row.summary,
      row.projectName,
      row.sessionName,
    ];
    return fields.some(
      (value) => value !== null && value.toLowerCase().includes(needle),
    );
  });
}

// ---------------------------------------------------------------------------
// filterBySession
// ---------------------------------------------------------------------------

export function filterBySession<T extends SidebarConversation>(
  rows: T[],
  scope: { projectName: string; sessionName: string } | null,
): T[] {
  if (scope === null) return rows;
  return rows.filter(
    (row) =>
      row.projectName === scope.projectName &&
      row.sessionName === scope.sessionName,
  );
}

// ---------------------------------------------------------------------------
// splitNeedsYou
// ---------------------------------------------------------------------------

export function splitNeedsYou<T extends SidebarConversation>(
  rows: T[],
): { needsYou: T[]; others: T[] } {
  const needsYou: T[] = [];
  const others: T[] = [];
  for (const row of rows) {
    if (NEEDS_YOU_STATUSES.has(row.status)) {
      needsYou.push(row);
    } else {
      others.push(row);
    }
  }
  return { needsYou, others };
}

// ---------------------------------------------------------------------------
// clusterBySession
// ---------------------------------------------------------------------------

function sessionKey(row: SidebarConversation): string {
  return `${row.projectPath}::${row.sessionName}`;
}

export function clusterBySession<T extends SidebarConversation>(
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

export type SessionPosition = "first" | "middle" | "last" | "only";

export type AnnotatedSidebarConversation<T extends SidebarConversation> = T & {
  isFirstInSession: boolean;
  isLastInSession: boolean;
  sessionPosition: SessionPosition;
};

export function annotateSessionPos<T extends SidebarConversation>(
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

export interface SidebarGroup<T extends SidebarConversation> {
  groupKey: string;
  label: string;
  projectLabel?: string;
  sessionLabel?: string;
  items: T[];
}

function getGroupDescriptor(
  row: SidebarConversation,
  key: SidebarGroupBy,
): {
  groupKey: string;
  label: string;
  projectLabel?: string;
  sessionLabel?: string;
} {
  switch (key) {
    case "session":
      return {
        groupKey: sessionKey(row),
        label: `${row.projectName} / ${row.sessionName}`,
        projectLabel: row.projectName,
        sessionLabel: row.sessionName,
      };
    case "project":
      return { groupKey: row.projectName, label: row.projectName };
  }
}

export function groupByKey<T extends SidebarConversation>(
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

export interface SidebarSection<T extends SidebarConversation> {
  kind: "needs" | SidebarGroupBy;
  groupKey: string;
  label: string;
  projectLabel?: string;
  sessionLabel?: string;
  items: AnnotatedSidebarConversation<T>[];
}

function annotateCluster<T extends SidebarConversation>(
  rows: T[],
): AnnotatedSidebarConversation<T>[] {
  return annotateSessionPos(clusterBySession(rows));
}

export function buildConversationSidebarSections<T extends SidebarConversation>(
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

  if (options.filter === "needs") {
    const { needsYou } = splitNeedsYou(scopedRows);
    return needsYou.length > 0
      ? [
          {
            kind: "needs",
            groupKey: "needs-you",
            label: "Needs You",
            items: annotateCluster(needsYou),
          },
        ]
      : [];
  }

  const baseRows =
    options.filter === "running"
      ? scopedRows.filter((row) => row.status === "running")
      : scopedRows;

  const sections: SidebarSection<T>[] = [];
  if (options.filter !== "running") {
    const { needsYou, others } = splitNeedsYou(baseRows);
    if (needsYou.length > 0) {
      sections.push({
        kind: "needs",
        groupKey: "needs-you",
        label: "Needs You",
        items: annotateCluster(needsYou),
      });
    }
    for (const group of groupByKey(others, options.groupBy)) {
      sections.push({
        kind: options.groupBy,
        groupKey: group.groupKey,
        label: group.label,
        projectLabel: group.projectLabel,
        sessionLabel: group.sessionLabel,
        items: annotateCluster(group.items),
      });
    }
    return sections;
  }

  for (const group of groupByKey(baseRows, options.groupBy)) {
    sections.push({
      kind: options.groupBy,
      groupKey: group.groupKey,
      label: group.label,
      projectLabel: group.projectLabel,
      sessionLabel: group.sessionLabel,
      items: annotateCluster(group.items),
    });
  }
  return sections;
}
