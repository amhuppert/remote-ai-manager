import type { JobsRepo } from "@/lib/jobs/repo";
import type { GraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import type { GraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import type { GraphWorkflowArchivedExecutionsRepo } from "@/lib/state-store/graph-workflow-archived-executions-repo";
import type { NotepadsRepo } from "@/lib/state-store/notepads-repo";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import type { TicketsRepo } from "@/lib/state-store/tickets-repo";
import type { ValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import type { SubscriptionSourceQueriesRepo } from "@/lib/state-store/subscription-source-queries-repo";
import type { TicketStatusChangesRepo } from "@/lib/state-store/ticket-status-changes-repo";
import { projectNameFromPath } from "@/lib/state-store/tickets-repo";
import { z } from "zod";
import type {
  SourceCursor,
  SourceFact,
  SourceReadResult,
  SubscriptionRecipient,
  SubscriptionSourceRef,
} from "./schemas";

export interface SubscriptionSourceDeps {
  notepads: NotepadsRepo;
  tickets: TicketsRepo;
  specs: SpecsRepo;
  specEvents: SpecEventsRepo;
  workflows: GraphWorkflowExecutionsRepo;
  archivedWorkflows: GraphWorkflowArchivedExecutionsRepo;
  workflowEvents: GraphWorkflowEventsRepo;
  validations: ValidationRunsRepo;
  jobs: JobsRepo;
  queries: SubscriptionSourceQueriesRepo;
  ticketChanges: TicketStatusChangesRepo;
}

const ticketCursorSchema = z
  .object({
    statusId: z.number().int().nonnegative(),
    postAt: z.string(),
    postId: z.string(),
  })
  .strict();
const eventActorSchema = z.object({
  kind: z.enum(["human", "agent"]),
  conversationId: z.string().optional(),
});

/** Baseline at a recorded link rather than at the later reconciliation time. */
export function ticketInvolvementCursor(
  statusId: number,
  linkedAt: string,
): string {
  return JSON.stringify({ statusId, postAt: linkedAt, postId: "" });
}

function eventIdCursor(cursor: string): number {
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid subscription event cursor");
  return value;
}

function quoteArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function payloadSummary(payload: Record<string, unknown>): string {
  return [
    "comment",
    "bodyMarkdown",
    "summary",
    "reason",
    "answer",
    "instruction",
    "kind",
    "gate",
    "status",
  ]
    .flatMap((key) => (typeof payload[key] === "string" ? [payload[key]] : []))
    .join("; ")
    .slice(0, 700);
}

export function createSubscriptionSourceReader(deps: SubscriptionSourceDeps) {
  return async function readSource(
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
    cursor: SourceCursor,
  ): Promise<SourceReadResult> {
    if (source.kind === "notepad") {
      const notepad = await deps.notepads.find(source.id);
      if (
        !notepad ||
        (notepad.scope === "project" &&
          notepad.projectPath !== recipient.projectPath)
      ) {
        return { cursor, facts: [], missing: true };
      }
      if (cursor === null)
        return { cursor: String(notepad.revision), facts: [], missing: false };
      const previous = eventIdCursor(cursor);
      const revisions = (await deps.notepads.listRevisions(source.id))
        .filter((revision) => revision.revision > previous)
        .sort((a, b) => a.revision - b.revision);
      return {
        cursor: String(
          Math.max(
            previous,
            notepad.revision,
            ...revisions.map((revision) => revision.revision),
          ),
        ),
        missing: false,
        facts: revisions.map((revision) => ({
          occurrenceId: `${revision.id}:${revision.revision}`,
          eventKind: "notepad-content-revised",
          category: "revision" as const,
          sourceTitle: notepad.name,
          summary: `${notepad.name} was ${revision.origin === "restore" ? "restored" : "updated"} to revision ${revision.revision}.`,
          occurredAt: revision.createdAt,
          revision: String(revision.revision),
          outcome: null,
          retrievalHandle: `cctl notepad get -- ${quoteArgument(source.id)}`,
          actorConversationId: revision.authorConversationId,
        })),
      };
    }
    if (source.kind === "spec") {
      const spec = await deps.specs.findById(source.id);
      if (!spec || spec.projectPath !== recipient.projectPath)
        return { cursor, facts: [], missing: true };
      const events = deps.specEvents.findBySpecId(source.id);
      const head = events.at(-1)?.id ?? 0;
      if (cursor === null)
        return { cursor: String(head), facts: [], missing: false };
      const previous = eventIdCursor(cursor);
      const facts = events
        .filter(
          (event) =>
            event.id > previous &&
            event.event_type !== "spec-intervention-recorded",
        )
        .map((event): SourceFact => {
          const actor = eventActorSchema.parse(JSON.parse(event.actor_json));
          const payload = z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(event.payload_json));
          const kind =
            typeof payload.kind === "string" ? payload.kind : event.event_type;
          const decision =
            event.event_type.startsWith("spec-review-") ||
            event.event_type === "spec-approval-changed" ||
            event.event_type === "spec-attention-changed" ||
            /proposed|signed|approved|requested|transitioned|returned/.test(
              kind,
            );
          return {
            occurrenceId: String(event.id),
            eventKind: event.event_type,
            category:
              event.event_type === "spec-execution-changed"
                ? "outcome"
                : decision
                  ? "decision"
                  : "revision",
            sourceTitle: spec.name,
            summary: `${event.event_type}: ${payloadSummary(payload) || kind}`,
            occurredAt: event.occurred_at,
            revision:
              typeof payload.revisionId === "string"
                ? payload.revisionId
                : null,
            outcome: decision ? kind : null,
            retrievalHandle: `cctl spec status --project=${quoteArgument(projectNameFromPath(spec.projectPath))} -- ${quoteArgument(spec.slug)}`,
            actorConversationId:
              actor.kind === "agent" ? (actor.conversationId ?? null) : null,
          };
        });
      return {
        cursor: String(Math.max(previous, head)),
        facts,
        missing: false,
      };
    }
    if (source.kind === "validation") {
      const run = deps.validations.findById(source.id);
      if (!run || run.projectPath !== recipient.projectPath)
        return { cursor, facts: [], missing: true };
      const current = run.status;
      if (
        cursor === null ||
        cursor === current ||
        current === "queued" ||
        current === "running"
      )
        return { cursor: current, facts: [], missing: false };
      return {
        cursor: current,
        missing: false,
        facts: [
          {
            occurrenceId: `${run.runId}:${run.status}`,
            eventKind: "validation-completed",
            category: "outcome",
            sourceTitle: `${run.commandName} validation`,
            summary: `${run.commandName} ${run.status}${run.exitCode === null ? "" : ` (exit ${run.exitCode})`}.`,
            occurredAt: run.finishedAt ?? run.submittedAt,
            revision: null,
            outcome: run.status,
            retrievalHandle: `cctl validate status -- ${quoteArgument(run.runId)}`,
            actorConversationId: run.conversationId,
          },
        ],
      };
    }
    if (source.kind === "git_job") {
      const job = deps.jobs.getJobRecord(source.id);
      if (
        !job ||
        job.projectName !== projectNameFromPath(recipient.projectPath)
      )
        return { cursor, facts: [], missing: true };
      if (cursor === null || cursor === job.status || job.status === "running")
        return { cursor: job.status, facts: [], missing: false };
      return {
        cursor: job.status,
        missing: false,
        facts: [
          {
            occurrenceId: `${job.jobId}:${job.status}`,
            eventKind: "git-job-outcome",
            category: "outcome",
            sourceTitle: `${job.jobType} ${job.sessionName}`,
            summary: `${job.jobType} ${job.status}${job.errorMessage ? `: ${job.errorMessage.slice(0, 700)}` : "."}`,
            occurredAt: job.completedAt ?? job.startedAt,
            revision:
              job.commitHash ?? job.mergeHash ?? job.preparedSha ?? null,
            outcome: job.status,
            retrievalHandle: `git-job:${job.jobId}`,
            actorConversationId: null,
          },
        ],
      };
    }
    if (source.kind === "workflow") {
      const address = deps.queries.findWorkflowAddress(source.id);
      if (!address || address.projectPath !== recipient.projectPath)
        return { cursor, facts: [], missing: true };
      const execution =
        deps.workflows.findByExecutionId(source.id) ??
        deps.archivedWorkflows.findByExecutionId(source.id);
      if (!execution) return { cursor, facts: [], missing: true };
      if (cursor === null) {
        const latest = deps.workflowEvents.findPage(
          address.projectPath,
          address.sessionName,
          source.id,
          { limit: 1, direction: "desc" },
        ).records[0];
        return { cursor: String(latest?.id ?? 0), facts: [], missing: false };
      }
      let current = eventIdCursor(cursor);
      const facts: SourceFact[] = [];
      for (;;) {
        const page = deps.workflowEvents.findPage(
          address.projectPath,
          address.sessionName,
          source.id,
          { limit: 500, cursor: current, direction: "asc" },
        );
        for (const record of page.records) {
          current = record.id;
          const event = record.event;
          if (event.type !== "graph-workflow-boundary") continue;
          const outcome = ["completion", "halt", "abandon", "abort"].includes(
            event.boundaryKind,
          );
          facts.push({
            occurrenceId: String(record.id),
            eventKind: `${event.type}:${event.boundaryKind}`,
            category: outcome ? "outcome" : "decision",
            sourceTitle:
              execution.launchDocument?.name ?? `Workflow ${execution.id}`,
            summary: `Workflow reached ${event.boundaryKind} (${event.workflowStatus}).`,
            occurredAt: record.occurredAt,
            revision: null,
            outcome: event.workflowStatus,
            retrievalHandle: `cctl workflow status --project=${quoteArgument(projectNameFromPath(address.projectPath))} --session=${quoteArgument(address.sessionName)} -- ${quoteArgument(source.id)}`,
            actorConversationId: null,
          });
        }
        if (page.nextCursor === null) break;
      }
      return { cursor: String(current), facts, missing: false };
    }
    if (source.kind === "ticket") {
      const ticket = await deps.tickets.findById(source.id);
      if (!ticket || ticket.projectPath !== recipient.projectPath)
        return { cursor, facts: [], missing: true };
      const previous =
        cursor === null ? null : ticketCursorSchema.parse(JSON.parse(cursor));
      const changes = deps.ticketChanges.listAfter(
        source.id,
        previous?.statusId ?? deps.ticketChanges.latestId(source.id),
      );
      const posts = [];
      let pageCursor: string | undefined;
      for (;;) {
        const page = await deps.tickets.listStatusUpdates({
          ticketId: source.id,
          limit: 100,
          ...(pageCursor ? { cursor: pageCursor } : {}),
        });
        posts.push(
          ...page.items.filter(
            (post) =>
              previous === null ||
              post.createdAt > previous.postAt ||
              (post.createdAt === previous.postAt && post.id > previous.postId),
          ),
        );
        const reachedPrevious =
          previous !== null &&
          page.items.some(
            (post) =>
              post.createdAt < previous.postAt ||
              (post.createdAt === previous.postAt &&
                post.id <= previous.postId),
          );
        if (page.nextCursor === null || reachedPrevious || previous === null)
          break;
        pageCursor = page.nextCursor;
      }
      posts.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      const lastPost = posts.at(-1);
      const next = {
        statusId:
          changes.at(-1)?.id ??
          previous?.statusId ??
          deps.ticketChanges.latestId(source.id),
        postAt: lastPost?.createdAt ?? previous?.postAt ?? ticket.createdAt,
        postId: lastPost?.id ?? previous?.postId ?? "",
      };
      if (cursor === null)
        return { cursor: JSON.stringify(next), facts: [], missing: false };
      const handle = `cctl ticket get -- ${quoteArgument(`${projectNameFromPath(ticket.projectPath)}#${ticket.number}`)}`;
      const facts: SourceFact[] = changes.map((change) => ({
        occurrenceId: `status:${change.id}`,
        eventKind: "ticket-status-changed",
        category: "decision",
        sourceTitle: ticket.title,
        summary: `#${ticket.number} changed status to ${change.status}.`,
        occurredAt: change.occurredAt,
        revision: String(change.id),
        outcome: change.status,
        retrievalHandle: handle,
        actorConversationId: change.actorConversationId,
      }));
      facts.push(
        ...posts.map(
          (post): SourceFact => ({
            occurrenceId: `post:${post.id}`,
            eventKind: "ticket-status-posted",
            category: "activity",
            sourceTitle: ticket.title,
            summary: post.bodyMarkdown.slice(0, 700),
            occurredAt: post.createdAt,
            revision: null,
            outcome: null,
            retrievalHandle: handle,
            actorConversationId:
              post.author.kind === "agent" ? post.author.conversationId : null,
          }),
        ),
      );
      return { cursor: JSON.stringify(next), facts, missing: false };
    }
    return { cursor, facts: [], missing: true };
  };
}
