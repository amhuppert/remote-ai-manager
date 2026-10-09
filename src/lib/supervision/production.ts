import { getConversationQueueDeps } from "@/lib/conversations/message-queue-production";
import {
  conversationCapabilitiesForBackend,
  getConversationFsWriteRestrictionForBackend,
} from "@/lib/agent-backends/catalog";
import type { CoreCheckpointPorts } from "@/lib/conversation-core/checkpoints";
import { createProductionConversationHold } from "@/lib/conversation-core/production-holds";
import { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import { getConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/service-factory";
import { getBackgroundActivityChannel } from "@/lib/conversations/background-activity";
import type { SeatTurnPort } from "@/lib/conversation-core/executor";
import { createNativeSeatTurns } from "@/lib/conversation-core/native-seat-turns";
import type { TaskLane } from "@/lib/conversation-core/task-turns";
import { getArtifactStore } from "@/lib/artifacts/production";
import {
  CC_ARTIFACTS_IGNORE_PATTERN,
  ensureCcArtifactsExcluded,
} from "@/lib/git/worktree";
import {
  createProductionTurnRuntime,
  type CoreTurnRuntime,
} from "@/lib/conversation-core/production-engine";
import {
  createProductionConversationRecords,
  createProductionDebugRecords,
} from "@/lib/conversation-core/production-records";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createConversation } from "@/lib/conversations/service";
import { createLogger } from "@/lib/logging";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import {
  deleteGlobalValue,
  getGlobalSingleton,
  getGlobalValue,
  setGlobalValue,
} from "@/lib/shared/global-singleton";
import { acquireQuerySlot } from "@/lib/shared/query-semaphore";
import {
  getConversation,
  getProjectConversation,
  getSession,
} from "@/lib/state-store";
import { getStateDb } from "@/lib/state-store/store";
import { getValidationService } from "@/lib/validation/singleton";
import { composeImplementerLaneWriteEnvelope } from "@/lib/workflow-graph/implementer-lane-write-envelope";
import { createWorkspaceEvidence } from "@/lib/workspace/evidence";
import { createLaneGit } from "@/lib/workspace/lane-git";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  createLaneConflictActors,
  createSmartMergeIntegrator,
} from "@/lib/workspace/smart-merge-integrator";
import { mergeMachine } from "@/lib/workflows/merge/machine";
import { defaultGitClient } from "@/lib/git/client";
import { acquireSessionLock, isSessionBusy } from "@/lib/prompt/single-flight";
import { createParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";
import { createValidationCheckRunner } from "@/lib/workspace/validation-checks";
import {
  composedSupervision,
  CORE_TURN_RUNTIME_KEY,
  loadedCoreTurnRuntime,
  SUPERVISION_KEY,
} from "./handles";
import { runDebugCleanupVerification } from "@/lib/workflows/debug/cleanup-verification";
import { getSubscriptionService } from "@/lib/subscriptions/service-factory";
import { requestSubscriptionWakePass } from "@/lib/subscriptions/active-wait-production";
import { composeSupervision, type Supervision } from "./supervision";
import { publishEvent } from "@/lib/events/publication";
import { createRunChangePublisher } from "@/lib/runs/events";

/** A burst of commits within this window reaches clients as one change. */
const RUN_CHANGE_COALESCE_MS = 200;
const runChanges = createRunChangePublisher({
  publish: publishEvent,
  logger: createLogger("runs"),
  defer: (flush) => {
    setTimeout(flush, RUN_CHANGE_COALESCE_MS);
  },
});

const logger = createLogger("runs");

/**
 * The server's one supervision graph, composed on first use. Process-global so
 * boot (instrumentation) and route bundles share one scheduler, one workspace
 * admission and one set of running turns.
 */
export function getSupervision(): Supervision {
  return getGlobalSingleton(SUPERVISION_KEY, composeProductionSupervision);
}

/** The core's turn engine, loaded once on first use; a failed load is retried on the next turn. */
function coreTurnRuntime(): Promise<CoreTurnRuntime> {
  const cached = getGlobalValue<Promise<CoreTurnRuntime>>(
    CORE_TURN_RUNTIME_KEY,
  );
  if (cached !== undefined) return cached;
  const created = createProductionTurnRuntime({
    // Resolved when a cleanup turn ends: by then the supervision that owns debug mode is composed.
    startDebugVerification: (input) =>
      composedSupervision()?.debug.startVerification(input),
  }).catch((error: unknown) => {
    deleteGlobalValue(CORE_TURN_RUNTIME_KEY);
    throw error;
  });
  setGlobalValue(CORE_TURN_RUNTIME_KEY, created);
  return created;
}

async function nativeSeatTurns(): Promise<SeatTurnPort> {
  const { engine, host } = await coreTurnRuntime();
  return createNativeSeatTurns({
    engine,
    records: createProductionConversationRecords(),
    host,
    getProjectDisplayName,
    composeWriteEnvelope: (input) => composeImplementerLaneWriteEnvelope(input),
    fsWriteRestriction: getConversationFsWriteRestrictionForBackend,
    async materializeDocuments(worktreePath, documents) {
      if (documents.length === 0) return;
      // The copies live under .cc/, which no commit or lane merge may carry.
      const outside = documents.find(
        (document) => !document.path.startsWith(CC_ARTIFACTS_IGNORE_PATTERN),
      );
      if (outside !== undefined)
        throw new Error(
          `A document copy must be under ${CC_ARTIFACTS_IGNORE_PATTERN}, not at "${outside.path}"`,
        );
      await ensureCcArtifactsExcluded(worktreePath);
      await getArtifactStore().materialize(worktreePath, documents);
    },
    log: createLogger("conversation-core"),
  });
}

/** The core's runtime host, when a core turn has loaded it; nothing is hosted before. */
async function loadedRuntimeHost() {
  const runtime = loadedCoreTurnRuntime();
  return runtime === undefined ? undefined : (await runtime).host;
}

function productionCheckpointPorts(): CoreCheckpointPorts {
  return {
    repo: () => getConversationCheckpointsRepo(),
    readConversation(identity) {
      const scope = scopeRefFromStoreSessionName(identity.sessionName);
      return scope.scope === "project"
        ? getProjectConversation(identity.projectPath, identity.conversationId)
        : getConversation(
            identity.projectPath,
            scope.sessionName,
            identity.conversationId,
          );
    },
    async readEntries(transcriptPath) {
      const { readTranscriptEntriesWithSeq } =
        await import("@/lib/prompt/transcript");
      return readTranscriptEntriesWithSeq(transcriptPath);
    },
    async findArtifact(conversationId) {
      const { getContextArtifactsRepo } =
        await import("@/lib/context-artifacts/repo-production");
      return (
        getContextArtifactsRepo()
          .findByConversation(conversationId)
          .find((row) => row.kind === "conversation_compaction") ?? null
      );
    },
    async resolveConfig(projectPath) {
      const [{ readConfig }, { resolveCompactionConfig }, { readRepoConfig }] =
        await Promise.all([
          import("@/lib/config/loader"),
          import("@/lib/config/cascade"),
          import("@/lib/projects/repo-config"),
        ]);
      return resolveCompactionConfig(
        await readConfig(),
        await readRepoConfig(projectPath),
      );
    },
    taskLane() {
      let lane: Promise<TaskLane> | undefined;
      return async (input) => {
        lane ??= coreTurnRuntime().then((runtime) => runtime.taskLane());
        return (await lane)(input);
      };
    },
    generate: (input, deps) => generateCheckpoint(input, deps),
    async resolveCaptureModel({ agentBackend, transcriptPath }) {
      const [
        { loadConversationTurnDependencies },
        { resolveTurnModelSelection },
      ] = await Promise.all([
        import("@/lib/conversation-core/production-turn-dependencies"),
        import("@/lib/conversation-core/contributions/resolve-model-effort"),
      ]);
      const deps = await loadConversationTurnDependencies();
      const [config, priorMessages] = await Promise.all([
        deps.execution.readConfig(),
        deps.transcript.readConversationMessages(transcriptPath),
      ]);
      return resolveTurnModelSelection({
        backend: agentBackend,
        config,
        priorMessages,
        explicitModelSelection: null,
      });
    },
    backendSupportsCheckpoint: (backend) =>
      conversationCapabilitiesForBackend(backend).checkpoint,
    background: {
      activity: (conversationId) =>
        getBackgroundActivityChannel().get(conversationId),
      epoch: (conversationId) =>
        getBackgroundActivityChannel().epoch(conversationId),
    },
    async confirmQueuedDelivery(input) {
      const { messageQueueService } =
        await import("@/lib/conversations/message-queue-service");
      return messageQueueService.confirmDelivery(input);
    },
    async appendUserEntryOnce(conversationId, entry) {
      const { appendTranscriptEntryOnce } =
        await import("@/lib/prompt/transcript");
      await appendTranscriptEntryOnce(conversationId, entry);
    },
    async worktreeOf(identity) {
      const scope = scopeRefFromStoreSessionName(identity.sessionName);
      if (scope.scope === "project") return identity.projectPath;
      const session = await getSession(identity.projectPath, scope.sessionName);
      if (session === null)
        throw new Error(`Session ${scope.sessionName} no longer exists`);
      return session.worktreePath;
    },
    runtime: {
      async release(conversationId) {
        await (await loadedRuntimeHost())?.release(conversationId);
      },
      async retryRelease(conversationId) {
        await (await loadedRuntimeHost())?.retryRelease(conversationId);
      },
      async closeFailure(conversationId) {
        return (
          (await loadedRuntimeHost())?.closeFailure(conversationId) ?? null
        );
      },
    },
    async settleTurnReceipts(conversationId) {
      const runtime = loadedCoreTurnRuntime();
      if (runtime !== undefined)
        await (await runtime).interactiveTurns.settleRetained(conversationId);
    },
    now: () => new Date().toISOString(),
  };
}

function composeProductionSupervision(): Supervision {
  const laneGit = createLaneGit({
    git: defaultGitClient,
    exists: existsSync,
    writeFile: (filePath, content) => writeFile(filePath, content, "utf-8"),
    worktrees: createParallelWorktrees(),
    acquireSessionLock,
    isSessionBusy,
  });
  const composed = composeSupervision({
    db: getStateDb(),
    seatTurns: {
      async run(input) {
        return (await nativeSeatTurns()).run(input);
      },
    },
    records: createProductionConversationRecords(),
    queue: {
      // The core holds a debug session's queue; the conversation actor holds its own by state.
      claimNextTurnBatch: (input) =>
        getConversationQueueDeps().claimNextTurnBatch({
          ...input,
          debugHold: true,
        }),
      markPending: (input) => getConversationQueueDeps().markPending(input),
      markDelivered: (input) => getConversationQueueDeps().markDelivered(input),
      markFailed: (input) => getConversationQueueDeps().markFailed(input),
      recoverAbandonedDeliveries: (input) =>
        getConversationQueueDeps().recoverAbandonedDeliveries(input),
      runConversationCommand: (input) =>
        getConversationQueueDeps().runConversationCommand(input),
    },
    getProjectDisplayName,
    readConversation: (enrollment) =>
      getConversation(
        enrollment.projectPath,
        enrollment.sessionName,
        enrollment.conversationId,
      ),
    debug: {
      records: createProductionDebugRecords(),
      verify: (request) => runDebugCleanupVerification(request),
    },
    checkpoints: productionCheckpointPorts(),
    conversationHold: createProductionConversationHold(),
    userTurns: {
      async notStarted(input) {
        await (await coreTurnRuntime()).interactiveTurns.notStarted?.(input);
      },
      async run(input) {
        return (await coreTurnRuntime()).interactiveTurns.run(input);
      },
    },
    taskTurns: {
      async run(input) {
        return (await coreTurnRuntime()).taskTurns.run(input);
      },
    },
    async createSeatConversation({ projectPath, sessionName, role, request }) {
      const conversation = await createConversation(projectPath, sessionName, {
        role: role === "implementer" ? "iteration" : "validator",
        agentBackend: request.seat.assignment.backend,
        profile: request.seat.assignment.profile,
      });
      return conversation.id;
    },
    slots: { acquire: (label, signal) => acquireQuerySlot(label, { signal }) },
    evidence: createWorkspaceEvidence(),
    async interactiveWorktree(enrollment) {
      const scope = scopeRefFromStoreSessionName(enrollment.sessionName);
      if (scope.scope === "project") return enrollment.projectPath;
      return (
        (await getSession(enrollment.projectPath, scope.sessionName))
          ?.worktreePath ?? null
      );
    },
    lanes: laneGit,
    integrator: createSmartMergeIntegrator({
      machine: mergeMachine.provide({ actors: createLaneConflictActors() }),
      lanes: laneGit,
      log: createLogger("workspace"),
    }),
    runCheck: createValidationCheckRunner({
      service: getValidationService(),
      async branchOf(projectPath, sessionName) {
        const session = await getSession(projectPath, sessionName);
        return {
          branchName: session?.branchName ?? null,
          targetBranch: session?.targetBranch ?? null,
        };
      },
      log: createLogger("workspace"),
    }),
    async followOwner(run) {
      const follow = await getSubscriptionService().autoFollow({
        recipient: {
          projectPath: run.projectPath,
          conversationId: run.ownerConversationId,
        },
        source: { kind: "run", id: run.runId },
        reason: "Run launched by this conversation",
        initialCursor: "0",
        wakes: true,
      });
      if (follow === null)
        logger.warn("runs.owner_not_followable", {
          runId: run.runId,
          conversationId: run.ownerConversationId,
        });
    },
    boundariesRecorded() {
      requestSubscriptionWakePass();
    },
    runChanged: runChanges.changed,
    now: () => new Date().toISOString(),
    logger: (name) => createLogger(name),
  });
  return composed;
}

/** Boot: called once after conversation actors rehydrate. */
export async function bootSupervision(): Promise<{
  restoredRuns: number;
  reconciledOwners: number;
}> {
  return getSupervision().boot();
}

/**
 * Server stop: running seat turns abort as interrupted (boot finds them
 * settled that way rather than cancelled by a user), then every runtime the
 * core hosts closes. Composes nothing that was never used.
 */
export async function shutdownSupervision(): Promise<void> {
  const supervision = getGlobalValue<Supervision>(SUPERVISION_KEY);
  if (supervision !== undefined) await supervision.core.shutdown();
  const runtime = getGlobalValue<Promise<CoreTurnRuntime>>(
    CORE_TURN_RUNTIME_KEY,
  );
  if (runtime !== undefined) await (await runtime).host.releaseAll();
}
