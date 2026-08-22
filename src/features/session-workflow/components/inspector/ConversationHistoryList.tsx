"use client";

import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import { formatInspectorTimestamp, InspectorButton } from "./chrome";
import type {
  ConversationHistoryEvent,
  ConversationHistoryRow,
} from "./conversation-history";

/**
 * History tab → conversation rows (design E3, README §10).
 *
 * The durable row is the conversation; iteration boundaries, task completions,
 * verdicts and rotations are events inside it. Each row opens its own
 * implementer transcript, and a verdict opens the transcript of the seat that
 * gave it — the two are independently reachable, which is the whole point of
 * keeping the validator link on the event rather than on the row.
 */

/** Who a transcript belongs to; the host turns this into a lane and a header. */
export type TranscriptOwner =
  | { kind: "implementer" }
  | { kind: "validator"; seat: string };

export type OpenTranscript = (
  conversationId: string,
  owner: TranscriptOwner,
) => void;

const eventLine = "font-mono text-[0.7rem] leading-[1.5]";
const eventTime = "text-text-tertiary";

/**
 * Both directions of a transition are stated as the link itself. Nothing here
 * says WHY a conversation was replaced: the execution records no rotation
 * provenance, so any cause would be a guess dressed as a fact.
 */
function endedCopy(row: ConversationHistoryRow): string {
  const reason = row.endReason;
  if (reason === null || reason.kind === "closed") return "ended";
  return `ended — superseded by ${reason.successorId}`;
}

function startedCopy(
  event: Extract<ConversationHistoryEvent, { kind: "started" }>,
): string {
  if (event.rotatedFrom === null) {
    return `started — iteration ${event.iteration}`;
  }
  return `started — took over from ${event.rotatedFrom}, iteration ${event.iteration}`;
}

function reopenedCopy(taskIds: readonly string[]): string {
  if (taskIds.length === 0) return "";
  return ` — ${taskIds.join(", ")} reopened`;
}

/** The line's words and its tone; the transcript button is added by the row. */
function eventCopy(event: ConversationHistoryEvent): {
  text: string;
  tone: string;
} {
  switch (event.kind) {
    case "started":
      return { text: startedCopy(event), tone: "text-text-secondary" };
    case "task_completed":
      return {
        text: `task completed — ${event.taskTitle}`,
        tone: "text-text-secondary",
      };
    case "verdict":
      return {
        text: `${event.seat} ${event.pass ? "passed" : "rejected"} — ${event.summary}`,
        tone: event.pass ? "text-green" : "text-red",
      };
    case "validating":
      return {
        text: `${event.seat} validating — iteration ${event.iteration}`,
        tone: "text-text-secondary",
      };
    case "iteration_began":
      return {
        text: `iteration ${event.iteration} began${reopenedCopy(event.reopenedTaskIds)}`,
        tone: "text-blue",
      };
    case "ended":
      return { text: "", tone: "text-text-tertiary" };
  }
}

function transcriptOf(
  event: ConversationHistoryEvent,
): { conversationId: string; seat: string } | null {
  if (event.kind !== "verdict" && event.kind !== "validating") return null;
  if (event.transcriptConversationId === null) return null;
  return { conversationId: event.transcriptConversationId, seat: event.seat };
}

function ConversationEventRow({
  row,
  event,
  onOpenTranscript,
}: {
  row: ConversationHistoryRow;
  event: ConversationHistoryEvent;
  onOpenTranscript?: OpenTranscript;
}): React.JSX.Element {
  const copy =
    event.kind === "ended"
      ? { text: endedCopy(row), tone: "text-text-tertiary" }
      : eventCopy(event);
  const transcript = transcriptOf(event);

  return (
    <div
      className={cn(
        eventLine,
        copy.tone,
        "flex flex-wrap items-center gap-[6px]",
      )}
      data-testid="conversation-event"
      data-event-kind={event.kind}
    >
      <span>
        <span className={eventTime}>{formatInspectorTimestamp(event.at)}</span>{" "}
        · {copy.text}
      </span>
      {transcript !== null && onOpenTranscript !== undefined && (
        <InspectorButton
          size="xs"
          ariaLabel={`Open ${transcript.seat} validator transcript`}
          testId="validator-transcript-button"
          onClick={() =>
            onOpenTranscript(transcript.conversationId, {
              kind: "validator",
              seat: transcript.seat,
            })
          }
        >
          validator transcript
        </InspectorButton>
      )}
    </div>
  );
}

/**
 * The iterations the row's own events belong to — every one of them, because a
 * conversation and an iteration are not the same span. A returning validation
 * reopens work inside the conversation already live, and a rotation carries one
 * iteration into the next conversation, so naming a single iteration on the row
 * would be a claim the events do not support.
 */
function iterationsCopy(iterations: readonly number[]): string {
  return `${iterations.length === 1 ? "iteration" : "iterations"} ${iterations.join(", ")}`;
}

function timeRange(row: ConversationHistoryRow): string {
  const started = formatInspectorTimestamp(row.startedAt);
  if (row.status === "live") return `from ${started}`;
  const ended =
    row.endedAt === null ? "" : formatInspectorTimestamp(row.endedAt);
  return ended === "" ? started : `${started} – ${ended}`;
}

export default function ConversationHistoryList({
  rows,
  onOpenTranscript,
}: {
  rows: readonly ConversationHistoryRow[];
  onOpenTranscript?: OpenTranscript;
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        This context has not opened a conversation yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-sm">
      {rows.map((row) => (
        <article
          key={row.conversationId}
          data-testid="conversation-row"
          data-conversation-id={row.conversationId}
          data-status={row.status}
          className={cn(
            "rounded-md border border-solid",
            row.status === "live"
              ? "border-[var(--cc-cyan-a25)] bg-[var(--cc-cyan-a04)]"
              : "border-border-subtle bg-transparent",
          )}
        >
          <div className="flex flex-wrap items-center gap-sm px-[11px] py-[9px]">
            <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
              {row.conversationId}
            </span>
            <StatusChip tone={row.status === "live" ? "cyan" : "neutral"}>
              {row.status}
            </StatusChip>
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              {timeRange(row)}
            </span>
            {row.iterations.length > 0 && (
              <span
                data-testid="conversation-iterations"
                className="font-mono text-[0.7rem] text-text-tertiary"
              >
                {iterationsCopy(row.iterations)}
              </span>
            )}
            {onOpenTranscript !== undefined && (
              <span className="ml-auto">
                <InspectorButton
                  ariaLabel={`Open transcript for ${row.conversationId}`}
                  testId="conversation-transcript-button"
                  onClick={() =>
                    onOpenTranscript(row.conversationId, {
                      kind: "implementer",
                    })
                  }
                >
                  Transcript
                </InspectorButton>
              </span>
            )}
          </div>
          {row.events.length > 0 && (
            <div className="mr-[11px] mb-[11px] ml-[18px] flex flex-col gap-[7px] border-0 border-l-2 border-solid border-border-default pl-[13px]">
              {row.events.map((event, index) => (
                <ConversationEventRow
                  key={`${event.kind}-${event.at}-${index}`}
                  row={row}
                  event={event}
                  {...(onOpenTranscript === undefined
                    ? {}
                    : { onOpenTranscript })}
                />
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
