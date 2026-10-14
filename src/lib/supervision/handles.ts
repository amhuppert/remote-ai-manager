import type {
  CustodyRefusedEnd,
  CustodyScope,
  HoldHolder,
  TaskTurn,
} from "@/lib/conversation-core/executor";
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
import { getGlobalValue } from "@/lib/shared/global-singleton";
import {
  createConversationCoreRepo,
  type ConversationCoreRepo,
} from "@/lib/state-store/conversation-core-repo";
import { getStateDb } from "@/lib/state-store/store";
import { createRunsRepo, type RunsRepo } from "@/lib/state-store/runs-repo";
import {
  createConversationsRepo,
  type ConversationsRepo,
} from "@/lib/state-store/conversations-repo";
import { currentRunsIn, type CurrentRun } from "@/lib/runs/session-guard";
import type { SessionBackgroundWork } from "@/lib/workflows/merge/background-work-guard";
import type {
  DesiredRuntimeConfiguration,
  RecreateRuntimeSnapshot,
} from "@/lib/conversation-core/turn/runtime-recreate";
import { releaseIdleCoreRuntime } from "./core-runtime-release";
import type { Supervision, SupervisedSeatWorkplace } from "./supervision";

export const SUPERVISION_KEY = "__cc_run_supervision";
export const CORE_TURN_RUNTIME_KEY = "__cc_core_turn_runtime";
/** Installed by startup composition; loads the engine without exposing its production graph. */
export const CORE_TURN_RUNTIME_LOADER_KEY = "__cc_core_turn_runtime_loader";
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

/** A new lane for one sequence of tasks that acts on no conversation. */
export async function coreTaskLane(): Promise<
  import("@/lib/conversation-core/task-turns").TaskLane
> {
  const load = getGlobalValue<() => Promise<CoreTurnRuntime>>(
    CORE_TURN_RUNTIME_LOADER_KEY,
  );
  const runtime = loadedCoreTurnRuntime() ?? load?.();
  if (runtime === undefined)
    throw new Error("The conversation core is not running");
  return (await runtime).taskLane();
}

/** Runs a task on its durable conversation through the core. */
export async function runConversationTask(
  input: import("@/lib/conversation-core/turn/execute-workflow-task-run").ExecuteWorkflowTaskRunInput,
): Promise<import("@/lib/conversation-core/turn/turn-result").TaskRunResult> {
  if (input.binding.kind !== "durable")
    throw new Error("A conversation task requires a durable binding");
  const { taskTurnRequestSchema } =
    await import("@/lib/conversation-core/turn/turn-spec");
  const { toTaskRunResult } =
    await import("@/lib/conversation-core/turn/turn-result");
  const outcome = await runCoreTask({
    conversationId: input.binding.address.target.conversationId,
    turn: taskTurnRequestSchema
      .strip()
      .parse({ ...input, promptText: input.prompt }),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return toTaskRunResult(outcome, input.outputFormat, {
    structuredOutputTextField: input.structuredOutputTextField,
  });
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
  | { kind: "not_ready" }
> {
  const supervision = composedSupervision();
  if (supervision === undefined) return { kind: "not_ready" };
  if (!coreOwnsConversation(conversationId)) return { kind: "not_core" };
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

/**
 * What a core conversation's runtime was created with, as a reader outside a
 * turn (the memory index preview) sees it; custody keeps a runtime between
 * turns (design C5b §5). Undefined before the core's engine has loaded, when no
 * runtime can exist.
 */
export function coreRuntimeConfiguration(
  conversationId: string,
): RecreateRuntimeSnapshot | undefined {
  return getGlobalValue<CoreTurnRuntime>(
    CORE_TURN_RUNTIME_READY_KEY,
  )?.host.configuration(conversationId);
}

/** The configuration a core conversation stands at now, for its runtime's own needs. */
export async function readCoreDesiredRuntimeConfiguration(
  conversationId: string,
  current: DesiredRuntimeConfiguration,
): Promise<DesiredRuntimeConfiguration> {
  const runtime = getGlobalValue<CoreTurnRuntime>(CORE_TURN_RUNTIME_READY_KEY);
  return runtime === undefined
    ? current
    : runtime.host.desiredConfiguration(conversationId, current);
}

/** A collaboration lets go of a core conversation's idle runtime before its agent resumes the session elsewhere. */
export async function releaseCoreIdleRuntime(
  conversationId: string,
): Promise<"released" | "not_hosted" | "busy"> {
  const core = composedSupervision()?.core;
  const runtime = loadedCoreTurnRuntime();
  if (core === undefined || runtime === undefined) return "not_hosted";
  return releaseIdleCoreRuntime(
    { core, host: (await runtime).host },
    conversationId,
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
  const release = async () => {
    const runtime = loadedCoreTurnRuntime();
    if (runtime !== undefined)
      await (await runtime).host.release(conversationId);
  };
  const core = composedSupervision()?.core;
  if (core === undefined) await release();
  else await core.retireConversation(conversationId, release);
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

let cachedRuns:
  | { db: ReturnType<typeof getStateDb>; repo: RunsRepo }
  | undefined;
function runsRepo(): RunsRepo {
  const db = getStateDb();
  if (cachedRuns?.db !== db) cachedRuns = { db, repo: createRunsRepo(db) };
  return cachedRuns.repo;
}

/** The runs working in a project, or in one of its sessions, that have not finished. */
export function currentRuns(
  projectPath: string,
  sessionName?: string,
): CurrentRun[] {
  return currentRunsIn(runsRepo(), projectPath, sessionName);
}

let cachedConversations:
  | { db: ReturnType<typeof getStateDb>; repo: ConversationsRepo }
  | undefined;
function conversationsRepo(): ConversationsRepo {
  const db = getStateDb();
  if (cachedConversations?.db !== db)
    cachedConversations = { db, repo: createConversationsRepo(db) };
  return cachedConversations.repo;
}

/**
 * The conversations of a session whose background work a merge must not pass
 * (design C5b §5): custody holds it, or an ended custody's processes are still
 * unconfirmed. None before supervision is composed: custody exists only
 * inside it.
 */
export function sessionBackgroundWork(
  projectPath: string,
  sessionName: string,
): SessionBackgroundWork[] {
  const core = composedSupervision()?.core;
  if (core === undefined) return [];
  return core
    .backgroundWorkIn({ projectPath, sessionName })
    .map(({ conversationId, unconfirmed }) => ({
      conversationId,
      conversationName:
        conversationsRepo().findById(conversationId)?.name ?? null,
      unconfirmed,
    }));
}

/** Whether custody holds a core conversation's runtime between turns: background work its Stop ends. */
export function coreHoldsCustody(conversationId: string): boolean {
  return composedSupervision()?.core.holdsCustody(conversationId) ?? false;
}

/**
 * Runs `commit` (an archive, a deletion, marking merged) with the scope closed
 * to background work: see `ConversationCore.closeBackgroundWork`. Rejects with
 * `BackgroundWorkUnstoppedError` when stopping finds processes it cannot
 * confirm collected. Before supervision is composed nothing can hold custody,
 * so the commit simply runs.
 */
export function closeCoreBackgroundWork<T>(
  scope: CustodyScope,
  commit: () => Promise<T>,
  options: { end: CustodyRefusedEnd; stop: boolean },
): Promise<T> {
  const core = composedSupervision()?.core;
  return core === undefined
    ? commit()
    : core.closeBackgroundWork(scope, commit, options);
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

/** Whether the core runs this conversation's turns: a run's seat, or any conversation without a role. */
export function coreOwnsConversation(conversationId: string): boolean {
  return coreRepo().ownsConversation(conversationId);
}
