import { openPlanRepairRoundFor } from "@/components/workflow-graph/derive-plan-repair-activity";
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationSpecialistEntry,
} from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * The context's history as conversations, with everything that happened inside
 * them (README §10 "Conversation-first history", design E3).
 *
 * The durable row is the CONVERSATION, not the iteration: a rotation can split
 * one iteration across two conversations, and a returning validation continues
 * one iteration inside the conversation that was already live. The two are
 * many-to-many, so a row carries the iterations its events belong to rather
 * than claiming one.
 *
 * A verdict enters the row when the SEAT reported it, not when the round
 * concluded: production publishes each cohort member's result on its own while
 * the round is still running, and republishes it inside the aggregate at the
 * end. Reading only the aggregate would leave a finished seat invisible — and
 * its transcript unreachable — for as long as its slowest colleague takes.
 *
 * Everything here is derived from what the execution already records — the
 * event stream and the runtime blob. One fact is inferred rather than read,
 * because nothing durable records it: **when a conversation ended.** A
 * conversation is retired by the one that replaces it, so a row ends where its
 * successor starts. The last row ends at its own last recorded activity, or
 * stays open when it is the lane's live conversation.
 *
 * WHY a conversation was replaced is not derived at all. The execution carries
 * no rotation provenance, and iteration adjacency cannot stand in for it: a
 * fresh implementer conversation is opened by an iteration seed that increments
 * the count in the same mutation, so a context-limit rotation and an
 * iteration-boundary rotation are indistinguishable here. A transition is
 * stated as the link it is — this row took over from that one, that one was
 * superseded by this — in both directions, and no further.
 */

export type ConversationEndReason =
  | { kind: "superseded"; successorId: string }
  | { kind: "closed"; successorId: null };

export type ConversationHistoryEvent =
  | {
      kind: "started";
      at: string;
      iteration: number;
      /** The conversation this one took over from; null for the first. */
      rotatedFrom: string | null;
    }
  | {
      kind: "task_completed";
      at: string;
      iteration: number;
      taskId: string;
      taskTitle: string;
    }
  | {
      kind: "verdict";
      at: string;
      /** The cohort seat that judged, or the check that did when no seat did. */
      seat: string;
      pass: boolean;
      summary: string;
      iteration: number;
      roundSeq: number | null;
      /** The seat's own transcript, when it rendered its verdict in one. */
      transcriptConversationId: string | null;
    }
  | {
      kind: "validating";
      at: string;
      seat: string;
      iteration: number;
      transcriptConversationId: string | null;
    }
  | {
      kind: "iteration_began";
      at: string;
      iteration: number;
      reopenedTaskIds: readonly string[];
    }
  | { kind: "ended"; at: string; reason: ConversationEndReason };

export interface ConversationHistoryRow {
  conversationId: string;
  status: "live" | "ended";
  startedAt: string;
  /** Null only while the row is live. */
  endedAt: string | null;
  endReason: ConversationEndReason | null;
  /** Every iteration this conversation hosted an event for, ascending. */
  iterations: readonly number[];
  events: readonly ConversationHistoryEvent[];
}

export interface ConversationHistoryView {
  /** Newest first, as the History tab reads them. */
  rows: readonly ConversationHistoryRow[];
}

/** A context that has settled owns no live conversation, whatever its lane holds. */
const SETTLED_CONTEXT_STATUSES = new Set(["completed", "skipped"]);

/**
 * Whether this context can still take another turn anywhere.
 *
 * The run's side of that question is the lease predicate, not a status set: a
 * status cannot see halt resumability or abandonment, so an abandoned halt and
 * a non-resumable `recovery_error` halt both read as running while their lanes
 * still name the conversations they died holding. `holdsExecutionLease` is the
 * one module allowed to decide it, and it already covers the terminal statuses
 * a set would have listed.
 */
function contextIsSettled(
  execution: GraphWorkflowExecution,
  contextId: string,
): boolean {
  const contextState = execution.contextStates[contextId];
  if (
    contextState !== undefined &&
    SETTLED_CONTEXT_STATUSES.has(contextState.status)
  ) {
    return true;
  }
  return !holdsExecutionLease(
    execution.status,
    execution.haltReason,
    execution.abandonment,
  );
}

