import type { HoldHolder, TaskTurn } from "@/lib/conversation-core/executor";
import type { CoreDebugCommandOutcome } from "@/lib/conversation-core/debug-mode";
import type { CoreCheckpoints } from "@/lib/conversation-core/checkpoints";
import type { DebugCommand } from "@/lib/workflows/debug/commands";
import type { TurnExecutionOutcome } from "@/lib/conversation-core/turn/turn-result";
import {
  createProductionConversationQuestions,
  createProductionConversationRecords,
} from "@/lib/conversation-core/production-records";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { QuestionCommand } from "@/lib/conversation-core/turn/types";
import type { CoreTurnRuntime } from "@/lib/conversation-core/production-engine";
import type { RunningTurnDescription } from "@/lib/conversation-core/interactive-turns";
import type { ConversationIdentity } from "@/lib/conversation-core/conversation-record";
import type { DeliveryClass } from "@/lib/conversation-core/turn-input";
import type { UserTurnRequest } from "@/lib/conversation-core/schemas";
import {
  storeSessionNameFromScopeRef,
  type ConversationScopeRef,
  type ForkPlacement,
} from "@/lib/conversations/conversation-target";
import { getGlobalValue } from "@/lib/shared/global-singleton";
import {
  createConversationCoreRepo,
  type ConversationCoreRepo,
} from "@/lib/state-store/conversation-core-repo";
import { getStateDb } from "@/lib/state-store/store";
import type { Supervision, SupervisedSeatWorkplace } from "./supervision";

export const SUPERVISION_KEY = "__cc_run_supervision";
export const CORE_TURN_RUNTIME_KEY = "__cc_core_turn_runtime";
/** The core's turn engine once loaded, for readers that cannot wait on its load. */
export const CORE_TURN_RUNTIME_READY_KEY = "__cc_core_turn_runtime_ready";

/**
 * The composed supervision graph and the core's turn engine, when this process
 * has created them. Read without composing anything, so callers outside the
 * supervision graph (the conversation actor's manager) carry no import of it.
 */
export function composedSupervision(): Supervision | undefined {
  return getGlobalValue<Supervision>(SUPERVISION_KEY);
}

export function loadedCoreTurnRuntime(): Promise<CoreTurnRuntime> | undefined {
  return getGlobalValue<Promise<CoreTurnRuntime>>(CORE_TURN_RUNTIME_KEY);
}

/** Stops a core conversation's turn; `settled` once that turn has ended. Queued notices still run. */
export function stopCoreConversation(conversationId: string): {
  requested: boolean;
  settled: Promise<void>;
} {
  return (
    composedSupervision()?.core.stopConversation(conversationId) ?? {
      requested: false,
      settled: Promise.resolve(),
    }
  );
}

/** The checkpoint owner of core conversations, once run supervision is composed. */
export function coreCheckpoints(): CoreCheckpoints | undefined {
  return composedSupervision()?.checkpoints;
}

/** The core takes the conversation's next queued message, if it is idle and has one. */
export async function drainCoreConversation(
  conversationId: string,
): Promise<void> {
  await composedSupervision()?.drainConversationQueue(conversationId);
}

/** A question a core conversation's agent asks, or its clearing, recorded on the conversation row. */
export async function coreQuestionCommand(
  identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  },
  command: QuestionCommand,
): Promise<boolean> {
  const questions = createProductionConversationQuestions();
  const row = {
    projectPath: identity.projectPath,
    storeSessionName: identity.sessionName,
    conversationId: identity.conversationId,
  };
  return command.kind === "register_question"
    ? questions.ask(row, {
        questionId: command.questionId,
        questions: command.questions,
      })
    : questions.clear(row, command.questionId);
}

/**
 * Exclusive work on a conversation the core runs (a collaboration's claim),
 * only while it runs and waits for nothing; `not_core` for any other conversation.
 */
export async function holdCoreConversationWhileIdle<T>(
  conversationId: string,
  holder: HoldHolder,
  work: () => Promise<T>,
): Promise<
  | { kind: "ran"; value: T }
  | { kind: "busy"; reason: string }
  | { kind: "not_core" }
> {
  const supervision = composedSupervision();
  if (supervision === undefined || !coreOwnsConversation(conversationId))
    return { kind: "not_core" };
  const held = await supervision.core.whileIdle(conversationId, work, holder, {
    holds: "claim",
  });
  return held.kind === "busy"
    ? {
        kind: "busy",
        reason:
          held.reason ??
          "The conversation is running a turn or has one waiting to start",
      }
    : held;
}

