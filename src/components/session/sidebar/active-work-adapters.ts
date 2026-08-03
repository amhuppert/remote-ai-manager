// Pure adapters from authoritative source schemas to the presentation-only
// ActiveWorkItem/AttentionItem view model. See docs/design/activity-panel-rework.md.
//
// Notification-derived rows follow a latest-per-saga rule: job notifications
// are append-only on the server, so within one saga (merge+resolve share a
// saga per session; commit is its own) only the newest row reflects reality —
// older conflicts/ready-to-land/failed rows are superseded, and any live job
// in the same saga supersedes every persisted row.

import type { BackgroundJob } from "@/lib/jobs/schemas";
import type {
  ActiveCollaborationExecution,
  ActiveGraphWorkflowExecution,
} from "@/lib/active-conversations/schemas";
import type { Notification } from "@/lib/notifications/schemas";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import type { SpecExecutionState, SpecGate } from "@/lib/specs/schemas";
import type { ActiveWorkItem, AttentionItem } from "./active-work";

function sessionHref(projectName: string, sessionName: string): string {
  return `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`;
}

const JOB_TITLE_VERB: Record<BackgroundJob["jobType"], string> = {
  merge: "Merge",
  commit: "Commit",
  "resolve-conflicts": "Resolve",
  rebase: "Rebase",
};

const LAND_ACTIONS = {
  primary: { label: "Land", kind: "land" },
  secondary: { label: "Discard", kind: "discard" },
} satisfies ActiveWorkItem["needsAction"];

function runningJobPhase(job: BackgroundJob): string {
  if (job.jobType === "resolve-conflicts") return "Resolving…";
  if (job.phase === "validating" || job.phase === "re-validating")
    return "Validating…";
  if (job.phase === "fixing-validation") return "Fixing errors…";
  if (job.jobType === "commit") return "Committing…";
  if (job.phase === "preparing") return "Preparing merge…";
  if (job.phase === "publishing") return "Publishing…";
  if (job.phase === "squash-merging") return "Finalizing…";
  return "Merging…";
}

export function adaptStoreJobs(jobs: BackgroundJob[]): ActiveWorkItem[] {
  const items: ActiveWorkItem[] = [];
  for (const job of jobs) {
    if (job.status !== "running" && job.status !== "ready-to-land") continue;
    const readyToLand = job.status === "ready-to-land";
    items.push({
      id: `job:${job.jobId}`,
      kind: "job",
      title: `${JOB_TITLE_VERB[job.jobType]} ${job.branchName}`,
      projectName: job.projectName,
      sessionName: job.sessionName,
      phase: readyToLand ? "Ready to land" : runningJobPhase(job),
      href: sessionHref(job.projectName, job.sessionName),
      startedAt: job.startedAt,
      ...(readyToLand ? { needsAction: LAND_ACTIONS } : {}),
    });
  }
  return items;
}

export function adaptGraphWorkflows(
  executions: ActiveGraphWorkflowExecution[],
): ActiveWorkItem[] {
  return executions.map((execution) => {
    const contexts = execution.activeContextTitles.length;
    const phase =
      execution.status === "paused"
        ? "Paused"
        : execution.status === "pending"
          ? "Queued"
          : contexts > 0
            ? `${contexts} context${contexts === 1 ? "" : "s"} active`
            : "Running";
    return {
      id: `workflow:${execution.executionId}`,
      kind: "workflow",
      title:
        contexts > 0
          ? execution.activeContextTitles.join(" + ")
          : "Graph workflow",
      projectName: execution.projectName,
      sessionName: execution.sessionName,
      phase,
      href: `${sessionHref(execution.projectName, execution.sessionName)}/workflow`,
      startedAt: execution.startedAt,
      progress: {
        completed: execution.completedContexts,
        total: execution.totalContexts,
      },
    };
  });
}