/**
 * Whether a transcript the reader opened is still being written to.
 *
 * Any lane of the context counts, not just the implementer: a cohort seat holds
 * its own conversation, and the Log surface titles a validator transcript with
 * the same live/ended pill the History row gives the implementer. Liveness is
 * "some lane still holds it" rather than "the last event is recent" because
 * only the lane record distinguishes a conversation that has been rotated out
 * from one that is merely between turns.
 *
 * The question is asked of the CONVERSATION, never of the task that opened it.
 * One lane conversation carries several tasks, so a completed task says nothing
 * about whether its transcript is still being written to; a running task, on
 * the other hand, can name a conversation before the lane record is written,
 * which is why `resolveBoundConversationId` — the owner of "which conversation
 * is this context's implementer" — resolves it first and why it is the
 * fallback here.
 */
export function isWorkflowConversationLive(
  execution: GraphWorkflowExecution,
  contextId: string,
  conversationId: string,
): boolean {
  // Asked before the settled check, because the plan-repair agent's turn runs
  // against a HALTED context: the round is the only record of a transcript
  // still being written, and every other clause here would call it ended.
  const openRepair = openPlanRepairRoundFor(execution, contextId);
  if (openRepair?.conversationId === conversationId) return true;
  if (contextIsSettled(execution, contextId)) return false;
  const lanes = execution.laneStates[contextId];
  const heldByLane =
    lanes !== undefined &&
    Object.values(lanes).some(
      (lane) => lane.workflowConversationId === conversationId,
    );
  if (heldByLane) return true;
  return Object.values(execution.taskStates).some(
    (task) =>
      task.contextId === contextId &&
      task.status === "running" &&
      task.lastConversationId === conversationId,
  );
}

interface ConversationSpan {
  conversationId: string;
  /**
   * Where the log first names it. Position and not time: two durable writes can
   * be stamped in the same millisecond, and then only the log's order says
   * which of them happened first.
   */
  startIndex: number;
  startedAt: string;
}

/**
 * Which iteration the context was in, read off its status stream.
 *
 * Asked by log POSITION, because that is the only total order the record has: a
 * verdict and the status mark that the verdict's own rejection produced land in
 * consecutive mutations and can share a millisecond, and a reader comparing
 * timestamps would then label the round with the iteration it caused rather
 * than the one it judged.
 *
 * Exported because the round list asks the same question of the same stream: a
 * round and the conversation that hosted it must not name different iterations.
 */
export interface ContextIterationReader {
  /** The iteration in force at a position in the log. */
  atLogIndex(logIndex: number): number;
  /**
   * The iteration standing now, for runtime state — a live round, a lane
   * binding — which has no position in the log at all.
   */
  now(): number;
}

export function contextIterationReader(
  events: readonly GraphWorkflowExecutionEvent[],
  contextId: string,
  fallback: number,
): ContextIterationReader {
  const marks: { index: number; iteration: number }[] = [];
  events.forEach((entry, index) => {
    // Retired events are not part of the current attempt's timeline.
    if (entry.preReset === true) return;
    const event = entry.event;
    if (event.type !== "graph-workflow-context-status") return;
    if (event.contextId !== contextId) return;
    marks.push({ index, iteration: event.iterationCount });
  });

  const atLogIndex = (logIndex: number): number => {
    const first = marks[0];
    if (first === undefined) return Math.max(1, fallback);
    let iteration = first.iteration;
    for (const mark of marks) {
      if (mark.index > logIndex) break;
      iteration = mark.iteration;
    }
    // An iteration is 1-based to the reader: a context that has started work is
    // in its first iteration even before the engine has counted one.
    return Math.max(1, iteration);
  };

  return {
    atLogIndex,
    // Everything the log holds is behind us, which is what "now" means here.
    now: () => atLogIndex(events.length),
  };
}