/** A debug command on a core conversation, applied by the core's debug mode. */
export async function coreDebugCommand(
  identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  },
  command: DebugCommand,
): Promise<CoreDebugCommandOutcome> {
  const supervision = composedSupervision();
  if (supervision === undefined) {
    return {
      kind: "refused",
      code: "not_found",
      message: "Run supervision is not running",
    };
  }
  return supervision.debug.command(identity.conversationId, command);
}

/** A workflow's task turn on a core conversation, in the conversation's turn order. */
export async function runCoreTask(input: {
  conversationId: string;
  turn: TaskTurn;
  signal?: AbortSignal;
}): Promise<TurnExecutionOutcome> {
  const supervision = composedSupervision();
  if (supervision === undefined) {
    return {
      kind: "not_started",
      reason: "configuration",
      message: "Run supervision is not running",
    };
  }
  return supervision.core.runTask(input);
}

/**
 * Where a run seat works and what it may run there; null for any other
 * conversation. Null before supervision is composed too: a seat's turns run
 * only inside it, so no seat can be calling then.
 */
export function supervisedSeatWorkplace(
  conversationId: string,
): SupervisedSeatWorkplace | null {
  return composedSupervision()?.seatWorkplace(conversationId) ?? null;
}

/** A core conversation's running turn, as alignment authoring and active waits read it; null when none runs. */
export function describeCoreTurn(
  conversationId: string,
): RunningTurnDescription | null {
  return (
    getGlobalValue<CoreTurnRuntime>(
      CORE_TURN_RUNTIME_READY_KEY,
    )?.interactiveTurns.describeRunning(conversationId) ?? null
  );
}

/** Whether a core conversation's running turn takes a queued message now. */
export async function coreAcceptsLive(
  conversationId: string,
): Promise<boolean> {
  const runtime = loadedCoreTurnRuntime();
  return (
    runtime !== undefined &&
    (await runtime).interactiveTurns.acceptsLive(conversationId)
  );
}

/** A queued message the queue claimed, delivered into a core conversation's running turn. */
export async function deliverCoreLive(
  identity: ConversationIdentity,
  request: UserTurnRequest,
): Promise<DeliveryClass> {
  const runtime = loadedCoreTurnRuntime();
  if (runtime === undefined)
    throw new Error("The conversation core is not running");
  return (await runtime).interactiveTurns.deliverLive(identity, request);
}

/** A core conversation is going away: nothing more runs in it, and its runtime is closed. */
export async function retireCoreConversation(
  conversationId: string,
): Promise<void> {
  await composedSupervision()?.core.retireConversation(conversationId);
  const runtime = loadedCoreTurnRuntime();
  if (runtime !== undefined) await (await runtime).host.release(conversationId);
}

let cached:
  | { db: ReturnType<typeof getStateDb>; repo: ConversationCoreRepo }
  | undefined;
/** One prepared repository per database handle, so a reopened database is never read through a closed one. */
function coreRepo(): ConversationCoreRepo {
  const db = getStateDb();
  if (cached?.db !== db) cached = { db, repo: createConversationCoreRepo(db) };
  return cached.repo;
}

/** A core conversation that has not run takes the backend its first input chose. */
export async function adoptCoreConversationBackend(
  identity: {
    projectPath: string;
    storeSessionName: string;
    conversationId: string;
  },
  backend: AgentBackendId,
): Promise<void> {
  await createProductionConversationRecords().adoptBackend(identity, backend);
}

/** A run's seat conversation, which takes work only from its run. */
export function coreRunsSeat(conversationId: string): boolean {
  return coreRepo().getSeat(conversationId) !== null;
}

/** Whether the core runs this conversation's turns, as a seat or an enrolled interactive conversation. */
export function coreOwnsConversation(conversationId: string): boolean {
  return coreRepo().ownsConversation(conversationId);
}

/**
 * Hands a new interactive conversation's turns to the core. Only safe before
 * anyone can address the conversation: the actor refuses it from then on.
 */
export function enrollInCore(input: {
  conversationId: string;
  projectPath: string;
  scope: ConversationScopeRef;
}): void {
  coreRepo().enrollInteractive({
    conversationId: input.conversationId,
    projectPath: input.projectPath,
    // The conversation's storage key (the project sentinel at project scope), which every row write uses.
    sessionName: storeSessionNameFromScopeRef(input.scope),
    enrolledAt: new Date().toISOString(),
  });
}

/** A fork runs where its source runs: enrolled with the core when the core runs its source. */
export function enrollForkWithSource(input: ForkPlacement): void {
  if (!coreOwnsConversation(input.sourceConversationId)) return;
  enrollInCore({
    conversationId: input.conversationId,
    projectPath: input.projectPath,
    scope: input.scope,
  });
}