function humanizePhase(phase: string): string {
  const spaced = phase.replaceAll("_", " ").replaceAll("-", " ").trim();
  if (spaced === "") return "Running";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function adaptCollaborations(
  collaborations: ActiveCollaborationExecution[],
): ActiveWorkItem[] {
  return collaborations.map((collab) => ({
    id: `collab:${collab.workflowId}`,
    kind: "collab",
    title: "Collaboration",
    projectName: collab.projectName,
    sessionName: collab.sessionName,
    phase: collab.status === "paused" ? "Paused" : humanizePhase(collab.phase),
    href:
      collab.conversationId !== null
        ? conversationsPageHref({ conversationId: collab.conversationId })
        : sessionHref(collab.projectName, collab.sessionName),
    startedAt: collab.createdAt,
  }));
}

export interface ActiveSpecExecution {
  executionId: string;
  state: SpecExecutionState;
  specSlug: string;
  specName: string;
  projectName: string;
  sessionName: string;
  createdAt: string;
}

function specHref(projectName: string, specSlug: string): string {
  return `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(specSlug)}`;
}

function specGateLabel(gate: SpecGate): string {
  return humanizePhase(gate);
}

export function adaptSpecExecutions(
  executions: ActiveSpecExecution[],
): ActiveWorkItem[] {
  const items: ActiveWorkItem[] = [];
  for (const execution of executions) {
    if (
      execution.state !== "definition_review" &&
      execution.state !== "running"
    ) {
      continue;
    }
    items.push({
      id: `spec-execution:${execution.executionId}`,
      kind: "spec",
      title: execution.specName,
      projectName: execution.projectName,
      sessionName: execution.sessionName,
      phase:
        execution.state === "definition_review"
          ? "Definition review"
          : "Running",
      href: specHref(execution.projectName, execution.specSlug),
      startedAt: execution.createdAt,
    });
  }
  return items;
}

// Pending gate requests intentionally have no adapter: there is no
// pending-attention read model — the durable registry of open requests is the
// spec notification rows, and deriveNotificationOutcomes below renders the
// identical Needs You item from them.

type JobNotification = Extract<Notification, { source: "job" }>;
type ProjectConversationNotification = Extract<
  Notification,
  { source: "project-conversation" }
>;
type SpecNotification = Extract<Notification, { source: "spec" }>;

// merge and resolve-conflicts act on the same branch-landing saga; commit is
// independent.
function jobSaga(jobType: BackgroundJob["jobType"]): "merge" | "commit" {
  return jobType === "commit" ? "commit" : "merge";
}

function latestBy<T>(
  rows: T[],
  keyOf: (row: T) => string,
  createdAtOf: (row: T) => string,
  tieBreakPriorityOf: (row: T) => number = () => 0,
): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = latest.get(key);
    if (
      current === undefined ||
      Date.parse(createdAtOf(row)) > Date.parse(createdAtOf(current)) ||
      (Date.parse(createdAtOf(row)) === Date.parse(createdAtOf(current)) &&
        tieBreakPriorityOf(row) > tieBreakPriorityOf(current))
    ) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

export function deriveNotificationOutcomes(
  notifications: Notification[],
  liveJobs: BackgroundJob[],
): { needsAction: ActiveWorkItem[]; attention: AttentionItem[] } {
  const needsAction: ActiveWorkItem[] = [];
  const attention: AttentionItem[] = [];

  const liveSagas = new Set(
    liveJobs.map(
      (job) =>
        `${job.projectName}\0${job.sessionName}\0${jobSaga(job.jobType)}`,
    ),
  );

  const jobRows = notifications.filter(
    (n): n is JobNotification => n.source === "job",
  );
  const latestJobRows = latestBy(
    jobRows,
    (row) => `${row.projectName}\0${row.sessionName}\0${jobSaga(row.jobType)}`,
    (row) => row.createdAt,
  );

  for (const row of latestJobRows) {
    const sagaKey = `${row.projectName}\0${row.sessionName}\0${jobSaga(row.jobType)}`;
    if (liveSagas.has(sagaKey)) continue;

    switch (row.type) {
      case "merge-conflicts":
        needsAction.push({
          id: `notification:${row.id}`,
          kind: "job",
          title: `Merge ${row.branchName}`,
          projectName: row.projectName,
          sessionName: row.sessionName,
          phase:
            row.conflictCount !== undefined
              ? `${row.conflictCount} conflict${row.conflictCount === 1 ? "" : "s"}`
              : "Conflicts",
          href: `${sessionHref(row.projectName, row.sessionName)}/conflicts`,
          startedAt: row.createdAt,
          needsAction: {
            primary: { label: "Resolve", kind: "resolve" },
          },
        });
        break;
      case "merge-ready-to-land":
        needsAction.push({
          id: `notification:${row.id}`,
          kind: "job",
          title: `Merge ${row.branchName}`,
          projectName: row.projectName,
          sessionName: row.sessionName,
          phase: "Ready to land",
          href: sessionHref(row.projectName, row.sessionName),
          startedAt: row.createdAt,
          needsAction: LAND_ACTIONS,
        });
        break;
      case "merge-failed":
      case "commit-failed":
      case "resolve-failed":
      case "rebase-failed":
        attention.push({
          id: row.id,
          title: row.title,
          detail: row.errorMessage ?? row.message,
          projectName: row.projectName,
          sessionName: row.sessionName,
          occurredAt: row.createdAt,
          href: sessionHref(row.projectName, row.sessionName),
        });
        break;
      case "merge-completed":
      case "merge-discarded":
      case "commit-completed":
      case "resolve-completed":
      case "rebase-completed":
        break;
    }
  }

  const conversationRows = notifications.filter(
    (n): n is ProjectConversationNotification =>
      n.source === "project-conversation",
  );
  const latestConversationRows = latestBy(
    conversationRows,
    (row) => `${row.projectName}\0${row.conversationId}`,
    (row) => row.createdAt,
  );

  for (const row of latestConversationRows) {
    if (row.type !== "project-conversation-failed") continue;
    attention.push({
      id: row.id,
      title: row.title,
      detail: row.errorMessage ?? row.message,
      projectName: row.projectName,
      sessionName: "main",
      occurredAt: row.createdAt,
      href: conversationsPageHref({ conversationId: row.conversationId }),
    });
  }

  const specRows = notifications.filter(
    (notification): notification is SpecNotification =>
      notification.source === "spec",
  );
  const latestSpecRows = latestBy(
    specRows,
    specAskKey(specRows),
    (row) => row.createdAt,
    (row) => (isOpenSpecRequest(row) ? 0 : 1),
  );

  for (const row of latestSpecRows) {
    if (row.type === "spec-approval-requested") {
      needsAction.push({
        id: `notification:${row.id}`,
        kind: "spec",
        title: row.specName,
        projectName: row.projectName,
        sessionName: row.sessionName ?? "main",
        phase: `${specGateLabel(row.gate)} approval required`,
        href: `${specHref(row.projectName, row.specSlug)}?el=${encodeURIComponent(row.deepLinkId)}`,
        startedAt: row.createdAt,
        needsAction: {
          primary: { label: "Review", kind: "review" },
        },
      });
    } else if (row.type === "spec-waiver-requested") {
      needsAction.push({
        id: `notification:${row.id}`,
        kind: "spec",
        title: row.specName,
        projectName: row.projectName,
        sessionName: row.sessionName ?? "main",
        phase: "Waiver decision required",
        href: `${specHref(row.projectName, row.specSlug)}?el=${encodeURIComponent(row.deepLinkId)}`,
        startedAt: row.createdAt,
        needsAction: {
          primary: { label: "Review", kind: "review" },
        },
      });
    }
  }

  return { needsAction, attention };
}

function isOpenSpecRequest(row: SpecNotification): boolean {
  return (
    row.type === "spec-approval-requested" ||
    row.type === "spec-waiver-requested"
  );
}

/**
 * Which ask a spec notification row belongs to, so a repeat of one ask and the
 * row that answers it collapse into a single queue item.
 *
 * An approval request carries a durable identity, and every row that answers
 * it repeats that request id, so the id is the ask. Deriving the ask from
 * (gate, subject) instead merges two different ones wherever they share a word
 * — at the plan gate the item subject and the gate name are both "plan" — and
 * lets an item approval hide the ask still waiting on the revision sign-off.
 *
 * A waiver request has no such identity: each ask mints a new id, so repeats
 * for one criterion are told apart only by the criterion they name.
 */
function specAskKey(
  rows: readonly SpecNotification[],
): (row: SpecNotification) => string {
  const waiverRequestIds = new Set(
    rows
      .filter((row) => row.type === "spec-waiver-requested")
      .map((row) => row.gateRequestId),
  );
  return (row) =>
    waiverRequestIds.has(row.gateRequestId)
      ? `${row.specId}\0waiver\0${row.gate}\0${row.deepLinkId}`
      : `${row.specId}\0${row.gateRequestId}`;
}