/**
 * Every iteration boundary this context crossed, with the tasks the verdict
 * that caused it sent back.
 *
 * The 0→1 step is not a boundary: it is the context starting, which the first
 * conversation's `started` event already says.
 */
function iterationBoundaries(
  events: readonly GraphWorkflowExecutionEvent[],
  contextId: string,
): {
  index: number;
  at: string;
  iteration: number;
  reopenedTaskIds: string[];
}[] {
  const boundaries: {
    index: number;
    at: string;
    iteration: number;
    reopenedTaskIds: string[];
  }[] = [];
  let previous: number | null = null;
  let lastReopened: string[] = [];
  events.forEach((entry, index) => {
    if (entry.preReset) return;
    const event = entry.event;
    if (
      event.type === "graph-workflow-validation-result" &&
      event.contextId === contextId &&
      !event.pass
    ) {
      lastReopened = [...event.reopenTaskIds];
      return;
    }
    if (event.type !== "graph-workflow-context-status") return;
    if (event.contextId !== contextId) return;
    if (previous !== null && event.iterationCount > previous && previous >= 1) {
      boundaries.push({
        index,
        at: entry.occurredAt,
        iteration: event.iterationCount,
        reopenedTaskIds: lastReopened,
      });
    }
    previous = event.iterationCount;
  });
  return boundaries;
}

/** The conversations this context worked in, in the order the log names them. */
function conversationSpans(
  execution: GraphWorkflowExecution,
  events: readonly GraphWorkflowExecutionEvent[],
  contextId: string,
): ConversationSpan[] {
  const firstSeen = new Map<string, ConversationSpan>();
  events.forEach((entry, index) => {
    if (entry.preReset) return;
    const event = entry.event;
    if (event.type !== "graph-workflow-task-status") return;
    if (event.contextId !== contextId) return;
    const conversationId = event.lastConversationId;
    if (conversationId == null || conversationId === "") return;
    if (!firstSeen.has(conversationId)) {
      firstSeen.set(conversationId, {
        conversationId,
        startIndex: index,
        startedAt: entry.occurredAt,
      });
    }
  });

  // The lane's current conversation may not have completed a task yet — it is
  // still the conversation the context is working in, and the one a reader
  // most wants the transcript of. It is a binding rather than a logged row, so
  // it has a time and no place in the log; it takes the position AFTER
  // everything logged, which is where a conversation nothing has recorded yet
  // necessarily stands.
  const lane = execution.laneStates[contextId]?.implementer;
  const current = lane?.workflowConversationId;
  if (current !== undefined && !firstSeen.has(current)) {
    firstSeen.set(current, {
      conversationId: current,
      startIndex: events.length,
      startedAt: lane?.lastUsedAt ?? new Date(0).toISOString(),
    });
  }

  // Insertion order is already log order; sorted anyway so the invariant the
  // rest of this module reads off `spans` is stated where it is established.
  return [...firstSeen.values()].sort(
    (left, right) => left.startIndex - right.startIndex,
  );
}

