import { randomUUID } from "node:crypto";
import type { ControlPermits } from "@/lib/control/permits";
import type { PermitRef } from "@/lib/control/schemas";
import type { Executor, OperationState } from "@/lib/intents/executor";
import type { OwnerRef, PendingIntent } from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import type { ConversationRecordPort } from "./conversation-record";
import type {
  Grant,
  GrantRequest,
  WorkspaceAdmission,
} from "@/lib/workspace/admission";
import type { z } from "zod";
import { taskTurnRequestSchema } from "@/lib/conversation-core/turn/turn-spec";
import type { TurnExecutionOutcome } from "@/lib/conversation-core/turn/turn-result";
import {
  mailboxRequestSchema,
  seatTurnRequestSchema,
  userTurnRequestSchema,
  type InteractiveEnrollmentRecord,
  type UserTurnRequest,
  type MailboxItemRecord,
  type SeatBindingRecord,
  type SeatTurnReport,
  type SeatTurnRequest,
} from "./schemas";

/** What one admitted turn produced, before settlement records it. */
export interface CoreTurnResult {
  status: "succeeded" | "failed" | "cancelled" | "interrupted";
  finalText: string | null;
  structuredOutput: unknown;
  outputIssue: string | null;
  failure: string | null;
  /** The turn's runtime could not be confirmed stopped; its processes may still act. */
  runtimeUncollected?: string;
}

/** A live listener for one turn's progress, such as the prompt request's own event stream. */
export interface TurnStream {
  emit(event: string, data: unknown): void;
}

/** Why a mailbox item will not run; see `unstarted` for what each means for each kind of item. */
type Unstarted =
  | { why: "held"; message: string }
  | { why: "not_admitted"; reason: string; attemptId: string }
  | { why: "stopping" }
  | { why: "failed"; failure: string }
  | { why: "restart" }
  | { why: "retired" }
  | { why: "cancelled" };

const RETIRED = "The conversation was removed";
const RESTARTED_UNSENT =
  "The server restarted before this message could start, so it was not sent";

/** What a task's caller hears when its task did not start. */
function taskNotStarted(
  why: Exclude<Unstarted, { why: "restart" }>,
): TurnExecutionOutcome {
  switch (why.why) {
    case "held":
      return {
        kind: "not_started",
        reason: "configuration",
        message: why.message,
      };
    case "not_admitted":
      return { kind: "not_started", reason: "cancelled", message: why.reason };
    case "stopping":
      return {
        kind: "not_started",
        reason: "cancelled",
        message: "The server stopped before the task could start",
        interruption: { reason: "shutdown" },
      };
    case "failed":
      return {
        kind: "not_started",
        reason: "configuration",
        message: why.failure,
      };
    case "retired":
      return { kind: "not_started", reason: "cancelled", message: RETIRED };
    case "cancelled":
      return {
        kind: "not_started",
        reason: "cancelled",
        message: "The task was cancelled before it started",
      };
  }
}

/** Why a person's message did not start, as its port and its sender hear it. */
function messageNotStarted(why: Exclude<Unstarted, { why: "stopping" }>): {
  reason: string;
  endedBy: "person" | "server" | "failure";
} {
  switch (why.why) {
    case "held":
      return { reason: why.message, endedBy: "failure" };
    case "not_admitted":
      return { reason: why.reason, endedBy: "person" };
    case "failed":
      return { reason: why.failure, endedBy: "failure" };
    case "restart":
      return {
        reason: "the server restarted before it started",
        endedBy: "server",
      };
    case "retired":
      return { reason: RETIRED, endedBy: "person" };
    case "cancelled":
      return {
        reason: "The message was cancelled before it started",
        endedBy: "person",
      };
  }
}

function unstartedReport(
  conversationId: string,
  status: "failed" | "cancelled" | "interrupted",
  failure: string,
): SeatTurnReport {
  return {
    status,
    conversationId,
    finalText: null,
    structuredOutput: null,
    outputIssue: null,
    openQuestionId: null,
    failure,
  };
}

/** Dispatch for one admitted turn of an interactive conversation. */
export interface UserTurnPort {
  /** A message that will not start, and why; it settles what the message owes (a queued batch's rows, a debug turn's phase). */
  notStarted?(input: {
    conversationId: string;
    enrollment: InteractiveEnrollmentRecord;
    request: UserTurnRequest;
    cause: string;
    reason: string;
    /** Who ended it: the person's stop, the server stopping or restarting, or a failure of the core itself. */
    endedBy: "person" | "server" | "failure";
  }): Promise<void> | void;
  run(input: {
    conversationId: string;
    enrollment: InteractiveEnrollmentRecord;
    request: UserTurnRequest;
    attemptId: string;
    signal: AbortSignal;
    stream: TurnStream | null;
  }): Promise<CoreTurnResult>;
}

/** Why work cannot start on a conversation now. */
export interface AdmissionRefusal {
  code: "not_enrolled" | "stopping" | HoldRefusal["code"];
  message: string;
}

export type UserMessageAdmission =
  | { kind: "accepted"; cause: string; settled: Promise<SeatTurnReport> }
  | ({ kind: "refused" } & AdmissionRefusal);

/** Who holds a conversation's slot for exclusive maintenance (design §4.9). */
export type HoldHolder =
  | { kind: "checkpoint"; requestId: string }
  | { kind: "debug_command" }
  | { kind: "collaboration_claim" };

/** An exclusive lease on a conversation's slot; `signal` aborts when the server stops or the conversation goes away. */
export type HoldAcquisition =
  | { kind: "held"; signal: AbortSignal; release(): void }
  | { kind: "busy"; reason: string };

/**
 * What asks to start on a conversation: a person's message, a delivery from
 * its message queue, a workflow's task, a conversation command, or a claim (a
 * collaboration taking it over).
 */
export type HoldTurn = "message" | "delivery" | "task" | "command" | "claim";

/** An owner's durable holds on conversations, read before work starts. */
export interface HoldSource {
  /**
   * Null when work of this kind may start. `betweenTurns` says no turn runs
   * now (the caller holds the conversation between two turns), so what an
   * earlier turn left behind may be repaired before the answer.
   */
  refusal(
    conversationId: string,
    turn: HoldTurn,
    options?: { betweenTurns: boolean },
  ): Promise<HoldRefusal | null>;
}

