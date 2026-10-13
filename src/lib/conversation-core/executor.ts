import { randomUUID } from "node:crypto";
import type { BackgroundTasksLostInfo } from "@/lib/agent-backends/conversation";
import type { ControlPermits } from "@/lib/control/permits";
import type { PermitRef } from "@/lib/control/schemas";
import type { Executor, OperationState } from "@/lib/intents/executor";
import type { OwnerRef, PendingIntent } from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { BackgroundWorkUnstoppedError } from "./background-work";
import type { ConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import type {
  ConversationIdentity,
  ConversationRecordPort,
  CustodyRecordPort,
  CustodyRow,
  TurnSource,
} from "./conversation-record";
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
  custodyCause,
  isCustodyCause,
  type CustodyEnd,
  type InteractiveConversation,
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

/** How long custody may hold a runtime (design C5b §6); a handover starts a new custody. */
export const CUSTODY_BOUND_MS = 120 * 60_000;

/**
 * After a restart, how long a worktree a crashed custody held stays closed to
 * turns and publications: background work survives its CLI's parent for
 * about this long (design C5b §9.1, probe 2).
 */
export const CUSTODY_RESTART_FENCE_MS = 5_000;

/** Why nothing starts in a conversation whose kept runtime's processes could not be confirmed stopped. */
const runtimeUncollected = (failure: string): string =>
  `The agent's processes from earlier background work could not be confirmed stopped (${failure}); nothing more runs in this conversation until they are, and restarting the server collects them`;

/** Why a task, command, claim or maintenance is refused while custody holds the conversation. */
export const BACKGROUND_WORK_RUNNING =
  "Background work is running; stop it or wait";

/**
 * Why custody did not open for a turn whose runtime still owed work: its
 * session is being merged or has been, or the conversation is archived or
 * being deleted (design C5b §5). The runtime is released instead.
 */
export type CustodyRefusedEnd = "merging" | "merged" | "archived" | "deleted";

/**
 * How background work kept between turns was cut short, for the loss the
 * agent and the person hear about: how its custody ended, or why it never
 * opened.
 */
export type CustodyLossEnd =
  | Exclude<CustodyEnd, "settled" | "handed_over" | "refused">
  | CustodyRefusedEnd;

/** Where custody holds background work: a project, one of its sessions (by its store name), or one conversation. */
export interface CustodyScope {
  projectPath: string;
  sessionName?: string;
  conversationId?: string;
}

/**
 * A conversation whose background work a session act must not pass: custody
 * holds it, or (`unconfirmed`, why) an ended custody's runtime could not be
 * confirmed collected and its processes may still write.
 */
export interface BackgroundWorkHold {
  conversationId: string;
  unconfirmed: string | null;
}

/** A background task a runtime reported cut short as it closed, for the loss custody records. */
export type LostTask = BackgroundTasksLostInfo["tasks"][number];

/** The runtime a custody holds between turns, as the runtime side keeps it (design C5b §3). */
export interface RetainedRuntime {
  /** A provider turn (a segment) is running in it now. */
  segmentActive(): boolean;
  /** Closes and collects it; rejects when its processes could not be confirmed stopped. */
  close(): Promise<void>;
  /** Why its processes are still not confirmed stopped after a failed close, or null once collected. */
  closeFailure(): string | null;
  /**
   * A closed scope refused custody, whose admitted attempt now records the
   * loss of what the turn's release of the runtime cuts short: custody
   * claims that loss, not the runtime's own report of lost tasks.
   */
  lossClaimed(): void;
  /** The tasks the runtime reported cut short as it closed; empty when it reported none. */
  lostTasks(): LostTask[];
  /** Custody is over: nothing more reports to it. */
  released(end: CustodyEnd): void;
}

/** A custody, as its runtime side reports to it. Every call is ignored once that custody has ended. */
export interface CustodyLease {
  readonly attemptId: string;
  /**
   * What the row shows from custody's side now, read as it is written; null
   * once custody has ended. `segmentEnded` marks the write of a provider
   * turn's end, which the person hears about.
   */
  row(segmentEnded?: boolean): CustodyRow | null;
  /** A provider turn custody held ended: a queued message may hand over now. */
  segmentEnded(): void;
  /** The runtime owes no more work: custody ends settled. */
  settled(): void;
  /** The runtime died: custody ends lost. */
  lost(): void;
}

/** Custody of the running turn's runtime, opened at the turn's end when the runtime still owes provider work. */
export interface CustodyOpener {
  /** Null when custody may not open now (the server stops, the conversation goes away): the runtime is released. */
  open(runtime: RetainedRuntime): CustodyLease | null;
}

/** Dispatch for one admitted turn of an interactive conversation. */
export interface UserTurnPort {
  /** A message that will not start, and why; it settles what the message owes (a queued batch's rows, a debug turn's phase). */
  notStarted?(input: {
    conversationId: string;
    place: InteractiveConversation;
    request: UserTurnRequest;
    cause: string;
    reason: string;
    /** Who ended it: the person's stop, the server stopping or restarting, or a failure of the core itself. */
    endedBy: "person" | "server" | "failure";
  }): Promise<void> | void;
  run(input: {
    conversationId: string;
    place: InteractiveConversation;
    request: UserTurnRequest;
    attemptId: string;
    signal: AbortSignal;
    stream: TurnStream | null;
    /** Keeps the turn's runtime in custody when it ends still owing provider work. */
    custody: CustodyOpener;
  }): Promise<CoreTurnResult>;
}

/** Why work cannot start on a conversation now. */
export interface AdmissionRefusal {
  code: "not_core" | "stopping" | HoldRefusal["code"];
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
    place: InteractiveConversation;
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
   * The worktree an interactive conversation's turns write in. An interactive
   * turn holds it for interactive writes, which conflict only with Git and
   * publication operations there: those wait for the turn, and the turn waits
   * for them. Without it, interactive turns take no grant.
   */
  interactiveWorktree?(place: InteractiveConversation): Promise<string | null>;
  createSeatConversation(input: {
    projectPath: string;
    sessionName: string;
    role: "implementer" | "reviewer";
    request: SeatTurnRequest;
  }): Promise<string>;
  turns: SeatTurnPort;
  userTurns: UserTurnPort;
  taskTurns: TaskTurnPort;
  /** The conversation row: a turn the last process left running, the question a stop withdraws, and custody's projection. */
  records: Pick<
    ConversationRecordPort,
    | "recordInterrupted"
    | "recordWithdrawn"
    | "hasPendingQuestion"
    | "withdrawQuestion"
    | "claimTurn"
    | "endClaim"
  > &
    CustodyRecordPort;
  /**
   * Records, for the conversation's next turn, the runtime loss of work a
   * custody cut short or never kept; keyed by the custody attempt, so
   * recording it again changes nothing.
   */
  custodyLoss(input: {
    place: InteractiveConversation;
    attemptId: string;
    end: CustodyLossEnd;
    /**
     * Whether the runtime's processes were seen to end. When they were not,
     * only the person is told, and the agent's loss stays owed until they are.
     */
    collected: boolean;
    /** The tasks the runtime reported cut short, which the loss names; empty when none were reported. */
    tasks: LostTask[];
  }): Promise<void>;
  /** How long this server has been running, which bounds the restart fence. */
  uptimeMs(): number;
  /**
   * Why no custody may open for the conversation now (design C5b §5): its
   * session is being merged, finished or gone, or the conversation, its
   * session or its project is archived. Read at custody's insert, with no
   * await after it; null when custody may open.
   */
  custodyFence?(place: InteractiveConversation): CustodyRefusedEnd | null;
  /** Custody of the conversation's runtime began (`held`) or ended, for whoever shows it. */
  custodyChanged?(place: InteractiveConversation, held: boolean): void;
  /** Overrides `CUSTODY_BOUND_MS`; only tests shorten it. */
  custodyBoundMs?: number;
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
 * The Conversation core for supervised seats and interactive
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
  /** Every seat a context's assignments held, replaced incarnations included. */
  seatBindingsOf(contextId: string): SeatBindingRecord[];
  /**
   * A person's message to an interactive conversation. While a turn
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
  /**
   * The conversation is going away: what waits is withdrawn, what runs is
   * stopped, and it runs nothing more, once `dispose` (closing what it holds)
   * succeeds. A disposal that fails leaves the conversation to the core, so
   * what repairs it can still take it; so does background work custody held
   * whose processes could not be confirmed stopped, which rejects with
   * `BackgroundWorkUnstoppedError` before anything is disposed of.
   */
  retireConversation(
    conversationId: string,
    dispose?: () => Promise<void>,
  ): Promise<void>;
  /** Resolves once the conversation runs no turn and has none waiting to start. */
  conversationIdle(conversationId: string): Promise<void>;
  /** The conversation runs a turn or has one waiting to start. */
  isBusy(conversationId: string): boolean;
  /** Whether custody holds the conversation's runtime between turns: background work Stop ends. */
  holdsCustody(conversationId: string): boolean;
  /**
   * The conversations in a scope whose background work a session act must
   * not pass (a merge, marking merged): custody holds it, a refused custody's
   * runtime is still being released, or an ended or refused custody's runtime
   * is still unconfirmed. A turn that only runs is not among them.
   */
  backgroundWorkIn(scope: CustodyScope): BackgroundWorkHold[];
  /**
   * Closes a scope to background work for the length of `commit` (an
   * archive, a deletion, marking merged): no custody opens in it meanwhile,
   * and a turn that ends owing work releases its runtime with a loss of
   * `end`. The commit waits for every refused custody's runtime in the scope
   * still being released. With `stop`, custody in the scope is stopped first
   * and the commit runs only once every runtime there is confirmed collected;
   * otherwise rejects with `BackgroundWorkUnstoppedError`. Without it,
   * existing custody is the commit's to read (`backgroundWorkIn`) and refuse.
   */
  closeBackgroundWork<T>(
    scope: CustodyScope,
    commit: () => Promise<T>,
    options: { end: CustodyRefusedEnd; stop: boolean },
  ): Promise<T>;
  /**
   * Whether work of this kind may start now, by the same rules every entry
   * uses: the server, place, maintenance, a running turn (which holds
   * everything but a task, which waits its turn) and the durable holds.
   */
  admission(
    conversationId: string,
    turn: HoldTurn,
  ): Promise<AdmissionRefusal | null>;
  /**
   * A workflow's task turn on a conversation the core runs, run in the
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

function inScope(place: InteractiveConversation, scope: CustodyScope): boolean {
  return (
    place.projectPath === scope.projectPath &&
    (scope.sessionName === undefined ||
      place.sessionName === scope.sessionName) &&
    (scope.conversationId === undefined ||
      place.conversationId === scope.conversationId)
  );
}

/** A custody a closed scope refused: its admitted attempt, which owes the loss, and why. */
interface RefusedCustody {
  attemptId: string;
  end: CustodyRefusedEnd;
}

/** A runtime kept between turns while it owes provider work, and the attempt that owns it (design C5b §3). */
interface Custody {
  conversationId: string;
  attemptId: string;
  /** `custody:<the turn attempt that left it>`; its grant's holder. */
  cause: string;
  place: InteractiveConversation;
  /** The handing turn's source, which custody's provider turns run under. */
  source: TurnSource;
  grant: Grant | null;
  runtime: RetainedRuntime;
  bound: ReturnType<typeof setTimeout>;
  /** Set once custody is ending: why its runtime could not be collected, or null. */
  ending: Promise<string | null> | null;
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
  /** Each running turn's end: why its agent's processes could not be confirmed stopped, or null. */
  const turnsEnded = new Map<string, Promise<string | null>>();
  /** Grants kept for turns whose processes could not be confirmed stopped, by holder, with the reason. */
  const quarantined = new Map<string, string>();
  /** The runtime each conversation keeps between turns while it owes provider work (design C5b §3). */
  const custodies = new Map<string, Custody>();
  /** Runtimes ended or refused custodies could not collect, by conversation, until a later close collects them. */
  const uncollectedRuntimes = new Map<
    string,
    { runtime: RetainedRuntime; place: InteractiveConversation }
  >();
  /** Custodies whose loss is not yet recorded for the agent, by attempt: the loss, and the end settled once it is. */
  const owedLosses = new Map<
    string,
    { loss: CustodyLossEnd; end: CustodyEnd; tasks: LostTask[] }
  >();
  /** Scopes closed to background work while their act commits; custody opens in none of them. */
  const closings = new Set<{ scope: CustodyScope; end: CustodyRefusedEnd }>();
  /**
   * Runtimes whose custody a closed scope refused, while their turn is still
   * releasing them: background work until the release settles, so no guard
   * passes them meanwhile. By conversation; its turns run one at a time.
   */
  const pendingCollections = new Map<
    string,
    { place: InteractiveConversation; settled: Promise<void>; settle(): void }
  >();
  /** The interactive turn that claimed each conversation's row, and whether it was admitted. */
  const turnClaims = new Map<string, { cause: string; admitted: boolean }>();

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

  /** The interactive-write grant an interactive conversation's turn holds on its worktree, if it has one. */
  async function interactiveGrant(
    place: InteractiveConversation,
    holder: string,
  ): Promise<GrantRequest | null> {
    const worktree = await deps.interactiveWorktree?.(place);
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
        place: InteractiveConversation;
      }
    | {
        kind: "task";
        request: TaskTurn;
        place: InteractiveConversation;
      } {
    const request = mailboxRequestSchema.parse(item.request);
    if (request.kind !== "user_message" && request.kind !== "task_run")
      return { kind: "seat", request, grant: grantFor(request, item.cause) };
    const place = deps.repo.getInteractive(item.conversationId);
    if (place === null)
      throw new Error(
        `Conversation ${item.conversationId} is not run by the core`,
      );
    return request.kind === "user_message"
      ? { kind: "user", request, place }
      : { kind: "task", request, place };
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
    const place = deps.repo.getInteractive(conversationId);
    if (place !== null && why.why !== "retired") {
      // Settled before the mailbox copy goes: a queued batch the queue still holds as
      // delivering would otherwise block it until restart.
      await settleNotStarted(item, place, request, reason, endedBy);
      if (direct && (why.why === "held" || why.why === "restart")) {
        await deps.records
          .recordWithdrawn(
            {
              projectPath: place.projectPath,
              storeSessionName: place.sessionName,
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
    place: InteractiveConversation,
    request: UserTurnRequest,
    reason: string,
    endedBy: "person" | "server" | "failure",
  ): Promise<void> {
    await Promise.resolve(
      deps.userTurns.notStarted?.({
        conversationId: item.conversationId,
        place,
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

  const identityOf = (
    place: InteractiveConversation,
  ): ConversationIdentity => ({
    projectPath: place.projectPath,
    storeSessionName: place.sessionName,
    conversationId: place.conversationId,
  });

  /** The conversation has nothing running: its message queue may hand over the next turn. */
  function offerIdle(conversationId: string): void {
    if (stopping || retired.has(conversationId) || runners.has(conversationId))
      return;
    deps.onConversationIdle?.(conversationId);
  }

  /**
   * The row as `custody` leaves it, from who holds it now: a turn admitted
   * since owns it (null), a turn waiting to take over keeps it running, and
   * otherwise custody's provider turn decides.
   */
  function custodyRow(
    custody: Custody,
    segmentEnded: boolean,
  ): CustodyRow | null {
    if (custodies.get(custody.conversationId) !== custody) return null;
    const claim = turnClaims.get(custody.conversationId);
    if (claim?.admitted === true) return null;
    const segment = custody.runtime.segmentActive();
    if (claim !== undefined)
      return { status: "running", source: segment ? custody.source : null };
    return segment
      ? { status: "running", source: custody.source }
      : { status: "idle", notify: segmentEnded ? custody.source : null };
  }

  function leaseOf(custody: Custody): CustodyLease {
    const live = () => custodies.get(custody.conversationId) === custody;
    return {
      attemptId: custody.attemptId,
      row: (segmentEnded = false) => custodyRow(custody, segmentEnded),
      segmentEnded() {
        if (live() && custody.ending === null)
          offerIdle(custody.conversationId);
      },
      settled() {
        void endCustody(custody, "settled");
      },
      lost() {
        void endCustody(custody, "lost");
      },
    };
  }

  /** Tells whoever shows custody that it began or ended; showing it never fails custody. */
  function tellCustody(place: InteractiveConversation, held: boolean): void {
    try {
      deps.custodyChanged?.(place, held);
    } catch (error) {
      deps.log.warn("conversation_core.custody_change_unpublished", {
        conversationId: place.conversationId,
        held,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Opens custody of a turn's runtime at the turn's end (design C5b §3.3):
   * its own admitted attempt, inheriting the turn's source, and its own
   * interactive grant on the turn's worktree, taken while the turn still
   * holds its own, so the worktree is never unheld in between. Refused
   * (`session_closed`) once a merge delivers or has finished the session:
   * read here, at the insert, so no custody starts after the merge's check.
   */
  function openCustody(
    item: MailboxItemRecord,
    turnAttemptId: string,
    place: InteractiveConversation,
    source: TurnSource,
    turnGrant: Grant | null,
    turnSignal: AbortSignal,
    runtime: RetainedRuntime,
  ):
    | { kind: "opened"; lease: CustodyLease }
    | { kind: "refused"; reason: string }
    | { kind: "closed"; owed: RefusedCustody | null } {
    const { conversationId } = item;
    // A stopped turn's work is stopped with it, whenever the stop reached the turn.
    const refused = stopping
      ? "stopping"
      : turnSignal.aborted
        ? "turn_stopped"
        : retired.has(conversationId)
          ? "retired"
          : custodies.has(conversationId)
            ? "custody_exists"
            : null;
    if (refused !== null) {
      deps.log.info("conversation_core.custody_refused", {
        conversationId,
        reason: refused,
      });
      return { kind: "refused", reason: refused };
    }
    // Last, being a read of durable state; nothing awaits between it and the insert below.
    const closed =
      [...closings].find((closing) => inScope(place, closing.scope))?.end ??
      deps.custodyFence?.(place) ??
      null;
    if (closed !== null) {
      deps.log.info("conversation_core.custody_refused", {
        conversationId,
        reason: "closed",
        end: closed,
      });
      // At the refusal, before the turn awaits its runtime's release.
      let settle: () => void = () => {};
      const settled = new Promise<void>((resolve) => (settle = resolve));
      pendingCollections.set(conversationId, { place, settled, settle });
      const owed = owedRefusal(item, turnAttemptId, closed);
      // Without its attempt the refusal records nothing, and the runtime's own report is the loss's one record.
      if (owed !== null) runtime.lossClaimed();
      return { kind: "closed", owed };
    }
    const cause = custodyCause(turnAttemptId);
    // Interactive grants never conflict with each other, so this never waits.
    const grant =
      turnGrant === null
        ? null
        : deps.admission.tryAcquire({
            worktree: turnGrant.worktree,
            kind: "interactive_write",
            holder: cause,
          });
    if (turnGrant !== null && grant === null) {
      deps.log.error("conversation_core.custody_grant_refused", {
        conversationId,
        worktree: turnGrant.worktree,
      });
      return { kind: "refused", reason: "grant_refused" };
    }
    const attemptId = randomUUID();
    try {
      // Admitted before the turn settles: a crash from here leaves custody for boot to see.
      deps.transaction(() =>
        deps.repo.insertAttempt({
          attemptId,
          conversationId,
          cause,
          state: "admitted",
          outcome: null,
          openedAt: deps.now(),
          settledAt: null,
        }),
      );
    } catch (error) {
      if (grant !== null) deps.admission.release(grant);
      deps.log.error("conversation_core.custody_open_failed", {
        conversationId,
        error: getErrorMessage(error),
      });
      return { kind: "refused", reason: "open_failed" };
    }
    const custody: Custody = {
      conversationId,
      attemptId,
      cause,
      place,
      source,
      grant,
      runtime,
      bound: setTimeout(
        () => void endCustody(custody, "timed_out"),
        deps.custodyBoundMs ?? CUSTODY_BOUND_MS,
      ),
      ending: null,
    };
    custody.bound.unref?.();
    custodies.set(conversationId, custody);
    // The ending turn has passed the runtime and the row to custody.
    if (turnClaims.get(conversationId)?.cause === item.cause)
      turnClaims.delete(conversationId);
    deps.log.info("conversation_core.custody_opened", {
      conversationId,
      attemptId,
      turnAttemptId,
      source,
    });
    tellCustody(place, true);
    return { kind: "opened", lease: leaseOf(custody) };
  }

  /**
   * Every end of custody but a handover: the runtime is closed and collected,
   * the loss of what it cut short recorded, custody settled, its grant
   * released (kept when the runtime could not be collected) and the busy set
   * left, in that order. Resolves with why the runtime could not be collected.
   */
  function endCustody(
    custody: Custody,
    end: Exclude<CustodyEnd, "handed_over" | "refused">,
  ): Promise<string | null> {
    if (custodies.get(custody.conversationId) !== custody)
      return Promise.resolve(null);
    if (custody.ending !== null) return custody.ending;
    clearTimeout(custody.bound);
    const { conversationId, attemptId } = custody;
    let finish: (uncollected: string | null) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    // Set before the close starts: a death the runtime reports from inside its close is this end.
    custody.ending = new Promise<string | null>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    void (async (): Promise<string | null> => {
      let uncollected: string | null = null;
      await custody.runtime.close().catch((error: unknown) => {
        uncollected = getErrorMessage(error);
      });
      const collected = uncollected === null;
      const tasks = custody.runtime.lostTasks();
      // A custody that chose to settle still lost what its close cut short: a task started after
      // nothing was owed. One end, the effective one, is recorded, settled, told and logged.
      const effective = end === "settled" && tasks.length > 0 ? "lost" : end;
      // Custody stays admitted until the loss it cut short is recorded for the agent: the next
      // turn's admission or the next boot records it then.
      let lossOwed = false;
      if (effective !== "settled") {
        try {
          await deps.custodyLoss({
            place: custody.place,
            attemptId,
            end: effective,
            collected,
            tasks,
          });
          lossOwed = !collected;
        } catch (error) {
          lossOwed = true;
          deps.log.error("conversation_core.custody_loss_unrecorded", {
            conversationId,
            attemptId,
            error: getErrorMessage(error),
          });
        }
        if (lossOwed) {
          owedLosses.set(attemptId, { loss: effective, end: effective, tasks });
          deps.log.warn("conversation_core.custody_loss_owed", {
            conversationId,
            attemptId,
            end: effective,
            collected,
          });
        }
      }
      if (!lossOwed) settleCustody(conversationId, attemptId, effective);
      if (uncollected !== null) {
        uncollectedRuntimes.set(conversationId, {
          runtime: custody.runtime,
          place: custody.place,
        });
        deps.log.error("conversation_core.runtime_uncollected", {
          conversationId,
          cause: custody.cause,
          grantHeld: custody.grant !== null,
          error: uncollected,
        });
        if (custody.grant !== null) quarantined.set(custody.cause, uncollected);
      } else if (custody.grant !== null) {
        deps.admission.release(custody.grant);
      }
      const stillShown = custody.runtime.segmentActive();
      if (custodies.get(conversationId) === custody) {
        custodies.delete(conversationId);
        tellCustody(custody.place, false);
      }
      custody.runtime.released(effective);
      deps.log.info("conversation_core.custody_ended", {
        conversationId,
        attemptId,
        end: effective,
        ...(effective !== end ? { requestedEnd: end } : {}),
        uncollected: uncollected !== null,
      });
      // A provider turn whose end never arrived must not leave the row running.
      if (stillShown && turnClaims.get(conversationId)?.admitted !== true) {
        await deps.records
          .recordSegment(identityOf(custody.place), null, () =>
            turnClaims.get(conversationId)?.admitted === true
              ? null
              : turnClaims.has(conversationId)
                ? { status: "running", source: null }
                : { status: "idle", notify: null },
          )
          .catch((error: unknown) =>
            deps.log.error("conversation_core.custody_row_failed", {
              conversationId,
              error: getErrorMessage(error),
            }),
          );
      }
      offerIdle(conversationId);
      return uncollected;
    })().then(finish, fail);
    return custody.ending;
  }

  function settleCustody(
    conversationId: string,
    attemptId: string,
    end: CustodyEnd,
  ): void {
    try {
      deps.transaction(() =>
        deps.repo.settleAttempt(
          attemptId,
          { kind: "custody", end },
          deps.now(),
        ),
      );
    } catch (error) {
      // Left admitted, it is settled interrupted at the next boot.
      deps.log.error("conversation_core.custody_settle_failed", {
        conversationId,
        attemptId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * The custody a closed scope refused, as an admitted attempt that owes its
   * loss (design C5b §6): the runtime is released, and the attempt stays
   * admitted until the agent's loss is recorded, by this turn once its
   * runtime is collected, else by the next message or boot. Null when it
   * could not be recorded; the loss is then the person's notice alone.
   */
  function owedRefusal(
    item: MailboxItemRecord,
    turnAttemptId: string,
    end: CustodyRefusedEnd,
  ): RefusedCustody | null {
    const attemptId = randomUUID();
    try {
      deps.transaction(() =>
        deps.repo.insertAttempt({
          attemptId,
          conversationId: item.conversationId,
          cause: custodyCause(turnAttemptId),
          state: "admitted",
          outcome: null,
          openedAt: deps.now(),
          settledAt: null,
        }),
      );
    } catch (error) {
      deps.log.error("conversation_core.custody_refusal_unrecorded", {
        conversationId: item.conversationId,
        error: getErrorMessage(error),
      });
      return null;
    }
    return { attemptId, end };
  }

  /**
   * After the turn whose custody a closed scope refused has released its
   * runtime: the runtime side hears the refused custody is over, its
   * pending collection settles (an uncollected runtime stays
   * background work until collected), then the loss is recorded (the
   * agent's only once the runtime was seen collected) and the attempt
   * settled `refused`; otherwise it stays owed.
   */
  async function settleRefusedCustody(
    place: InteractiveConversation,
    refusal: { owed: RefusedCustody | null; runtime: RetainedRuntime },
    uncollected: string | null,
  ): Promise<void> {
    const { conversationId } = place;
    refusal.runtime.released("refused");
    const tasks = refusal.runtime.lostTasks();
    if (uncollected !== null)
      uncollectedRuntimes.set(conversationId, {
        runtime: refusal.runtime,
        place,
      });
    pendingCollections.get(conversationId)?.settle();
    pendingCollections.delete(conversationId);
    if (refusal.owed === null) return;
    await recordRefusedLoss(place, refusal.owed, uncollected, tasks);
  }

  async function recordRefusedLoss(
    place: InteractiveConversation,
    refusal: RefusedCustody,
    uncollected: string | null,
    tasks: LostTask[],
  ): Promise<void> {
    const { conversationId } = place;
    let owed = uncollected !== null;
    try {
      await deps.custodyLoss({
        place,
        attemptId: refusal.attemptId,
        end: refusal.end,
        collected: uncollected === null,
        tasks,
      });
    } catch (error) {
      owed = true;
      deps.log.error("conversation_core.custody_loss_unrecorded", {
        conversationId,
        attemptId: refusal.attemptId,
        error: getErrorMessage(error),
      });
    }
    if (!owed) {
      settleCustody(conversationId, refusal.attemptId, "refused");
      return;
    }
    owedLosses.set(refusal.attemptId, {
      loss: refusal.end,
      end: "refused",
      tasks,
    });
    deps.log.warn("conversation_core.custody_loss_owed", {
      conversationId,
      attemptId: refusal.attemptId,
      end: refusal.end,
      collected: uncollected === null,
    });
  }

  /**
   * Records the losses ended custodies of the conversation still owe its
   * agent (their custody stays admitted until then), before a turn takes its
   * input. Why one still cannot be recorded, or null. A custody the last
   * process left owing reads as interrupted: its end was not stored.
   */
  async function recordOwedLosses(
    place: InteractiveConversation,
  ): Promise<string | null> {
    const { conversationId } = place;
    const live = custodies.get(conversationId)?.attemptId;
    for (const attempt of deps.repo.attemptsInState("admitted")) {
      if (
        attempt.conversationId !== conversationId ||
        !isCustodyCause(attempt.cause) ||
        attempt.attemptId === live
      )
        continue;
      const owed = owedLosses.get(attempt.attemptId) ?? {
        loss: "interrupted",
        end: "interrupted",
        tasks: [],
      };
      try {
        // Admitted past the conversation's holds, its runtime's processes are known to be gone.
        await deps.custodyLoss({
          place,
          attemptId: attempt.attemptId,
          end: owed.loss,
          collected: true,
          tasks: owed.tasks,
        });
      } catch (error) {
        return getErrorMessage(error);
      }
      owedLosses.delete(attempt.attemptId);
      settleCustody(conversationId, attempt.attemptId, owed.end);
    }
    return null;
  }

  /**
   * Why the processes of a runtime an ended custody could not collect are
   * still unconfirmed, or null once a later close collected them. Whatever
   * grant a new turn could take, nothing starts beside them, and no loss
   * claims their termination.
   */
  function uncollectedFailure(conversationId: string): string | null {
    const runtime = uncollectedRuntimes.get(conversationId)?.runtime;
    if (runtime === undefined) return null;
    const failure = runtime.closeFailure();
    if (failure === null) uncollectedRuntimes.delete(conversationId);
    return failure;
  }

  /** Resolves once no refused custody's runtime in `scope` is still being released. */
  async function collectionsSettled(scope: CustodyScope): Promise<void> {
    for (;;) {
      const pending = [...pendingCollections.values()].filter((collection) =>
        inScope(collection.place, scope),
      );
      if (pending.length === 0) return;
      await Promise.all(pending.map((collection) => collection.settled));
    }
  }

  /** Conversations in `scope` whose ended or refused custody's runtime is still not confirmed collected. */
  function unconfirmedIn(scope: CustodyScope): BackgroundWorkHold[] {
    return [...uncollectedRuntimes]
      .filter(([, { place }]) => inScope(place, scope))
      .flatMap(([conversationId]) => {
        const failure = uncollectedFailure(conversationId);
        return failure === null
          ? []
          : [{ conversationId, unconfirmed: failure }];
      });
  }

  /**
   * What a message's turn needs settled before its admission: a custody that
   * has started ending finishes (its runtime closed, so the turn starts on a
   * fresh one), its processes are confirmed stopped, and the losses ended
   * custodies owe are recorded. Null when the turn may be admitted, otherwise
   * why it may not. The caller checks again, in the step that admits it, that
   * no custody started ending since.
   */
  async function readyForMessage(
    place: InteractiveConversation,
  ): Promise<string | null> {
    for (;;) {
      const ending = custodies.get(place.conversationId)?.ending;
      if (ending != null) {
        const failure = await ending;
        if (failure !== null) return runtimeUncollected(failure);
        continue;
      }
      const uncollected = uncollectedFailure(place.conversationId);
      if (uncollected !== null) return runtimeUncollected(uncollected);
      const unrecorded = await recordOwedLosses(place);
      if (unrecorded !== null)
        return `The loss of background work an earlier turn left could not be recorded for the agent, so nothing new starts until it is: ${unrecorded}`;
      if (custodies.get(place.conversationId)?.ending == null) return null;
    }
  }

  /** At a turn's admission custody hands its runtime over: settled, the turn its owner, its grant released. */
  function handOver(custody: Custody, turnAttemptId: string): void {
    clearTimeout(custody.bound);
    if (custody.grant !== null) deps.admission.release(custody.grant);
    custodies.delete(custody.conversationId);
    tellCustody(custody.place, false);
    custody.runtime.released("handed_over");
    deps.log.info("conversation_core.custody_handed_over", {
      conversationId: custody.conversationId,
      attemptId: custody.attemptId,
      turnAttemptId,
    });
  }

  /**
   * After a crash, a worktree a custody held stays closed to turns and
   * publications until the window in which its background work could still
   * write has passed since the server started. Whether the fence was taken.
   */
  async function fenceRecoveredWorktree(
    place: InteractiveConversation,
    attemptId: string,
  ): Promise<boolean> {
    const remaining = CUSTODY_RESTART_FENCE_MS - deps.uptimeMs();
    if (remaining <= 0) return false;
    let worktree: string | null | undefined;
    try {
      worktree = await deps.interactiveWorktree?.(place);
    } catch (error) {
      deps.log.error("conversation_core.custody_restart_fence_failed", {
        conversationId: place.conversationId,
        attemptId,
        error: getErrorMessage(error),
      });
      return false;
    }
    if (worktree === undefined || worktree === null) return false;
    const fence = deps.admission.tryAcquire({
      worktree,
      kind: "git",
      holder: `restart-fence:${attemptId}`,
    });
    if (fence === null) return false;
    deps.log.info("conversation_core.custody_restart_fence", {
      conversationId: place.conversationId,
      attemptId,
      remainingMs: remaining,
    });
    setTimeout(() => deps.admission.release(fence), remaining).unref?.();
    return true;
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
    if (turn.kind === "task" && custodies.has(item.conversationId)) {
      // Its turn has come with background work still running: one refusal, not a wait up to custody's bound.
      await unstarted(item, { why: "held", message: BACKGROUND_WORK_RUNNING });
      return "not_admitted";
    }
    const uncollectedTask =
      turn.kind === "task" ? uncollectedFailure(item.conversationId) : null;
    if (uncollectedTask !== null) {
      await unstarted(item, {
        why: "held",
        message: runtimeUncollected(uncollectedTask),
      });
      return "not_admitted";
    }
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
    let endTurn: (uncollected: string | null) => void = () => {};
    turnsEnded.set(
      item.cause,
      new Promise<string | null>((resolve) => (endTurn = resolve)),
    );
    let uncollected: string | null = null;
    // An interactive conversation shows running from here, while its turn may
    // still wait for model capacity: its person's next message is queued, not refused.
    const claimed =
      turn.kind === "seat"
        ? null
        : {
            projectPath: turn.place.projectPath,
            storeSessionName: turn.place.sessionName,
            conversationId: item.conversationId,
          };
    if (claimed !== null) {
      turnClaims.set(item.conversationId, {
        cause: item.cause,
        admitted: false,
      });
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
          : await interactiveGrant(turn.place, item.cause);
      let acquired = await acquire(item, grantRequest, controller.signal);
      if (acquired.kind === "admitted" && turn.kind === "user") {
        let refused: string | null;
        // Ready, and nothing started ending since, in the same step as the admission below: a custody's
        // event step can run between an awaited readiness check and its caller.
        do refused = await readyForMessage(turn.place);
        while (
          refused === null &&
          custodies.get(item.conversationId)?.ending != null
        );
        if (refused !== null || stopping || controller.signal.aborted) {
          acquired.releaseSlot();
          if (acquired.grant !== null) deps.admission.release(acquired.grant);
          if (refused !== null) {
            const failure = refused;
            deps.transaction(() =>
              deps.repo.settleAttempt(
                attemptId,
                { notAdmitted: failure },
                deps.now(),
              ),
            );
            await unstarted(item, { why: "failed", failure });
            return "not_admitted";
          }
          acquired = {
            kind: "not_admitted",
            reason: stopping
              ? "the server is stopping"
              : "cancelled before admission",
          };
        }
      }
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
      // A message's turn takes over the runtime custody holds, in one step with its admission.
      const handed =
        turn.kind === "user" ? custodies.get(item.conversationId) : undefined;
      deps.transaction(() => {
        deps.repo.admitAttempt(attemptId);
        if (handed !== undefined)
          deps.repo.settleAttempt(
            handed.attemptId,
            { kind: "custody", end: "handed_over" },
            deps.now(),
          );
      });
      const claim = turnClaims.get(item.conversationId);
      if (claim?.cause === item.cause) claim.admitted = true;
      if (handed !== undefined) handOver(handed, attemptId);
      runningAttempts.set(item.conversationId, attemptId);
      if (turn.kind === "seat")
        runningSeatAsks.set(item.conversationId, turn.request.seat.canAsk);
      let result: CoreTurnResult;
      /** A closed scope kept custody from opening: the runtime the turn releases still owed work. */
      const refusedCustody: {
        value: { owed: RefusedCustody | null; runtime: RetainedRuntime } | null;
      } = { value: null };
      try {
        if (turn.kind === "user") {
          result = await deps.userTurns.run({
            conversationId: item.conversationId,
            place: turn.place,
            request: turn.request,
            attemptId,
            signal: controller.signal,
            stream: streams.get(item.cause) ?? null,
            custody: {
              open: (runtime) => {
                const opened = openCustody(
                  item,
                  attemptId,
                  turn.place,
                  turn.request.autonomous === true ? "workflow" : "user",
                  acquired.grant,
                  controller.signal,
                  runtime,
                );
                if (opened.kind === "opened") return opened.lease;
                if (opened.kind === "closed")
                  refusedCustody.value = { owed: opened.owed, runtime };
                return null;
              },
            },
          });
        } else if (turn.kind === "task") {
          const ran = await deps.taskTurns.run({
            conversationId: item.conversationId,
            place: turn.place,
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
      // Released by now: the loss claims a termination only if its processes were seen to end.
      const refused = refusedCustody.value;
      if (refused !== null && turn.kind === "user")
        await settleRefusedCustody(
          turn.place,
          refused,
          result.runtimeUncollected ?? null,
        );
      if (result.runtimeUncollected !== undefined) {
        uncollected = result.runtimeUncollected;
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
        if (turnClaims.get(item.conversationId)?.cause === item.cause)
          turnClaims.delete(item.conversationId);
        const custody = custodies.get(item.conversationId);
        // A custody that outlives the turn (one it left, or one it never took over) owns the row: it
        // shows what custody runs, read as it is written, since a stored row keeps no turn source.
        const ended =
          custody !== undefined
            ? deps.records.recordSegment(claimed, null, () =>
                custodyRow(custody, false),
              )
            : deps.records.endClaim(claimed);
        await ended.catch((error: unknown) =>
          deps.log.error("conversation_core.claim_end_failed", {
            conversationId: item.conversationId,
            error: getErrorMessage(error),
          }),
        );
      }
      endTurn(uncollected);
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
    if (custodies.has(conversationId))
      return { kind: "busy", reason: BACKGROUND_WORK_RUNNING };
    const uncollected = uncollectedFailure(conversationId);
    if (uncollected !== null)
      return { kind: "busy", reason: runtimeUncollected(uncollected) };
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
        code: "not_core",
        message: `Conversation ${conversationId} is not run by the core`,
      };
    }
    if (leases.has(conversationId))
      return {
        code: "busy",
        message: "The conversation is held for maintenance",
      };
    const uncollected = uncollectedFailure(conversationId);
    if (uncollected !== null)
      return { code: "busy", message: runtimeUncollected(uncollected) };
    // A message takes the runtime over from custody; nothing else runs beside its background work.
    if (
      custodies.has(conversationId) &&
      turn !== "message" &&
      turn !== "delivery"
    )
      return { code: "busy", message: BACKGROUND_WORK_RUNNING };
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
      // A custody the crash left admitted lost its runtime with the process: its loss is
      // recorded before it settles, so a crash in between records it again.
      const custodyLost = new Map<
        string,
        { conversationId: string; fenced: boolean }
      >();
      for (const attempt of deps.repo.attemptsInState("admitted")) {
        if (!isCustodyCause(attempt.cause)) continue;
        const place = deps.repo.getInteractive(attempt.conversationId);
        let fenced = false;
        if (place !== null) {
          // The window in which its work could still write holds whether or not the loss can be recorded.
          fenced = await fenceRecoveredWorktree(place, attempt.attemptId);
          try {
            // The process that knew which tasks ran is gone: the loss names none.
            await deps.custodyLoss({
              place,
              attemptId: attempt.attemptId,
              end: "interrupted",
              collected: true,
              tasks: [],
            });
          } catch (error) {
            deps.log.error("conversation_core.custody_loss_unrecorded", {
              conversationId: attempt.conversationId,
              attemptId: attempt.attemptId,
              error: getErrorMessage(error),
            });
            continue;
          }
        }
        custodyLost.set(attempt.attemptId, {
          conversationId: attempt.conversationId,
          fenced,
        });
      }
      const { interrupted, claimed, unsent } = deps.transaction(() => {
        const conversations = new Set<string>();
        for (const attempt of deps.repo.attemptsInState("admitted")) {
          if (isCustodyCause(attempt.cause)) {
            if (custodyLost.has(attempt.attemptId))
              deps.repo.settleAttempt(
                attempt.attemptId,
                { kind: "custody", end: "interrupted" },
                deps.now(),
              );
            continue;
          }
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
      for (const [attemptId, { conversationId, fenced }] of custodyLost)
        deps.log.info("conversation_core.custody_recovered", {
          conversationId,
          attemptId,
          fenced,
        });
      // A turn that was still waiting to start left its conversation claimed (running).
      for (const conversationId of claimed) {
        const place = deps.repo.getInteractive(conversationId);
        if (place === null) continue;
        await deps.records
          .endClaim({
            projectPath: place.projectPath,
            storeSessionName: place.sessionName,
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
      const custodyEnds = [...custodies.values()].map((custody) =>
        endCustody(custody, "interrupted"),
      );
      while (runners.size > 0) await Promise.all([...runners.values()]);
      await Promise.all(custodyEnds);
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
        deps.repo.nextQueued(conversationId) !== null ||
        // Idle custody is not busy: a queued message hands over rather than waiting.
        custodies.get(conversationId)?.runtime.segmentActive() === true
      );
    },
    holdsCustody(conversationId) {
      return custodies.has(conversationId);
    },
    backgroundWorkIn(scope) {
      const held: BackgroundWorkHold[] = [
        ...custodies.values(),
        ...pendingCollections.values(),
      ]
        .filter((work) => inScope(work.place, scope))
        .map((work) => ({
          conversationId: work.place.conversationId,
          unconfirmed: null,
        }));
      return [...held, ...unconfirmedIn(scope)];
    },
    async closeBackgroundWork(scope, commit, options) {
      const closing = { scope, end: options.end };
      closings.add(closing);
      try {
        if (options.stop) {
          // Nothing opens in the scope from here, so these are all its custodies.
          const ending = [...custodies.values()]
            .filter((custody) => inScope(custody.place, scope))
            .map((custody) => endCustody(custody, "stopped"));
          await Promise.all(ending);
          await collectionsSettled(scope);
          const unconfirmed = unconfirmedIn(scope)[0];
          if (unconfirmed?.unconfirmed != null)
            throw new BackgroundWorkUnstoppedError(
              unconfirmed.conversationId,
              unconfirmed.unconfirmed,
            );
        }
        // Nothing refused before the closing may still be releasing as the act commits.
        else await collectionsSettled(scope);
        return await commit();
      } finally {
        closings.delete(closing);
      }
    },
    async conversationIdle(conversationId) {
      while (runners.has(conversationId)) await runners.get(conversationId);
    },
    stopConversation(conversationId) {
      const cause = activeCauses.get(conversationId);
      const place = deps.repo.getInteractive(conversationId);
      const identity =
        place === null
          ? null
          : {
              projectPath: place.projectPath,
              storeSessionName: place.sessionName,
              conversationId,
            };
      const asked =
        identity !== null && deps.records.hasPendingQuestion(identity);
      const custody = custodies.get(conversationId);
      if (cause === undefined && custody === undefined && !asked)
        return { requested: false, settled: Promise.resolve() };
      // A message waiting to take over from custody is stopped with it.
      if (cause !== undefined) controllers.get(cause)?.abort("user");
      // Stopped means its agent's processes were seen to end: one that could
      // not be confirmed is a failed stop, though nothing new starts meanwhile.
      const turnEnded = Promise.all([
        (cause !== undefined ? turnsEnded.get(cause) : undefined) ??
          Promise.resolve(null),
        custody === undefined
          ? Promise.resolve(null)
          : endCustody(custody, "stopped"),
      ]).then(([turnFailure, custodyFailure]) => {
        const failure = turnFailure ?? custodyFailure;
        if (failure !== null)
          throw new Error(
            `The agent's processes could not be confirmed stopped: ${failure}`,
          );
      });
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
    async retireConversation(conversationId, dispose) {
      // Nothing new starts, and no custody opens, while collection is confirmed.
      retired.add(conversationId);
      const custody = custodies.get(conversationId);
      const uncollected =
        (custody === undefined ? null : await endCustody(custody, "stopped")) ??
        uncollectedFailure(conversationId);
      if (uncollected !== null) {
        // Processes that may still write in its worktree: nothing that removes it may go ahead,
        // and the conversation is left as it was, its queued input included.
        retired.delete(conversationId);
        throw new BackgroundWorkUnstoppedError(conversationId, uncollected);
      }
      leases.get(conversationId)?.controller.abort("user");
      const running = activeCauses.get(conversationId);
      for (const item of deps.repo
        .queuedFor(conversationId)
        .filter((queued) => queued.cause !== running))
        await unstarted(item, { why: "retired" });
      if (running !== undefined) controllers.get(running)?.abort("user");
      while (runners.has(conversationId)) await runners.get(conversationId);
      try {
        await dispose?.();
      } catch (error) {
        retired.delete(conversationId);
        // Disposal closes the runtime: one it could not close may still act.
        throw new BackgroundWorkUnstoppedError(
          conversationId,
          getErrorMessage(error),
        );
      }
    },
    seatBinding(conversationId) {
      return deps.repo.getSeat(conversationId);
    },
    seatBindingsOf(contextId) {
      return deps.repo.seatsOfContext(contextId);
    },
    hold,
    async whileIdle(
      conversationId,
      work,
      holder = { kind: "debug_command" },
      options = {},
    ) {
      const lease = hold(conversationId, holder);
      if (lease.kind === "busy")
        return custodies.has(conversationId)
          ? { kind: "busy", reason: lease.reason }
          : { kind: "busy" };
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
