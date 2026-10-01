import { gitJobSourceFact } from "./git-job-source";
import { createNotepadSourceReader } from "./notepad-source";
import { createWorkflowSourceReader } from "./workflow-source";
import type { NotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import type { NotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import type { GraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
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
import type { Spec, SpecEventRow } from "@/lib/specs/schemas";
import type {
  SourceCursor,
  SourceFact,
  SourceReadResult,
  SubscriptionRecipient,
  SubscriptionSourceRef,
} from "./schemas";

export interface SubscriptionSourceDeps {
  notepads: NotepadsRepo;
  comments: NotepadCommentsRepo;
  watermarks: NotepadDeliveryWatermarksRepo;
  resultDeliveries: GraphWorkflowResultDeliveriesRepo;
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
  kind: z.enum(["human", "agent", "system"]),
  conversationId: z.string().optional(),
});

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

export function projectSpecSourceFact(input: {
  spec: Pick<Spec, "name" | "slug" | "projectPath">;
  event: SpecEventRow;
}): SourceFact {
  const { spec, event } = input;
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
    /proposed|signed|approved|requested|transitioned|returned/.test(kind);
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
      typeof payload.revisionId === "string" ? payload.revisionId : null,
    outcome: decision ? kind : null,
    retrievalHandle:
      event.event_type === "spec-review-commented"
        ? `cctl spec comments --project=${quoteArgument(projectNameFromPath(spec.projectPath))} --open -- ${quoteArgument(spec.slug)}`
        : `cctl spec status --project=${quoteArgument(projectNameFromPath(spec.projectPath))} -- ${quoteArgument(spec.slug)}`,
    actorConversationId:
      actor.kind === "agent" ? (actor.conversationId ?? null) : null,
  };
}

export function createSubscriptionSourceReader(deps: SubscriptionSourceDeps) {
  const readNotepad = createNotepadSourceReader(deps);
  const readWorkflow = createWorkflowSourceReader(deps);
  return async function readSource(
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
    cursor: SourceCursor,
  ): Promise<SourceReadResult> {
    if (source.kind === "conversation") {
      if (source.id !== recipient.conversationId)
        throw new Error(
          "Internal notices must use their own conversation source",
        );
      return { cursor: cursor ?? "0", facts: [], missing: false };
    }
    if (source.kind === "notepad")
      return readNotepad(recipient, source, cursor);
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
        .map((event) => projectSpecSourceFact({ spec, event }));
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
            occurrenceId: `one-time-terminal:validation:${run.runId}`,
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
          gitJobSourceFact(
            job,
            recipient,
            `one-time-terminal:git_job:${job.jobId}`,
          ),
        ],
      };
    }
    if (source.kind === "workflow")
      return readWorkflow(recipient, source, cursor);
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