/** A durable hold another owner keeps (a checkpoint in progress, a collaboration's claim). */
export interface HoldRefusal {
  /**
   * `owned`: a collaboration owns the conversation's turns; `busy`: a turn or
   * maintenance is in progress; `queue_review`: queued deliveries await the
   * person's review; `debug_mode`: debug mode holds everything but messages.
   */
  code: "busy" | "owned" | "queue_review" | "debug_mode";
  message: string;
}

/** A workflow's task turn (a commit message, a merge's conflict resolution) on an interactive conversation. */
export type TaskTurn = z.output<typeof taskTurnRequestSchema>;

/** Dispatch for one admitted task turn: the AgentCall task protocol in the conversation's own session. */
export interface TaskTurnPort {
  run(input: {
    conversationId: string;
    enrollment: InteractiveEnrollmentRecord;
    request: TaskTurn;
    attemptId: string;
    signal: AbortSignal;
  }): Promise<{ result: CoreTurnResult; outcome: TurnExecutionOutcome }>;
}

/** Runtime binding and dispatch for one admitted seat turn. */
export interface SeatTurnPort {
  run(input: {
    conversationId: string;
    binding: SeatBindingRecord;
    request: SeatTurnRequest;
    attemptId: string;
    signal: AbortSignal;
  }): Promise<CoreTurnResult>;
}

