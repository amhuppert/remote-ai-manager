import type Database from "better-sqlite3";
import {
  createConversationCore,
  type ConversationCore,
  type ConversationCoreDeps,
  type SeatTurnPort,
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
import type { WorkspaceEvidence } from "@/lib/workspace/evidence";
import {
  createWorkspaceExecutor,
  type WorkspaceExecutor,
  type WorkspaceExecutorDeps,
} from "@/lib/workspace/executor";
import { createRunHost, type RunHost, type RunHostDeps } from "./host";

type Db = InstanceType<typeof Database>;

/** The edges of the supervision graph that reach outside CC's own state. */
export interface RunSupervisionPorts {
  db: Db;
  seatTurns: SeatTurnPort;
  createSeatConversation: ConversationCoreDeps["createSeatConversation"];
  slots: ConversationCoreDeps["slots"];
  evidence: WorkspaceEvidence;
  runCheck: WorkspaceExecutorDeps["runCheck"];
  notifyOwner: RunHostDeps["notifyOwner"];
  now(): string;
  logger(name: string): Pick<Logger, "info" | "warn" | "error">;
}

/** One supervision graph: Run over Context over Conversation, Requests and Workspace. */
export interface RunSupervision {
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
  /** Boot: settle what the last process left running, restore runs paused, reconcile. */
  boot(): Promise<{ restoredRuns: number; reconciledOwners: number }>;
}

export function composeRunSupervision(
  ports: RunSupervisionPorts,
): RunSupervision {
  const { db } = ports;
  const transaction = <T>(fn: () => T): T => db.transaction(fn)();
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
  const core = createConversationCore({
    transaction,
    repo: coreRepo,
    permits,
    admission,
    createSeatConversation: ports.createSeatConversation,
    turns: ports.seatTurns,
    slots: ports.slots,
    questions: requests,
    touchRequester,
    now: ports.now,
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
    touchContext: (contextId) =>
      scheduler.touch({ kind: "context", id: contextId }),
    notifyOwner: ports.notifyOwner,
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
      const context = contexts.observe(binding.contextId);
      return {
        canAsk: context?.record.facts.contract.current.ownerQuestions ?? false,
        attemptId,
        openQuestionId:
          attemptId === null
            ? null
            : requests.openedDuring(conversationId, attemptId),
      };
    },
    async boot() {
      core.recover();
      workspace.recover();
      const restoredRuns = runsRepo.listActive().length;
      await runs.restoreAfterRestart();
      const owners = intents.owners();
      for (const owner of owners) scheduler.touch(owner);
      void workspace.drain();
      return { restoredRuns, reconciledOwners: owners.length };
    },
  };
}