export function deriveConversationHistory({
  execution,
  events,
  contextId,
}: {
  execution: GraphWorkflowExecution;
  events: readonly GraphWorkflowExecutionEvent[];
  contextId: string;
}): ConversationHistoryView {
  const spans = conversationSpans(execution, events, contextId);
  if (spans.length === 0) return { rows: [] };

  const contextState = execution.contextStates[contextId];
  const iterationAt = contextIterationReader(
    events,
    contextId,
    contextState?.iterationCount ?? 1,
  );
  const taskTitles = new Map(
    execution.workingDefinition.tasks.map((task) => [task.id, task.title]),
  );

  /**
   * The conversation that was live at a position in the log — for the rows that
   * name no conversation of their own (a verdict, an iteration boundary).
   *
   * By position, not by time. A rejection and the conversation opened in answer
   * to it are consecutive writes that can share a millisecond, and a reader
   * comparing timestamps would file the verdict under the conversation that
   * replaced the one it judged.
   */
  const spanAt = (logIndex: number): string => {
    let conversationId = spans[0]!.conversationId;
    for (const span of spans) {
      if (span.startIndex > logIndex) break;
      conversationId = span.conversationId;
    }
    return conversationId;
  };

  /** The live conversation: the one runtime state, having no position, is in. */
  const currentSpan = spans[spans.length - 1]!.conversationId;

  // Held with the position each event was read at, so a row's timeline is
  // ordered by the log rather than re-sorted by a timestamp that cannot break
  // its own ties. Runtime state has no position and sorts after everything
  // logged, which is where it belongs: it is what is happening now.
  interface CollectedEvent {
    logIndex: number;
    event: ConversationHistoryEvent;
  }
  const collected = new Map<string, CollectedEvent[]>(
    spans.map((span) => [span.conversationId, []]),
  );
  const push = (
    conversationId: string,
    logIndex: number,
    event: ConversationHistoryEvent,
  ) => {
    collected.get(conversationId)?.push({ logIndex, event });
  };

  // A seat's verdict is published twice: on its own the moment the seat
  // reports, and again inside the aggregate when the round concludes. The row
  // states it once, at the moment the seat actually spoke — which is also the
  // only moment a reader watching a running round has it.
  //
  // Keyed on what the verdict SAYS, not on which seat said it. A per-assignment
  // reset re-runs one seat inside the same round, so a seat can report twice
  // under one seq: two different judgements, written in two different
  // transcripts, and the second transcript is reachable only from its own
  // verdict event. Keying on (seq, seat) would drop it as a duplicate of the
  // verdict it replaced. Two publications agreeing on all four fields are the
  // same verdict restated, which is exactly the aggregate's republication.
  const statedSeatVerdicts = new Set<string>();
  const seatVerdictStated = (
    roundSeq: number | null,
    seat: GraphWorkflowValidationSpecialistEntry,
  ): boolean => {
    if (roundSeq === null) return false;
    const key = [
      roundSeq,
      seat.assignmentId,
      seat.pass,
      seat.sessionRef?.workflowConversationId ?? "",
      seat.summary,
    ].join("\u0000");
    if (statedSeatVerdicts.has(key)) return true;
    statedSeatVerdicts.add(key);
    return false;
  };

  events.forEach((entry, logIndex) => {
    if (entry.preReset) return;
    const event = entry.event;
    if (event.type === "graph-workflow-validation-specialist-result") {
      if (event.contextId !== contextId) return;
      const seat = event.specialist;
      if (seatVerdictStated(event.roundSeq, seat)) return;
      push(spanAt(logIndex), logIndex, {
        kind: "verdict",
        at: entry.occurredAt,
        seat: seat.assignmentId,
        pass: seat.pass,
        summary: seat.summary,
        iteration: iterationAt.atLogIndex(logIndex),
        roundSeq: event.roundSeq,
        transcriptConversationId:
          seat.sessionRef?.workflowConversationId ?? null,
      });
      return;
    }
    if (event.type === "graph-workflow-task-status") {
      if (event.contextId !== contextId) return;
      if (event.status !== "completed") return;
      const conversationId = event.lastConversationId ?? spanAt(logIndex);
      push(conversationId, logIndex, {
        kind: "task_completed",
        at: entry.occurredAt,
        iteration: iterationAt.atLogIndex(logIndex),
        taskId: event.taskId,
        taskTitle: taskTitles.get(event.taskId) ?? event.taskId,
      });
      return;
    }
    if (event.type === "graph-workflow-validation-result") {
      if (event.contextId !== contextId) return;
      const hosting = spanAt(logIndex);
      const iteration = iterationAt.atLogIndex(logIndex);
      const roundSeq = event.roundSeq ?? null;
      const specialists = event.specialists ?? [];
      if (specialists.length === 0) {
        // No cohort seat judged: the round-level record is the verdict, and an
        // output-schema refusal is the engine's own — neither has a validator
        // transcript to open, so none is offered.
        push(hosting, logIndex, {
          kind: "verdict",
          at: entry.occurredAt,
          seat: event.kind === "output_schema" ? "output schema" : "validation",
          pass: event.pass,
          summary: event.summary,
          iteration,
          roundSeq,
          transcriptConversationId:
            event.kind === "output_schema"
              ? null
              : (event.sessionRef?.workflowConversationId ?? null),
        });
        return;
      }
      for (const seat of specialists) {
        if (seatVerdictStated(roundSeq, seat)) continue;
        push(hosting, logIndex, {
          kind: "verdict",
          at: entry.occurredAt,
          seat: seat.assignmentId,
          pass: seat.pass,
          summary: seat.summary,
          iteration,
          roundSeq,
          transcriptConversationId:
            seat.sessionRef?.workflowConversationId ?? null,
        });
      }
    }
  });

  for (const boundary of iterationBoundaries(events, contextId)) {
    push(spanAt(boundary.index), boundary.index, {
      kind: "iteration_began",
      at: boundary.at,
      iteration: boundary.iteration,
      reopenedTaskIds: boundary.reopenedTaskIds,
    });
  }

  // The open round has no result event yet, so the seats reviewing right now
  // are read off the round record itself.
  const round = contextState?.validationRound;
  if (round != null && round.outcome === null) {
    for (const seat of round.roster) {
      const state = round.specialists[seat.assignmentId];
      if (state?.state !== "running") continue;
      // The live round is runtime state, not a log row: it has a start time and
      // no position, so it belongs to the conversation and the iteration
      // standing now rather than to any the log could be searched for.
      push(currentSpan, events.length, {
        kind: "validating",
        at: round.startedAt,
        seat: seat.assignmentId,
        iteration: iterationAt.now(),
        transcriptConversationId:
          state.sessionRef?.workflowConversationId ?? null,
      });
    }
  }

  const rows = spans.map((span, index): ConversationHistoryRow => {
    const successor = spans[index + 1];
    const own = collected.get(span.conversationId) ?? [];
    // The same owner the Log surface asks, so the row's pill and the transcript
    // header opened from it can never contradict each other — a lane record the
    // context has not written yet is exactly the moment they would.
    // A row with a successor is out either way: the conversation that replaced
    // it retired it, whatever a stale binding still names.
    const isLive =
      successor === undefined &&
      isWorkflowConversationLive(execution, contextId, span.conversationId);

    const previous = index === 0 ? null : spans[index - 1]!;
    const started: ConversationHistoryEvent = {
      kind: "started",
      at: span.startedAt,
      // The lane binding sits past the end of the log, where `atLogIndex`
      // answers with the iteration standing now — which is the iteration a
      // conversation nothing has logged yet was opened for.
      iteration: iterationAt.atLogIndex(span.startIndex),
      rotatedFrom: previous?.conversationId ?? null,
    };

    const lastOwnActivity = own.reduce<string | null>(
      (latest, { event }) =>
        latest === null || event.at > latest ? event.at : latest,
      null,
    );
    const endedAt = isLive
      ? null
      : (successor?.startedAt ?? lastOwnActivity ?? span.startedAt);
    const endReason: ConversationEndReason | null = isLive
      ? null
      : successor === undefined
        ? { kind: "closed", successorId: null }
        : { kind: "superseded", successorId: successor.conversationId };

    const middle = [...own]
      .sort((left, right) => left.logIndex - right.logIndex)
      .map(({ event }) => event);
    // Each event already carries the iteration it was recorded under, so the
    // row states the iterations its events belong to rather than deciding one.
    // `ended` is the boundary between rows, not an event of an iteration.
    const iterations = [
      ...new Set([
        started.iteration,
        ...middle.flatMap((event) =>
          "iteration" in event ? [event.iteration] : [],
        ),
      ]),
    ].sort((left, right) => left - right);

    return {
      conversationId: span.conversationId,
      status: isLive ? "live" : "ended",
      startedAt: span.startedAt,
      endedAt,
      endReason,
      iterations,
      events: [
        started,
        ...middle,
        ...(endReason === null || endedAt === null
          ? []
          : [{ kind: "ended" as const, at: endedAt, reason: endReason }]),
      ],
    };
  });

  return { rows: rows.reverse() };
}
