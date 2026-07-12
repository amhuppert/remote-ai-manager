// Presentation-only view model for the sidebar's Active Work section.
// Source schemas (BackgroundJob, ActiveGraphWorkflowExecution,
// ActiveCollaborationExecution) stay authoritative; adapters map them into
// this shape for display. See docs/design/activity-panel-rework.md.

export type ActiveWorkKind = "job" | "workflow" | "collab";

export type ActiveWorkActionKind = "land" | "resolve" | "discard";

export interface ActiveWorkAction {
  label: string;
  kind: ActiveWorkActionKind;
}

export interface ActiveWorkItem {
  id: string;
  kind: ActiveWorkKind;
  title: string;
  projectName: string;
  sessionName: string;
  phase: string;
  href: string;
  startedAt: string;
  progress?: { completed: number; total: number };
  needsAction?: { primary: ActiveWorkAction; secondary?: ActiveWorkAction };
}

export interface AttentionItem {
  id: string;
  title: string;
  detail: string;
  projectName: string;
  sessionName: string;
  occurredAt: string;
  href: string;
}

export interface ActiveWorkPartition {
  needsAction: ActiveWorkItem[];
  running: ActiveWorkItem[];
}

const AMBIENT_ROW_CAP = 3;

function byStartedAtAscending(a: ActiveWorkItem, b: ActiveWorkItem): number {
  return Date.parse(a.startedAt) - Date.parse(b.startedAt);
}

// Oldest-first within each group keeps rows positionally stable while new
// work arrives (new items append rather than reshuffling the list).
export function partitionActiveWork(
  items: ActiveWorkItem[],
): ActiveWorkPartition {
  const needsAction: ActiveWorkItem[] = [];
  const running: ActiveWorkItem[] = [];
  for (const item of items) {
    (item.needsAction !== undefined ? needsAction : running).push(item);
  }
  needsAction.sort(byStartedAtAscending);
  running.sort(byStartedAtAscending);
  return { needsAction, running };
}

export function clampAmbientRows(
  partition: ActiveWorkPartition,
  cap: number = AMBIENT_ROW_CAP,
): { visible: ActiveWorkItem[]; hiddenCount: number } {
  const ordered = [...partition.needsAction, ...partition.running];
  const visible = ordered.slice(0, cap);
  return { visible, hiddenCount: ordered.length - visible.length };
}

export function formatElapsed(startedAtIso: string, nowMs: number): string {
  const timestamp = Date.parse(startedAtIso);
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - timestamp) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