export interface ConversationCoreDeps {
  transaction<T>(fn: () => T): T;
  repo: ConversationCoreRepo;
  permits: ControlPermits;
  admission: WorkspaceAdmission;
  /**
   * The worktree an enrolled conversation's turns write in. An interactive
   * turn holds it for interactive writes, which conflict only with Git and
   * publication operations there: those wait for the turn, and the turn waits
   * for them. Without it, interactive turns take no grant.
   */
  interactiveWorktree?(
    enrollment: InteractiveEnrollmentRecord,
  ): Promise<string | null>;
  createSeatConversation(input: {
    projectPath: string;
    sessionName: string;
    role: "implementer" | "reviewer";
    request: SeatTurnRequest;
  }): Promise<string>;
  turns: SeatTurnPort;
  userTurns: UserTurnPort;
  taskTurns: TaskTurnPort;
  /** The conversation row: a turn the last process left running, and the question a stop withdraws. */
  records: Pick<
    ConversationRecordPort,
    | "recordInterrupted"
    | "recordWithdrawn"
    | "hasPendingQuestion"
    | "withdrawQuestion"
    | "claimTurn"
    | "endClaim"
  >;
  /**
   * Model capacity: waits in line (first come, first served, shared with every
   * other turn) and resolves with the release; rejects when `signal` aborts.
   */
  slots: {
    acquire(label: string, signal: AbortSignal): Promise<() => void>;
  };
  questions: {
    openedDuring(conversationId: string, attemptId: string): string | null;
  };
  touchRequester(owner: OwnerRef): void;
  /** An interactive conversation has nothing left to run: its message queue may hold the next turn. */
  onConversationIdle?(conversationId: string): void;
  /** Durable holds other owners keep; null when work of this kind may start. */
  holds?: HoldSource;
  now(): string;
  /** How often a blocked acquisition re-checks its permit; permits carry no change signal. */
  permitPollMs?: number;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * The Conversation core for supervised seats and enrolled interactive
 * conversations. Every requested turn enters the mailbox; one turn lifetime
 * per conversation selects it, opens an attempt, acquires its permit, model
 * capacity and workspace grant, runs it, and settles it through the single
 * terminal recorder.
 */
export interface ConversationCore extends Executor {
  /** Server stop: aborts running turns as interrupted and waits for them to settle. */
  shutdown(): Promise<void>;
  /**
   * Boot: admitted attempts settle as interrupted and their conversations
   * return to idle with a notice; unadmitted ones return to the queue.
   */
  recover(): Promise<void>;
  /** Resolves once no turn is running or waiting to start. */
  idle(): Promise<void>;
  seatBinding(conversationId: string): SeatBindingRecord | null;
  /**
   * A person's message to an enrolled interactive conversation. While a turn
   * runs the message is refused as busy: input sent meanwhile belongs on the
   * conversation's message queue, which hands it over once the turn ends.
   */
  sendUserMessage(
    input: { conversationId: string; stream?: TurnStream } & Omit<
      UserTurnRequest,
      "kind"
    >,
  ): Promise<UserMessageAdmission>;
  /**
   * Stops the conversation's turn, running or still acquiring. `settled`
   * resolves when that turn has ended; anything queued behind it still runs.
   */
  stopConversation(conversationId: string): {
    requested: boolean;
    settled: Promise<void>;
  };
  /** The conversation is going away: what waits is withdrawn, what runs is stopped, and it runs nothing more. */
  retireConversation(conversationId: string): Promise<void>;
  /** Resolves once the conversation runs no turn and has none waiting to start. */
  conversationIdle(conversationId: string): Promise<void>;
  /** The conversation runs a turn or has one waiting to start. */
  isBusy(conversationId: string): boolean;
  /**
   * Whether work of this kind may start now, by the same rules every entry
   * uses: the server, enrollment, maintenance, a running turn (which holds
   * everything but a task, which waits its turn) and the durable holds.
   */
  admission(
    conversationId: string,
    turn: HoldTurn,
  ): Promise<AdmissionRefusal | null>;
  /**
   * A workflow's task turn on an enrolled conversation, run in the
   * conversation's own turn order (after a turn already running). Resolves with
   * its outcome; the caller's cancellation withdraws or stops it.
   */
  runTask(input: {
    conversationId: string;
    turn: TaskTurn;
    signal?: AbortSignal;
  }): Promise<TurnExecutionOutcome>;
  /** The attempt a conversation is running now, for questions it asks. */
  runningAttempt(conversationId: string): string | null;
  /**
   * Whether the conversation's running seat turn may ask its owner, as its own
   * request says: only a turn whose settlement waits for the answer may.
   */
  runningSeatMayAsk(conversationId: string): boolean;
  /**
   * Runs `work` (a debug command) only while the conversation runs and waits
   * for nothing, holding new turns off until it is done; the conversation's
   * idle hook runs afterwards.
   */
  whileIdle<T>(
    conversationId: string,
    work: () => Promise<T>,
    holder?: HoldHolder,
    /** `holds`: the durable holds to ask first, as this kind of work (none when absent). */
    options?: { holds?: HoldTurn },
  ): Promise<{ kind: "ran"; value: T } | { kind: "busy"; reason?: string }>;
  /**
   * Exclusive maintenance on the conversation's slot (design §4.9):
   * synchronous, refused while a turn runs or waits. Until released, no
   * message, task or command starts, and the conversation reads as busy.
   */
  hold(conversationId: string, holder: HoldHolder): HoldAcquisition;
  /** The request of the conversation's latest message turn, as a new message (no queue delivery), or null. */
  lastMessageRequest(conversationId: string): UserTurnRequest | null;
}

/** Read at call time: a signal can abort across an await. */
function wasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

type Acquired =
  | { kind: "admitted"; grant: Grant | null; releaseSlot: () => void }
  | { kind: "not_admitted"; reason: string }
  /** The workspace is held for processes that could not be confirmed stopped; waiting would never end. */
  | { kind: "blocked"; reason: string };

/** The grant the request names, held by this turn while it runs. */
function grantFor(
  request: SeatTurnRequest,
  holder: string,
): GrantRequest | null {
  const { worktreePath, grant } = request.workspace;
  if (grant === null) return null;
  return {
    worktree: worktreePath,
    kind: grant.kind,
    ...(grant.paths !== undefined ? { paths: grant.paths } : {}),
    holder,
  };
}

export function createConversationCore(
  deps: ConversationCoreDeps,
): ConversationCore {
  const runners = new Map<string, Promise<void>>();
  const rerun = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const runningAttempts = new Map<string, string>();
  /** Whether each running seat turn may ask its owner, from its own request. */
  const runningSeatAsks = new Map<string, boolean>();
  /** Set at server stop: no new turn starts; queued work waits for the next boot. */
  let stopping = false;
  /** The mailbox cause each conversation is running or acquiring for now, for stop. */
  const activeCauses = new Map<string, string>();
  /** Live listeners and settlement waiters of a person's messages, by cause. */
  const streams = new Map<string, TurnStream>();
  const waiters = new Map<string, (report: SeatTurnReport) => void>();
  /** Callers waiting on a task turn's outcome, by cause, and the outcomes its port produced. */
  const taskWaiters = new Map<
    string,
    (outcome: TurnExecutionOutcome) => void
  >();
  const taskOutcomes = new Map<string, TurnExecutionOutcome>();
  const pollMs = deps.permitPollMs ?? 1000;
  /** Conversations going away: they start nothing more. */
  const retired = new Set<string>();
  /** Items answered as never starting whose mailbox removal failed: they never run (see `leaveMailbox`). */
  const unremoved = new Set<string>();
  /** Resolves when each running or acquiring turn has ended, by cause. */
  const turnsEnded = new Map<string, Promise<void>>();
  /** Grants kept for turns whose processes could not be confirmed stopped, by holder, with the reason. */
  const quarantined = new Map<string, string>();

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Waits for a workspace change or the poll interval, leaving no listener behind. */
  async function waitForGrantChange(signal: AbortSignal): Promise<void> {
    const wait = new AbortController();
    const forward = () => wait.abort();
    signal.addEventListener("abort", forward, { once: true });
    try {
      await Promise.race([
        deps.admission.waitForChange(wait.signal),
        sleep(pollMs, wait.signal),
      ]);
    } finally {
      wait.abort();
      signal.removeEventListener("abort", forward);
    }
  }

  /**
   * Permit, model capacity and workspace grant, together. Capacity is waited
   * for in line with every other turn; the grant is only ever tried, so a turn
   * never holds capacity while waiting for a grant or a grant while waiting
   * for capacity.
   */
  async function acquire(
    item: MailboxItemRecord,
    grantRequest: GrantRequest | null,
    signal: AbortSignal,
  ): Promise<Acquired> {
    const permitOf = (): PermitRef | null =>
      deps.repo.getMailbox(item.cause)?.permit ?? item.permit;
    for (;;) {
      if (stopping)
        return { kind: "not_admitted", reason: "the server is stopping" };
      if (signal.aborted)
        return { kind: "not_admitted", reason: "cancelled before admission" };
      if (!deps.permits.admits(permitOf()))
        return { kind: "not_admitted", reason: "the permit is closed" };
      let releaseSlot: () => void;
      try {
        releaseSlot = await deps.slots.acquire(
          `turn:${item.conversationId}`,
          signal,
        );
      } catch (error) {
        if (signal.aborted)
          return { kind: "not_admitted", reason: "cancelled before admission" };
        // A capacity wait can time out; the turn keeps its intent and tries again.
        deps.log.warn("conversation_core.capacity_wait_failed", {
          conversationId: item.conversationId,
          cause: item.cause,
          error: getErrorMessage(error),
        });
        continue;
      }
      const grant =
        grantRequest === null ? null : deps.admission.tryAcquire(grantRequest);
      if (grantRequest !== null && grant === null) {
        releaseSlot();
        const stuck = deps.admission
          .blockers(grantRequest)
          .find((blocker) => quarantined.has(blocker.holder));
        if (stuck !== undefined) {
          return {
            kind: "blocked",
            reason: `The workspace is held for an earlier turn whose agent processes could not be confirmed stopped (${quarantined.get(stuck.holder) ?? "unknown"}); restart the server once they are gone`,
          };
        }
        await waitForGrantChange(signal);
        continue;
      }
      // Re-check the permit at the moment of admission, with the bundle in hand.
      if (stopping || !deps.permits.admits(permitOf())) {
        releaseSlot();
        if (grant !== null) deps.admission.release(grant);
        return {
          kind: "not_admitted",
          reason: stopping ? "the server is stopping" : "the permit is closed",
        };
      }
      return { kind: "admitted", grant, releaseSlot };
    }
  }

  async function ensureSeat(
    request: SeatTurnRequest,
  ): Promise<SeatBindingRecord> {
    const { seat, workspace } = request;
    const existing = deps.repo.findSeat(
      seat.contextId,
      seat.assignmentId,
      seat.replacement,
    );
    if (existing !== null) return existing;
    const conversationId = await deps.createSeatConversation({
      projectPath: workspace.projectPath,
      sessionName: workspace.sessionName,
      role: seat.role,
      request,
    });
    deps.transaction(() =>
      deps.repo.insertSeat({
        conversationId,
        contextId: seat.contextId,
        assignmentId: seat.assignmentId,
        replacement: seat.replacement,
        role: seat.role,
        projectPath: workspace.projectPath,
        sessionName: workspace.sessionName,
        backend: seat.assignment.backend,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      }),
    );
    const created = deps.repo.findSeat(
      seat.contextId,
      seat.assignmentId,
      seat.replacement,
    );
    if (created === null)
      throw new Error(
        `Seat ${seat.contextId}/${seat.assignmentId} was not recorded`,
      );
    return created;
  }

  /** The single terminal recorder for an opened attempt. */
  function settleAttempt(
    item: MailboxItemRecord,
    attemptId: string,
    result: CoreTurnResult,
  ): SeatTurnReport {
    const report: SeatTurnReport = {
      status: result.status,
      conversationId: item.conversationId,
      finalText: result.finalText,
      structuredOutput: result.structuredOutput,
      outputIssue: result.outputIssue,
      openQuestionId: deps.questions.openedDuring(
        item.conversationId,
        attemptId,
      ),
      failure: result.failure,
    };
    deps.transaction(() => {
      deps.repo.settleAttempt(attemptId, report, deps.now());
      deps.repo.consumeMailbox(item.cause, attemptId, deps.now());
    });
    return report;
  }

  function resolveWaiters(cause: string, report: SeatTurnReport): void {
    const resolve = waiters.get(cause);
    waiters.delete(cause);
    resolve?.(report);
  }

  function resolveTask(cause: string, outcome: TurnExecutionOutcome): void {
    const resolve = taskWaiters.get(cause);
    taskWaiters.delete(cause);
    taskOutcomes.delete(cause);
    resolve?.(outcome);
  }

  /** The interactive-write grant an enrolled conversation's turn holds on its worktree, if it has one. */
  async function interactiveGrant(
    enrollment: InteractiveEnrollmentRecord,
    holder: string,
  ): Promise<GrantRequest | null> {
    const worktree = await deps.interactiveWorktree?.(enrollment);
    return worktree === undefined || worktree === null
      ? null
      : { worktree, kind: "interactive_write", holder };
  }

  /** The turn a mailbox item asks for: a seat's work order, a person's message or a workflow's task. */
  function turnOf(item: MailboxItemRecord):
    | { kind: "seat"; request: SeatTurnRequest; grant: GrantRequest | null }
    | {
        kind: "user";
        request: UserTurnRequest;
        enrollment: InteractiveEnrollmentRecord;
      }
    | {
        kind: "task";
        request: TaskTurn;
        enrollment: InteractiveEnrollmentRecord;
      } {
    const request = mailboxRequestSchema.parse(item.request);
    if (request.kind !== "user_message" && request.kind !== "task_run")
      return { kind: "seat", request, grant: grantFor(request, item.cause) };
    const enrollment = deps.repo.getInteractive(item.conversationId);
    if (enrollment === null)
      throw new Error(
        `Conversation ${item.conversationId} is not run by the core`,
      );
    return request.kind === "user_message"
      ? { kind: "user", request, enrollment }
      : { kind: "task", request, enrollment };
  }

  /**
   * Removes an item that will not run. When the removal fails the item still
   * never runs: selection tries again instead, and until a removal (or the next
   * boot's recovery) succeeds it holds its conversation.
   */
  function leaveMailbox(cause: string, conversationId: string): void {
    try {
      deps.transaction(() => deps.repo.deleteMailbox(cause));
      unremoved.delete(cause);
    } catch (error) {
      unremoved.add(cause);
      deps.log.error("conversation_core.mailbox_withdraw_failed", {
        conversationId,
        cause,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * What happens to a mailbox item that will not run, decided in one place by
   * why and by what it carries. "Told" means its port settles what the message
   * owes (a queued batch's rows, a debug turn's phase); "handed back" means the
   * person gets the message back for review, with the reason.
   *
   * | why          | task (its caller)    | person's direct message            | queued batch                  | seat work order    |
   * | held         | removed, not started | told, handed back, removed, failed | told, removed, failed         | stays queued       |
   * | not_admitted | removed, cancelled   | told, consumed, cancelled          | told, removed, cancelled      | stays queued       |
   * | stopping     | stays, cancelled     | stays, interrupted                 | stays, interrupted            | stays queued       |
   * | failed       | removed, not started | told, removed, failed              | told, removed, failed         | stays queued       |
   * | restart      | removed              | told, handed back, removed         | told (to send again), removed | stays queued       |
   * | retired      | removed, cancelled   | removed, cancelled                 | removed, cancelled            | removed, cancelled |
   * | cancelled    | removed, cancelled   | told, removed, cancelled           | told, removed, cancelled      | stays queued       |
   *
   * Only a task's caller cancels; a server stop answers the tasks still waiting
   * behind another turn as `stopping` does, and what stays is the next boot's to
   * dispose of. An item no schema reads is removed whatever the reason, except
   * at a stop. Outside this table, a requester's `withdraw` removes its seat
   * order, and work whose workspace is quarantined ends as a failed attempt.
   *
   * A seat's work order waits for its requester to submit it again under a
   * fresh permit. A person's message is told and handed back before its
   * mailbox copy goes, so a crash in between does that again rather than
   * losing it.
   */
  async function unstarted(
    item: { cause: string; conversationId: string; request: unknown },
    why: Unstarted,
  ): Promise<void> {
    const { cause, conversationId } = item;
    const parsed = mailboxRequestSchema.safeParse(item.request);
    if (!parsed.success) {
      // Nothing can ever run it; left queued, it would hold its conversation for good.
      deps.log.error("conversation_core.mailbox_item_unreadable", {
        conversationId,
        cause,
        why: why.why,
      });
      if (why.why !== "stopping") leaveMailbox(cause, conversationId);
      return;
    }
    const request = parsed.data;
    if (request.kind === "task_run") {
      if (why.why !== "stopping") leaveMailbox(cause, conversationId);
      // After a restart, its caller went with the process.
      if (why.why !== "restart") resolveTask(cause, taskNotStarted(why));
      return;
    }
    if (request.kind !== "user_message") {
      if (why.why !== "retired") return;
      leaveMailbox(cause, conversationId);
      resolveWaiters(
        cause,
        unstartedReport(conversationId, "cancelled", RETIRED),
      );
      return;
    }
    if (why.why === "stopping") {
      // The mailbox keeps the only copy: the next boot hands it back to its owner
      // (a direct message to its sender for review, a queued batch to the queue).
      resolveWaiters(
        cause,
        unstartedReport(
          conversationId,
          "interrupted",
          "The server stopped before this message could start",
        ),
      );
      return;
    }
    streams.delete(cause);
    const { reason, endedBy } = messageNotStarted(why);
    const direct = request.queuedDelivery === undefined;
    const enrollment = deps.repo.getInteractive(conversationId);
    if (enrollment !== null && why.why !== "retired") {
      // Settled before the mailbox copy goes: a queued batch the queue still holds as
      // delivering would otherwise block it until restart.
      await settleNotStarted(item, enrollment, request, reason, endedBy);
      if (direct && (why.why === "held" || why.why === "restart")) {
        await deps.records
          .recordWithdrawn(
            {
              projectPath: enrollment.projectPath,
              storeSessionName: enrollment.sessionName,
              conversationId,
            },
            {
              cause,
              request,
              reason: why.why === "held" ? why.message : RESTARTED_UNSENT,
            },
          )
          .catch((error: unknown) =>
            deps.log.error("conversation_core.withdrawn_message_lost", {
              conversationId,
              error: getErrorMessage(error),
            }),
          );
      }
    }
    // A direct message stopped before admission stays on record as consumed (a debug retry sends it again).
    if (why.why === "not_admitted" && direct)
      deps.transaction(() =>
        deps.repo.consumeMailbox(cause, why.attemptId, deps.now()),
      );
    else leaveMailbox(cause, conversationId);
    if (why.why === "restart") return;
    resolveWaiters(
      cause,
      unstartedReport(
        conversationId,
        why.why === "held" || why.why === "failed" ? "failed" : "cancelled",
        reason,
      ),
    );
  }

  async function settleNotStarted(
    item: { cause: string; conversationId: string },
    enrollment: InteractiveEnrollmentRecord,
    request: UserTurnRequest,
    reason: string,
    endedBy: "person" | "server" | "failure",
  ): Promise<void> {
    await Promise.resolve(
      deps.userTurns.notStarted?.({
        conversationId: item.conversationId,
        enrollment,
        request,
        cause: item.cause,
        reason,
        endedBy,
      }),
    ).catch((error: unknown) =>
      deps.log.error("conversation_core.not_started_settle_failed", {
        conversationId: item.conversationId,
        cause: item.cause,
        error: getErrorMessage(error),
      }),
    );
  }

  /** One turn lifetime: every exit after `open` records exactly one terminal. */
  async function runTurn(
    item: MailboxItemRecord,
  ): Promise<"settled" | "not_admitted"> {
    if (unremoved.has(item.cause)) {
      leaveMailbox(item.cause, item.conversationId);
      return "not_admitted";
    }
    const turn = turnOf(item);
    if (turn.kind === "task" && deps.holds !== undefined) {
      // Its turn has come: the turn before it may have left a hold (a lost checkpoint continuation).
      const held = await deps.holds.refusal(item.conversationId, "task", {
        betweenTurns: true,
      });
      if (held !== null) {
        await unstarted(item, { why: "held", message: held.message });
        return "not_admitted";
      }
      // Its caller, a retirement or a stop may have withdrawn it during the read (answering it already).
      if (
        deps.repo.getMailbox(item.cause)?.state !== "queued" ||
        unremoved.has(item.cause) ||
        retired.has(item.conversationId) ||
        stopping
      ) {
        return "not_admitted";
      }
    }
    if (
      turn.kind === "user" &&
      turn.request.queuedDelivery === undefined &&
      deps.holds !== undefined
    ) {
      // A direct message admitted alongside another turn waited behind it, which may have left
      // something for the person to review first; the queue decides for its own deliveries.
      const held = await deps.holds.refusal(item.conversationId, "message", {
        betweenTurns: true,
      });
      if (held !== null) {
        await unstarted(item, { why: "held", message: held.message });
        return "not_admitted";
      }
      if (
        deps.repo.getMailbox(item.cause)?.state !== "queued" ||
        unremoved.has(item.cause) ||
        retired.has(item.conversationId) ||
        stopping
      ) {
        return "not_admitted";
      }
    }
    const attemptId = randomUUID();
    deps.transaction(() =>
      deps.repo.insertAttempt({
        attemptId,
        conversationId: item.conversationId,
        cause: item.cause,
        state: "open",
        outcome: null,
        openedAt: deps.now(),
        settledAt: null,
      }),
    );
    const controller = new AbortController();
    controllers.set(item.cause, controller);
    activeCauses.set(item.conversationId, item.cause);
    let endTurn: () => void = () => {};
    turnsEnded.set(
      item.cause,
      new Promise<void>((resolve) => (endTurn = resolve)),
    );
    // An interactive conversation shows running from here, while its turn may
    // still wait for model capacity: its person's next message is queued, not refused.
    const claimed =
      turn.kind === "seat"
        ? null
        : {
            projectPath: turn.enrollment.projectPath,
            storeSessionName: turn.enrollment.sessionName,
            conversationId: item.conversationId,
          };
    if (claimed !== null) {
      await deps.records.claimTurn(claimed).catch((error: unknown) =>
        deps.log.error("conversation_core.claim_failed", {
          conversationId: item.conversationId,
          error: getErrorMessage(error),
        }),
      );
    }
    try {
      const grantRequest =
        turn.kind === "seat"
          ? turn.grant
          : await interactiveGrant(turn.enrollment, item.cause);
      const acquired = await acquire(item, grantRequest, controller.signal);
      if (acquired.kind === "blocked") {
        resolveWaiters(
          item.cause,
          settleAttempt(item, attemptId, {
            status: "failed",
            finalText: null,
            structuredOutput: null,
            outputIssue: null,
            failure: acquired.reason,
          }),
        );
        if (item.requester !== null) deps.touchRequester(item.requester);
        return "settled";
      }
      if (acquired.kind === "not_admitted") {
        deps.transaction(() =>
          deps.repo.settleAttempt(
            attemptId,
            { notAdmitted: acquired.reason },
            deps.now(),
          ),
        );
        // A person's message has no permit to reopen: stopped before it began, it
        // is withdrawn, and its port settles what it owes (such as queue rows).
        await unstarted(
          item,
          stopping || controller.signal.reason === "shutdown"
            ? { why: "stopping" }
            : { why: "not_admitted", reason: acquired.reason, attemptId },
        );
        return "not_admitted";
      }
      deps.transaction(() => deps.repo.admitAttempt(attemptId));
      runningAttempts.set(item.conversationId, attemptId);
      if (turn.kind === "seat")
        runningSeatAsks.set(item.conversationId, turn.request.seat.canAsk);
      let result: CoreTurnResult;
      try {
        if (turn.kind === "user") {
          result = await deps.userTurns.run({
            conversationId: item.conversationId,
            enrollment: turn.enrollment,
            request: turn.request,
            attemptId,
            signal: controller.signal,
            stream: streams.get(item.cause) ?? null,
          });
        } else if (turn.kind === "task") {
          const ran = await deps.taskTurns.run({
            conversationId: item.conversationId,
            enrollment: turn.enrollment,
            request: turn.request,
            attemptId,
            signal: controller.signal,
          });
          taskOutcomes.set(item.cause, ran.outcome);
          result = ran.result;
        } else {
          const binding = deps.repo.getSeat(item.conversationId);
          if (binding === null)
            throw new Error(
              `Seat conversation ${item.conversationId} has no binding`,
            );
          result = await deps.turns.run({
            conversationId: item.conversationId,
            binding,
            request: turn.request,
            attemptId,
            signal: controller.signal,
          });
        }
      } catch (error) {
        result = {
          status: !controller.signal.aborted
            ? "failed"
            : controller.signal.reason === "shutdown"
              ? "interrupted"
              : "cancelled",
          finalText: null,
          structuredOutput: null,
          outputIssue: null,
          failure: getErrorMessage(error),
        };
      } finally {
        runningAttempts.delete(item.conversationId);
        runningSeatAsks.delete(item.conversationId);
        acquired.releaseSlot();
      }
      if (result.runtimeUncollected !== undefined) {
        // Processes that may still write keep the workspace they were granted;
        // a conflicting turn waits rather than run beside them.
        deps.log.error("conversation_core.runtime_uncollected", {
          conversationId: item.conversationId,
          cause: item.cause,
          grantHeld: acquired.grant !== null,
          error: result.runtimeUncollected,
        });
        if (acquired.grant !== null)
          quarantined.set(item.cause, result.runtimeUncollected);
        if (result.status === "succeeded") {
          result = {
            ...result,
            status: "failed",
            failure: `The agent's processes could not be confirmed stopped: ${result.runtimeUncollected}`,
          };
        }
      } else if (acquired.grant !== null) {
        deps.admission.release(acquired.grant);
      }
      resolveWaiters(item.cause, settleAttempt(item, attemptId, result));
      if (turn.kind === "task") {
        resolveTask(
          item.cause,
          taskOutcomes.get(item.cause) ?? {
            kind: "not_started",
            reason: "configuration",
            message: result.failure ?? "The task did not run",
          },
        );
      }
      if (item.requester !== null) deps.touchRequester(item.requester);
      return "settled";
    } finally {
      controllers.delete(item.cause);
      activeCauses.delete(item.conversationId);
      streams.delete(item.cause);
      turnsEnded.delete(item.cause);
      if (claimed !== null) {
        await deps.records.endClaim(claimed).catch((error: unknown) =>
          deps.log.error("conversation_core.claim_end_failed", {
            conversationId: item.conversationId,
            error: getErrorMessage(error),
          }),
        );
      }
      endTurn();
    }
  }

  async function drainConversation(conversationId: string): Promise<void> {
    for (;;) {
      if (stopping) return;
      rerun.delete(conversationId);
      const item = deps.repo.nextQueued(conversationId);
      if (item === null) return;
      const result = await runTurn(item).catch(async (error: unknown) => {
        deps.log.error("conversation_core.turn_failed", {
          conversationId,
          cause: item.cause,
          error: getErrorMessage(error),
        });
        // Its turn failed before it could settle: nothing resubmits a person's message or a task.
        await unstarted(item, {
          why: "failed",
          failure: getErrorMessage(error),
        });
        return "not_admitted" as const;
      });
      // An unadmitted item still queued waits for a resubmission under a fresh
      // permit; one that left the mailbox (withdrawn or abandoned) makes way for the next.
      if (
        result === "not_admitted" &&
        !rerun.has(conversationId) &&
        deps.repo.getMailbox(item.cause)?.state === "queued"
      )
        return;
    }
  }

  /** Conversations held for exclusive maintenance, with what to tell their holder when they must stop. */
  const leases = new Map<
    string,
    { holder: HoldHolder; controller: AbortController }
  >();
  /** Bumped by every lease, so an admission that read the holds can tell a claim came and went meanwhile. */
  const leaseEpochs = new Map<string, number>();

  function hold(conversationId: string, holder: HoldHolder): HoldAcquisition {
    if (stopping) return { kind: "busy", reason: "The server is stopping" };
    if (
      retired.has(conversationId) ||
      deps.repo.getInteractive(conversationId) === null
    ) {
      return {
        kind: "busy",
        reason: `Conversation ${conversationId} is not run by the core`,
      };
    }
    if (
      runners.has(conversationId) ||
      deps.repo.nextQueued(conversationId) !== null
    ) {
      return {
        kind: "busy",
        reason:
          "The conversation is running a turn or has one waiting to start",
      };
    }
    const controller = new AbortController();
    leaseEpochs.set(conversationId, (leaseEpochs.get(conversationId) ?? 0) + 1);
    let release: () => void = () => {};
    // Registered as the conversation's runner: a message, a task or a wake meanwhile finds it busy.
    const runner = new Promise<void>((resolve) => (release = resolve));
    runners.set(conversationId, runner);
    leases.set(conversationId, { holder, controller });
    void runner.then(() => {
      if (runners.get(conversationId) !== runner) return;
      runners.delete(conversationId);
      leases.delete(conversationId);
      if (rerun.has(conversationId)) wake(conversationId);
      else if (
        !stopping &&
        !retired.has(conversationId) &&
        deps.repo.getInteractive(conversationId) !== null
      )
        deps.onConversationIdle?.(conversationId);
    });
    deps.log.info("conversation_core.hold_acquired", {
      conversationId,
      holder: holder.kind,
    });
    return { kind: "held", signal: controller.signal, release };
  }

  /**
   * The durable holds' answer for new work, fenced against leases: a claim
   * that began and ended while the read was pending (taking the conversation
   * durably) makes the read start over. `local` re-checks what the core
   * itself knows after each read.
   */
  async function readHolds(
    conversationId: string,
    turn: HoldTurn,
    local: () => Extract<UserMessageAdmission, { kind: "refused" }> | null,
  ): Promise<Extract<UserMessageAdmission, { kind: "refused" }> | null> {
    if (deps.holds === undefined) return local();
    for (let read = 0; read < 3; read += 1) {
      const epoch = leaseEpochs.get(conversationId) ?? 0;
      const held = await deps.holds.refusal(conversationId, turn);
      if (held !== null)
        return { kind: "refused", code: held.code, message: held.message };
      const since = local();
      if (since !== null) return since;
      if ((leaseEpochs.get(conversationId) ?? 0) === epoch) return null;
    }
    return {
      kind: "refused",
      code: "busy",
      message: "The conversation is being taken over; try again",
    };
  }

  /**
   * The in-process reasons work of this kind cannot start now, apart from
   * the durable holds. A running turn holds everything back but a task, which
   * waits its turn; maintenance (a lease) holds everything.
   */
  function localRefusal(
    conversationId: string,
    turn: HoldTurn,
  ): AdmissionRefusal | null {
    if (stopping)
      return {
        code: "stopping",
        message: "The server is stopping; try again once it is back",
      };
    if (
      deps.repo.getInteractive(conversationId) === null ||
      retired.has(conversationId)
    ) {
      return {
        code: "not_enrolled",
        message: `Conversation ${conversationId} is not run by the core`,
      };
    }
    if (leases.has(conversationId))
      return {
        code: "busy",
        message: "The conversation is held for maintenance",
      };
    if (
      turn !== "task" &&
      (runners.has(conversationId) ||
        deps.repo.nextQueued(conversationId) !== null)
    ) {
      return {
        code: "busy",
        message: "Conversation is busy — a turn is already running",
      };
    }
    return null;
  }

  async function admission(
    conversationId: string,
    turn: HoldTurn,
  ): Promise<AdmissionRefusal | null> {
    const local = localRefusal(conversationId, turn);
    if (local !== null) return local;
    if (deps.holds === undefined) return null;
    const held = await readHolds(conversationId, turn, () => {
      const since = localRefusal(conversationId, turn);
      return since === null ? null : { kind: "refused", ...since };
    });
    return held === null ? null : { code: held.code, message: held.message };
  }

  function wake(conversationId: string): void {
    if (stopping) return;
    if (runners.has(conversationId)) {
      rerun.add(conversationId);
      return;
    }
    const runner = drainConversation(conversationId).finally(() => {
      runners.delete(conversationId);
      if (rerun.has(conversationId)) wake(conversationId);
      else if (
        !stopping &&
        !retired.has(conversationId) &&
        deps.repo.getInteractive(conversationId) !== null
      )
        deps.onConversationIdle?.(conversationId);
    });
    runners.set(conversationId, runner);
  }

  return {
    async submit(intent: PendingIntent) {
      const request = seatTurnRequestSchema.parse(intent.request);
      const existing = deps.repo.getMailbox(intent.cause);
      if (existing !== null) {
        if (existing.state === "queued") {
          // A resubmission refreshes the permit of an item not yet admitted.
          deps.transaction(() =>
            deps.repo.refreshMailboxPermit(
              intent.cause,
              intent.permit,
              deps.now(),
            ),
          );
          wake(existing.conversationId);
        }
        return;
      }
      const seat = await ensureSeat(request);
      deps.transaction(() =>
        deps.repo.insertMailboxIfAbsent({
          cause: intent.cause,
          conversationId: seat.conversationId,
          requester: intent.requester,
          request: intent.request,
          permit: intent.permit,
          state: "queued",
          attemptId: null,
          createdAt: deps.now(),
          updatedAt: deps.now(),
        }),
      );
      wake(seat.conversationId);
    },
    outcome(cause): OperationState {
      const item = deps.repo.getMailbox(cause);
      if (item === null) return { kind: "unknown" };
      if (item.state === "consumed" && item.attemptId !== null) {
        const attempt = deps.repo.getAttempt(item.attemptId);
        return { kind: "settled", outcome: attempt?.outcome ?? null };
      }
      const attempt = deps.repo.latestAttemptFor(cause);
      return attempt !== null && attempt.state === "admitted"
        ? { kind: "running" }
        : { kind: "queued" };
    },
    withdraw(cause) {
      const attempt = deps.repo.latestAttemptFor(cause);
      if (attempt !== null && attempt.state === "admitted") return;
      controllers.get(cause)?.abort();
      deps.transaction(() => deps.repo.deleteMailbox(cause));
    },
    interrupt(cause) {
      controllers.get(cause)?.abort();
    },
    async recover() {
      const { interrupted, claimed, unsent } = deps.transaction(() => {
        const conversations = new Set<string>();
        for (const attempt of deps.repo.attemptsInState("admitted")) {
          const report: SeatTurnReport = {
            status: "interrupted",
            conversationId: attempt.conversationId,
            finalText: null,
            structuredOutput: null,
            outputIssue: null,
            openQuestionId: null,
            failure: "The server restarted while this turn was running",
          };
          deps.repo.settleAttempt(attempt.attemptId, report, deps.now());
          deps.repo.consumeMailbox(
            attempt.cause,
            attempt.attemptId,
            deps.now(),
          );
          conversations.add(attempt.conversationId);
        }
        const claimed = new Set<string>();
        for (const attempt of deps.repo.attemptsInState("open")) {
          deps.repo.settleAttempt(
            attempt.attemptId,
            { notAdmitted: "the server restarted before admission" },
            deps.now(),
          );
          claimed.add(attempt.conversationId);
        }
        // Whatever still waits to start lost its sender with the process; left
        // queued, a message or task would hold the conversation busy for good.
        const unsent = deps.repo
          .conversationsWithQueued()
          .flatMap((conversationId) => deps.repo.queuedFor(conversationId));
        return {
          interrupted: [...conversations],
          claimed: [...claimed],
          unsent,
        };
      });
      // A turn that was still waiting to start left its conversation claimed (running).
      for (const conversationId of claimed) {
        const enrollment = deps.repo.getInteractive(conversationId);
        if (enrollment === null) continue;
        await deps.records
          .endClaim({
            projectPath: enrollment.projectPath,
            storeSessionName: enrollment.sessionName,
            conversationId,
          })
          .catch((error: unknown) =>
            deps.log.error("conversation_core.claim_end_failed", {
              conversationId,
              error: getErrorMessage(error),
            }),
          );
      }
      for (const item of unsent) await unstarted(item, { why: "restart" });
      for (const conversationId of interrupted) {
        const owner =
          deps.repo.getSeat(conversationId) ??
          deps.repo.getInteractive(conversationId);
        if (owner === null) continue;
        await deps.records
          .recordInterrupted({
            projectPath: owner.projectPath,
            storeSessionName: owner.sessionName,
            conversationId,
          })
          .catch((error: unknown) =>
            deps.log.error("conversation_core.recover_row_failed", {
              conversationId,
              error: getErrorMessage(error),
            }),
          );
      }
    },
    async shutdown() {
      stopping = true;
      for (const controller of controllers.values())
        controller.abort("shutdown");
      for (const lease of leases.values()) lease.controller.abort("shutdown");
      while (runners.size > 0) await Promise.all([...runners.values()]);
      // Tasks still waiting behind a turn never start; their callers are answered (the next boot drops them).
      for (const cause of [...taskWaiters.keys()])
        resolveTask(cause, taskNotStarted({ why: "stopping" }));
    },
    async idle() {
      while (runners.size > 0) await Promise.all([...runners.values()]);
    },
    admission,
    async sendUserMessage(input) {
      const refused = await admission(
        input.conversationId,
        input.queuedDelivery === undefined ? "message" : "delivery",
      );
      if (refused !== null) return { kind: "refused", ...refused };
      const {
        conversationId: _conversationId,
        stream: _stream,
        ...message
      } = input;
      const request: UserTurnRequest = userTurnRequestSchema.parse({
        kind: "user_message",
        ...message,
      });
      // A queued delivery's cause names its claim, correlating the turn with the queue rows it delivers.
      const cause =
        request.queuedDelivery !== undefined
          ? `queue:${input.conversationId}:${request.queuedDelivery.deliveryAttemptId}`
          : `user:${input.conversationId}:${randomUUID()}`;
      deps.transaction(() =>
        deps.repo.insertMailboxIfAbsent({
          cause,
          conversationId: input.conversationId,
          requester: null,
          request,
          permit: null,
          state: "queued",
          attemptId: null,
          createdAt: deps.now(),
          updatedAt: deps.now(),
        }),
      );
      // Registered once the message is durable, so a refused write leaves nothing behind.
      const settled = new Promise<SeatTurnReport>((resolve) =>
        waiters.set(cause, resolve),
      );
      if (input.stream !== undefined) streams.set(cause, input.stream);
      wake(input.conversationId);
      return { kind: "accepted", cause, settled };
    },
    async runTask({ conversationId, turn, signal }) {
      if (signal?.aborted === true) {
        return {
          kind: "not_started",
          reason: "cancelled",
          message: "The task was cancelled before it started",
        };
      }
      const refused = await admission(conversationId, "task");
      if (refused !== null) {
        return refused.code === "stopping"
          ? {
              kind: "not_started",
              reason: "cancelled",
              message: refused.message,
              interruption: { reason: "shutdown" },
            }
          : {
              kind: "not_started",
              reason: "configuration",
              message: refused.message,
            };
      }
      // A cancellation during the read fired before any listener could hear it.
      if (wasAborted(signal)) {
        return {
          kind: "not_started",
          reason: "cancelled",
          message: "The task was cancelled before it started",
        };
      }
      const cause = `task:${conversationId}:${randomUUID()}`;
      deps.transaction(() =>
        deps.repo.insertMailboxIfAbsent({
          cause,
          conversationId,
          requester: null,
          request: turn,
          permit: null,
          state: "queued",
          attemptId: null,
          createdAt: deps.now(),
          updatedAt: deps.now(),
        }),
      );
      const outcome = new Promise<TurnExecutionOutcome>((resolve) =>
        taskWaiters.set(cause, resolve),
      );
      const cancel = () => {
        const controller = controllers.get(cause);
        if (controller !== undefined) {
          controller.abort("user");
          return;
        }
        // Still waiting behind another turn: it never starts.
        void unstarted(
          { cause, conversationId, request: turn },
          { why: "cancelled" },
        );
      };
      signal?.addEventListener("abort", cancel, { once: true });
      wake(conversationId);
      try {
        return await outcome;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
    isBusy(conversationId) {
      return (
        runners.has(conversationId) ||
        deps.repo.nextQueued(conversationId) !== null
      );
    },
    async conversationIdle(conversationId) {
      while (runners.has(conversationId)) await runners.get(conversationId);
    },
    stopConversation(conversationId) {
      const cause = activeCauses.get(conversationId);
      const enrollment = deps.repo.getInteractive(conversationId);
      const identity =
        enrollment === null
          ? null
          : {
              projectPath: enrollment.projectPath,
              storeSessionName: enrollment.sessionName,
              conversationId,
            };
      const asked =
        identity !== null && deps.records.hasPendingQuestion(identity);
      if (cause === undefined && !asked)
        return { requested: false, settled: Promise.resolve() };
      if (cause !== undefined) controllers.get(cause)?.abort("user");
      const turnEnded =
        (cause !== undefined ? turnsEnded.get(cause) : undefined) ??
        Promise.resolve();
      if (identity === null) return { requested: true, settled: turnEnded };
      // After a stop the next input comes from the person: a question the
      // stopped turn left (or asked while stopping) is moot.
      const settled = turnEnded.then(async () => {
        if (!(await deps.records.withdrawQuestion(identity))) return;
        // Work held behind the question (subscription wakes) may run now.
        if (
          !stopping &&
          !retired.has(conversationId) &&
          !runners.has(conversationId)
        )
          deps.onConversationIdle?.(conversationId);
      });
      return { requested: true, settled };
    },
    async retireConversation(conversationId) {
      retired.add(conversationId);
      leases.get(conversationId)?.controller.abort("user");
      const running = activeCauses.get(conversationId);
      for (const item of deps.repo
        .queuedFor(conversationId)
        .filter((queued) => queued.cause !== running))
        await unstarted(item, { why: "retired" });
      if (running !== undefined) controllers.get(running)?.abort("user");
      while (runners.has(conversationId)) await runners.get(conversationId);
      deps.transaction(() => deps.repo.unenrollInteractive(conversationId));
    },
    seatBinding(conversationId) {
      return deps.repo.getSeat(conversationId);
    },
    hold,
    async whileIdle(
      conversationId,
      work,
      holder = { kind: "debug_command" },
      options = {},
    ) {
      const lease = hold(conversationId, holder);
      if (lease.kind === "busy") return { kind: "busy" };
      try {
        // Held, nothing runs: the durable holds answer for this conversation between turns.
        if (options.holds !== undefined && deps.holds !== undefined) {
          const held = await deps.holds.refusal(conversationId, options.holds, {
            betweenTurns: true,
          });
          if (held !== null) return { kind: "busy", reason: held.message };
        }
        return { kind: "ran", value: await work() };
      } finally {
        lease.release();
      }
    },
    lastMessageRequest(conversationId) {
      const item = deps.repo.lastConsumedMessage(conversationId);
      if (item === null) return null;
      const { queuedDelivery: _delivered, ...request } =
        userTurnRequestSchema.parse(item.request);
      return request;
    },
    runningAttempt(conversationId) {
      return runningAttempts.get(conversationId) ?? null;
    },
    runningSeatMayAsk(conversationId) {
      return runningSeatAsks.get(conversationId) ?? false;
    },
  };
}
