import type { InteractiveEnrollmentRecord } from "@/lib/conversation-core/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { createCoreQueueBridge } from "@/lib/conversation-core/queue-bridge";
import {
  createCoreDebugMode,
  type CoreDebugMode,
  type CoreDebugModeDeps,
} from "@/lib/conversation-core/debug-mode";
import {
  createCoreCheckpoints,
  type CoreCheckpointPorts,
  type CoreCheckpoints,
} from "@/lib/conversation-core/checkpoints";
import type { ConversationQueueDeps } from "@/lib/conversations/message-queue-drain";
import type { ConversationRecordPort } from "@/lib/conversation-core/conversation-record";
import type Database from "better-sqlite3";
import {
  createConversationCore,
  type ConversationCore,
  type ConversationCoreDeps,
  type SeatTurnPort,
  type TaskTurnPort,
  type UserTurnPort,
} from "@/lib/conversation-core/executor";
import {
  createConversationRequests,
  type ConversationRequests,
} from "@/lib/conversation-core/requests";
import {
  createControlPermits,
  type ControlPermits,
} from "@/lib/control/permits";
import {
  createContextHost,
  type ContextHost,
  type SeatWorkplace,
} from "@/lib/execution-context/host";
import { createIntentLedger, type IntentLedger } from "@/lib/intents/ledger";
import {
  createReconcileScheduler,
  type ReconcileScheduler,
} from "@/lib/intents/reconcile-scheduler";
import type { OwnerRef } from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { createControlPermitsRepo } from "@/lib/state-store/control-permits-repo";
import { createConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import { createExecutionContextsRepo } from "@/lib/state-store/execution-contexts-repo";
import { createPendingIntentsRepo } from "@/lib/state-store/pending-intents-repo";
import { createRunsRepo } from "@/lib/state-store/runs-repo";
import { createWorkspaceRepo } from "@/lib/state-store/workspace-repo";
import { createWorkspaceAdmission } from "@/lib/workspace/admission";
import type { ContentEvidence } from "@/lib/workspace/evidence";
import type { LaneGit } from "@/lib/workspace/lane-git";
import type { LaneIntegrator } from "@/lib/workspace/lane-integrator";
import {
  createWorkspaceExecutor,
  type WorkspaceExecutor,
  type WorkspaceExecutorDeps,
} from "@/lib/workspace/executor";
import { createRunHost, type RunHost, type RunHostDeps } from "@/lib/runs/host";

type Db = InstanceType<typeof Database>;

type HoldSource = NonNullable<ConversationCoreDeps["holds"]>;

/** The first durable hold any source reports, asked in order. */
function firstHold(sources: readonly HoldSource[]): HoldSource {
  return {
    async refusal(conversationId, turn, options) {
      for (const source of sources) {
        const refusal = await source.refusal(conversationId, turn, options);
        if (refusal !== null) return refusal;
      }
      return null;
    },
  };
}

/** The edges of the supervision graph that reach outside CC's own state. */
export interface SupervisionPorts {
  db: Db;
  seatTurns: SeatTurnPort;
  userTurns: UserTurnPort;
  taskTurns: TaskTurnPort;
  records: Pick<
    ConversationRecordPort,
    | "recordInterrupted"
    | "recordWithdrawn"
    | "hasPendingQuestion"
    | "withdrawQuestion"
    | "claimTurn"
    | "endClaim"
  >;
  /** The conversation message queue (the rows clients show) that feeds enrolled interactive conversations. */
  queue: Omit<ConversationQueueDeps, "submitTurn">;
  getProjectDisplayName(projectPath: string): string;
  readConversation(
    enrollment: InteractiveEnrollmentRecord,
  ): Promise<ConversationState | null>;
  /** Debug mode on enrolled conversations' rows, and the debug workflow's cleanup verification. */
  debug: Pick<CoreDebugModeDeps, "records" | "verify">;
  /** Checkpoints of enrolled conversations: durable state, the archive, generation and the core's runtimes. */
  checkpoints: CoreCheckpointPorts;
  /** What a conversation's row holds: a collaboration's claim on its turns, and a new claim while the row forbids one. */
  conversationHold: HoldSource;
  createSeatConversation: ConversationCoreDeps["createSeatConversation"];
  slots: ConversationCoreDeps["slots"];
  evidence: ContentEvidence;
  /** The Git effects of isolated lanes. */
  lanes: LaneGit;
  /** Brings a lane up to date with the session head before it publishes. */
  integrator: LaneIntegrator;
  /** The worktree an enrolled conversation's turns write in, held for interactive writes while a turn runs. */
  interactiveWorktree?: ConversationCoreDeps["interactiveWorktree"];
  runCheck: WorkspaceExecutorDeps["runCheck"];
  followOwner: RunHostDeps["followOwner"];
  boundariesRecorded: RunHostDeps["boundariesRecorded"];
  /** A run, or one of its Contexts, committed something a person sees. */
  runChanged: RunHostDeps["changed"];
  now(): string;
  logger(name: string): Logger;
}

/** One supervision graph: Run over Context over Conversation, Requests and Workspace. */
export interface Supervision {
  runs: RunHost;
  contexts: ContextHost;
  core: ConversationCore;
  requests: ConversationRequests;
  workspace: WorkspaceExecutor;
  permits: ControlPermits;
  intents: IntentLedger;
  scheduler: ReconcileScheduler;
  /** A supervised seat's question state, or null for any other conversation. */
  seatFor(conversationId: string): {
    canAsk: boolean;
    attemptId: string | null;
    openQuestionId: string | null;
  } | null;
  /** Where a supervised seat works and what it may run there, or null for any other conversation. */
  seatWorkplace(conversationId: string): SupervisedSeatWorkplace | null;
  /** Hands an enrolled interactive conversation's next queued message to the core when it is idle. */
  drainConversationQueue(conversationId: string): Promise<void>;
  /** Debug mode on enrolled interactive conversations. */
  debug: CoreDebugMode;
  /** Checkpoints of enrolled interactive conversations. */
  checkpoints: CoreCheckpoints;
  /** Boot: settle what the last process left running, restore runs paused, reconcile. */
  boot(): Promise<{ restoredRuns: number; reconciledOwners: number }>;
}

/** A seat's binding and its Context's answer about where it works. */
export interface SupervisedSeatWorkplace {
  projectPath: string;
  sessionName: string;
  contextId: string;
  workplace: SeatWorkplace;
}

export function composeSupervision(ports: SupervisionPorts): Supervision {
  const { db } = ports;
  // Every transaction here reads before it writes. Taking the write lock up
  // front lets one wait out another connection's write; a deferred one fails
  // at once when its read lock cannot be upgraded.
  const transaction = <T>(fn: () => T): T => db.transaction(fn).immediate();
  const permits = createControlPermits(createControlPermitsRepo(db));
  const intents = createIntentLedger(createPendingIntentsRepo(db));
  const scheduler = createReconcileScheduler();
  const touchRequester = (owner: OwnerRef) => scheduler.touch(owner);
  const coreRepo = createConversationCoreRepo(db);
  const admission = createWorkspaceAdmission();

  const workspace = createWorkspaceExecutor({
    transaction,
    repo: createWorkspaceRepo(db),
    permits,
    admission,
    evidence: ports.evidence,
    lanes: ports.lanes,
    integrator: ports.integrator,
    runCheck: ports.runCheck,
    touchRequester,
    now: ports.now,
    log: ports.logger("workspace"),
  });
  const requests = createConversationRequests({
    transaction,
    repo: coreRepo,
    touchRequester,
    now: ports.now,
  });
  const queueLog = ports.logger("conversation-core");
  const queueBridge = createCoreQueueBridge({
    queue: ports.queue,
    enrollment: (conversationId) => coreRepo.getInteractive(conversationId),
    isBusy: (conversationId) => core.isBusy(conversationId),
    send: (input) => core.sendUserMessage(input),
    getProjectDisplayName: ports.getProjectDisplayName,
    log: queueLog,
  });
  const checkpoints = createCoreCheckpoints({
    ...ports.checkpoints,
    core: {
      hold: (conversationId, holder) => core.hold(conversationId, holder),
      isBusy: (conversationId) => core.isBusy(conversationId),
      runningAttempt: (conversationId) => core.runningAttempt(conversationId),
    },
    enrollment: (conversationId) => coreRepo.getInteractive(conversationId),
    log: ports.logger("conversation-core"),
  });
  // A runtime whose close failed may still act in the worktree: nothing new runs beside it.
  const uncollectedRuntime: HoldSource = {
    async refusal(conversationId) {
      const failure =
        await ports.checkpoints.runtime.closeFailure(conversationId);
      return failure === null
        ? null
        : {
            code: "busy",
            message: `The conversation's last agent runtime did not close (${failure}), so nothing more runs in it until it does; restarting the server clears it`,
          };
    },
  };
  const holds = firstHold([
    ports.conversationHold,
    uncollectedRuntime,
    checkpoints,
  ]);
  // A held conversation's batch stays in its queue rather than being claimed only to be refused.
  const drainQueue = async (conversationId: string): Promise<void> => {
    try {
      if ((await holds.refusal(conversationId, "delivery")) !== null) return;
      await queueBridge.drain(conversationId);
    } catch (error) {
      queueLog.error("conversation_core.queue_drain_failed", {
        conversationId,
        error: getErrorMessage(error),
      });
    }
  };
  const core = createConversationCore({
    transaction,
    repo: coreRepo,
    holds,
    onConversationIdle: (conversationId) => void drainQueue(conversationId),
    permits,
    admission,
    createSeatConversation: ports.createSeatConversation,
    turns: ports.seatTurns,
    userTurns: ports.userTurns,
    taskTurns: ports.taskTurns,
    records: ports.records,
    slots: ports.slots,
    questions: requests,
    touchRequester,
    ...(ports.interactiveWorktree !== undefined
      ? { interactiveWorktree: ports.interactiveWorktree }
      : {}),
    now: ports.now,
    log: ports.logger("conversation-core"),
  });
  const debug = createCoreDebugMode({
    core,
    enrollment: (conversationId) => coreRepo.getInteractive(conversationId),
    records: ports.debug.records,
    verify: ports.debug.verify,
    log: ports.logger("conversation-core"),
  });
  const runsRepo = createRunsRepo(db);
  const contexts = createContextHost({
    transaction,
    contexts: createExecutionContextsRepo(db),
    intents,
    permits,
    executors: { conversation: core, workspace, requests },
    touchRun: (runId) => scheduler.touch({ kind: "run", id: runId }),
    changed: ports.runChanged,
    releaseBinding: (bindingId) => workspace.releaseBinding(bindingId),
    now: ports.now,
    log: ports.logger("execution-context"),
  });
  const runs = createRunHost({
    transaction,
    runs: runsRepo,
    intents,
    permits,
    contexts,
    workspace,
    touchContext: (contextId) =>
      scheduler.touch({ kind: "context", id: contextId }),
    followOwner: ports.followOwner,
    boundariesRecorded: ports.boundariesRecorded,
    changed: ports.runChanged,
    now: ports.now,
    log: ports.logger("runs"),
  });
  scheduler.register("context", {
    reconcile: (id) => contexts.reconcile(id),
    onFailure: (id, error) => contexts.recordReconcileFailure(id, error),
  });
  scheduler.register("run", {
    reconcile: (id) => runs.reconcile(id),
    onFailure: (id, error) => runs.recordReconcileFailure(id, error),
  });

  return {
    runs,
    contexts,
    core,
    requests,
    workspace,
    permits,
    intents,
    scheduler,
    seatFor(conversationId) {
      const binding = core.seatBinding(conversationId);
      if (binding === null) return null;
      const attemptId = core.runningAttempt(conversationId);
      return {
        // The running turn's own permission: a capture or advice turn answers within the turn.
        canAsk: core.runningSeatMayAsk(conversationId),
        attemptId,
        openQuestionId:
          attemptId === null
            ? null
            : requests.openedDuring(conversationId, attemptId),
      };
    },
    seatWorkplace(conversationId) {
      const binding = core.seatBinding(conversationId);
      if (binding === null) return null;
      return {
        projectPath: binding.projectPath,
        sessionName: binding.sessionName,
        contextId: binding.contextId,
        workplace: contexts.seatWorkplace(binding.contextId, binding),
      };
    },
    drainConversationQueue: drainQueue,
    debug,
    checkpoints,
    async boot() {
      await core.recover();
      const drainable: string[] = [];
      // Rows the last process claimed go back to the queue's own rules before anything drains.
      for (const enrollment of coreRepo.listInteractive()) {
        const { conversationId } = enrollment;
        // A conversation deleted while the core still listed it has nothing to recover.
        if ((await ports.readConversation(enrollment)) === null) {
          coreRepo.unenrollInteractive(conversationId);
          queueLog.info("conversation_core.enrollment_dropped", {
            conversationId,
          });
          continue;
        }
        await queueBridge.recover(conversationId).catch((error: unknown) =>
          queueLog.error("conversation_core.queue_recover_failed", {
            conversationId,
            error: getErrorMessage(error),
          }),
        );
        // A checkpoint the last process left in flight is settled before the queue may drain.
        await checkpoints.recover(enrollment);
        drainable.push(conversationId);
      }
      // Runs restore paused first: recovering an operation wakes its Run, which must start nothing until resumed.
      const restoredRuns = runsRepo.listActive().length;
      await runs.restoreAfterRestart();
      try {
        // Before any interactive turn starts, so finishing a publication never waits behind one.
        await workspace.recover();
      } finally {
        for (const conversationId of drainable) void drainQueue(conversationId);
      }
      const owners = intents.owners();
      for (const owner of owners) scheduler.touch(owner);
      void workspace.drain();
      return { restoredRuns, reconciledOwners: owners.length };
    },
  };
}
