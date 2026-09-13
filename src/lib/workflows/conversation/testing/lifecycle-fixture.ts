import { admitCheckpointForkSubmission } from "@/lib/conversation-checkpoints/fork-submission";
import { readRuntimeInstructions } from "../runtime-instructions";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import type { ConversationAddress } from "../turn-spec";
import type { ConversationState } from "@/lib/conversations/schemas";
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import type { ActorFixtureDependencies } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import type { ConversationBackgroundActivity } from "@/lib/conversations/schemas";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import { compactionConfigSchema } from "@/lib/config/schemas";
import type {
  TranscriptEntriesResult,
  TranscriptEntryWithSeq,
} from "@/lib/prompt/transcript";
import {
  ConversationMaintenanceActiveError,
  type ConversationCheckpointDependencies,
} from "../manager";
import type { ConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import type { ConversationQueueDeps } from "@/lib/conversations/message-queue-drain";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { admitConversationProfile } from "@/lib/conversations/profile-admission";
import { createConversationManagerFixture } from "./manager-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { loadActorInput } from "../actor-input-loader";
import { hydrateCheckpointAuthority } from "../checkpoint-restart";
import { createActorDependenciesFixture } from "./actor-deps-fixture";
import { createLogger } from "@/lib/logging";

import { _resetForTesting as resetRuntime } from "../runtime-state";
import {
  setConversationPersistenceAdapterDeps,
  _resetConversationPersistenceAdapterDepsForTesting,
} from "../persistence-adapter";
import {
  setPersistenceDeps,
  _resetForTesting as resetPersistence,
} from "../persistence";
import type { ConversationBinding } from "../turn-spec";

export interface LifecycleFixtureOptions {
  beforeProfileAdmission?(): Promise<void>;
  beforeForkAdmission?(): Promise<void>;
  /** Runs ahead of every admission-state read; throwing fails that read. */
  beforeAdmissionStateRead?(): Promise<void>;
  verifyDebugCleanup?: import("../actor-host").ConversationMachineDependencies["verifyDebugCleanup"];
  address?: ConversationAddress;
  binding?: ConversationBinding;
  conversation?: Partial<ConversationState>;
  actorDeps?: Partial<ActorFixtureDependencies>;
  /**
   * Checkpoint seams the manager composes. `generate` defaults to the real
   * generator over the fixture's task runner; `backendSupportsCheckpoint`
   * defaults to true so the enabled path is exercised, since no production
   * descriptor claims it yet. The read seams and the repository wrap the
   * fixture's own so a test can gate or fail one call and fall through.
   */
  checkpoint?: Partial<
    Pick<
      ConversationCheckpointDependencies,
      "generate" | "backendSupportsCheckpoint" | "findArtifact" | "now"
    >
  > & {
    readEntries?(
      transcriptPath: string | null,
      read: ConversationCheckpointDependencies["readEntries"],
    ): Promise<TranscriptEntriesResult>;
    readConversation?(
      identity: Parameters<
        ConversationCheckpointDependencies["readConversation"]
      >[0],
      read: ConversationCheckpointDependencies["readConversation"],
    ): Promise<ConversationState | null>;
    repo?(repo: ConversationCheckpointsRepo): ConversationCheckpointsRepo;
  };
  /** Queue seams layered over the fixture's real service. */
  queue?: Partial<
    Pick<ConversationQueueDeps, "claimNextTurnBatch" | "runConversationCommand">
  >;
}

/** Composes the production lifecycle over an isolated store and provider seams. */
export async function createLifecycleFixture(
  options: LifecycleFixtureOptions = {},
) {
  resetRuntime();
  // One write queue for the store and the checkpoint repository, as in
  // production: a readiness commit and a row mutation serialize as whole
  // tasks rather than interleaving their read-modify-write halves.
  const writeQueue = createWriteQueue();
  const persistence = createPersistenceFixture({ writeQueue });
  const realCheckpoints = createConversationCheckpointsRepo(
    persistence.db,
    writeQueue,
    persistence.store.checkpointContinuation,
  );
  const checkpoints =
    options.checkpoint?.repo?.(realCheckpoints) ?? realCheckpoints;
  /** Transcript archives keyed by path; tests append to drive source changes. */
  const transcripts = new Map<string, TranscriptEntryWithSeq[]>();
  async function readEntries(
    transcriptPath: string | null,
  ): Promise<TranscriptEntriesResult> {
    const entries =
      transcriptPath === null ? [] : (transcripts.get(transcriptPath) ?? []);
    return { entries: [...entries], maxSeq: entries.at(-1)?.seq ?? -1 };
  }
  let backgroundActivity: ConversationBackgroundActivity | null = null;
  /** User entries the checkpoint queue repair appended, by conversation. */
  const repairedUserEntries: { conversationId: string; id: string }[] = [];
  /** Counts every background change, as the production channel's epoch does. */
  let backgroundEpoch = 0;
  const address = options.binding?.address ??
    options.address ?? {
      projectPath: "/lifecycle-fixture",
      target: {
        scope: "session",
        projectName: "lifecycle-fixture",
        sessionName: "s",
        conversationId: "c",
      },
    };
  const identity = {
    projectPath: address.projectPath,
    sessionName: conversationTargetStoreSessionName(address.target),
    conversationId: address.target.conversationId,
  };
  const projectName = address.target.projectName;
  persistence.seedProject(identity.projectPath);
  const binding: ConversationBinding = options.binding ?? {
    kind: "durable",
    address,
  };
  if (address.target.scope === "session")
    persistence.seedSession(identity.projectPath, identity.sessionName);
  if (binding.kind === "durable") {
    const conversation = makeConversationState({
      ...options.conversation,
      id: identity.conversationId,
    });
    if (address.target.scope === "project")
      await persistence.seedProjectConversation(
        identity.projectPath,
        conversation,
      );
    else
      await persistence.seedConversation(
        identity.projectPath,
        identity.sessionName,
        conversation,
      );
  }
  const queue = createMessageQueueService({
    ...persistence.deps,
    getProjectDisplayName: () => projectName,
    broadcast: () => {},
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  });
  const installPersistenceDeps = () =>
    setPersistenceDeps({
      getConversationMachineSnapshot:
        persistence.store.getConversationMachineSnapshot,
      upsertConversationMachineSnapshot:
        persistence.store.upsertConversationMachineSnapshot,
      deleteConversationMachineSnapshot:
        persistence.store.deleteConversationMachineSnapshot,
    });
  installPersistenceDeps();
  setConversationPersistenceAdapterDeps({
    mutateConversation: persistence.store.mutateConversation,
    publishSessionStatus: () => ({ delivered: true }),
    queueAutoName: () => {},
  });
  const checkpointNow =
    options.checkpoint?.now ?? (() => new Date().toISOString());
  const actorDependencies = createActorDependenciesFixture({
    ...persistence.deps,
    confirmQueuedDelivery: queue.confirmDelivery,
    markQueuedUncertain: queue.markUncertain,
    markQueuedPending: queue.markPending,
    markQueuedFailed: queue.markFailed,
    // The delivery turn binds, reads and accepts against the same repository
    // the manager's maintenance wrote, as production does.
    checkpoint: { repo: async () => checkpoints, now: checkpointNow },
    getTaskRunner: () => ({
      backend: "claude",
      async run() {
        return {
          text: "completed",
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    }),
    ...options.actorDeps,
  });
  const conversationActors = createTestActorImplementations(actorDependencies);
  /** The production restart rules over the fixture's repository. */
  const hydrateAuthority = (
    key: Parameters<typeof hydrateCheckpointAuthority>[0],
  ) =>
    hydrateCheckpointAuthority(key, {
      repo: checkpoints,
      now: checkpointNow,
      log: createLogger("conversation-manager"),
    });
  const createCore = (): ReturnType<typeof createConversationManagerFixture> =>
    createConversationManagerFixture({
      verifyDebugCleanup: options.verifyDebugCleanup,
      loadActors: async () => conversationActors,
      dependencies: {
        readRuntimeInstructions: (input) =>
          readRuntimeInstructions(
            { execution: actorDependencies, context: actorDependencies },
            input,
            undefined,
          ),
        loadActorInput: (projectPath, sessionName, conversationId) =>
          loadActorInput(
            {
              getSession: persistence.store.getSession,
              getProjectConversation: persistence.store.getProjectConversation,
              getProjectDisplayName: () => projectName,
              hydrateCheckpointAuthority: hydrateAuthority,
            },
            projectPath,
            sessionName,
            conversationId,
          ),
        async readAdmissionState(key) {
          await options.beforeAdmissionStateRead?.();
          const row = await persistence.store.getConversation(
            key.projectPath,
            key.sessionName,
            key.conversationId,
          );
          return {
            found: row !== null,
            requiresQueueReview:
              row?.pendingQueue.some((item) => item.status === "uncertain") ??
              false,
          };
        },
        admitCheckpointForkForTurn: async (
          key,
          backend,
          _selection,
          isCurrent,
        ) => {
          await options.beforeForkAdmission?.();
          await admitCheckpointForkSubmission(
            persistence.store,
            key,
            backend,
            isCurrent,
          );
          return null;
        },
        admitProfileForTurn: (key) =>
          admitConversationProfile(
            {
              async mutateConversation(p, s, c, label, mutate) {
                await options.beforeProfileAdmission?.();
                return persistence.store.mutateConversation(
                  p,
                  s,
                  c,
                  label,
                  mutate,
                );
              },
            },
            key,
          ),
        queue: {
          ...queue,
          submitTurn: (input) => core.manager.submitConversationTurn(input),
          async runConversationCommand() {
            throw new Error("No command expected");
          },
          ...options.queue,
        },
        checkpoint: {
          async repo() {
            return checkpoints;
          },
          readConversation: (key) => {
            const read: ConversationCheckpointDependencies["readConversation"] =
              (identity) =>
                persistence.store.getConversation(
                  identity.projectPath,
                  identity.sessionName,
                  identity.conversationId,
                );
            return options.checkpoint?.readConversation
              ? options.checkpoint.readConversation(key, read)
              : read(key);
          },
          readEntries: (transcriptPath) =>
            options.checkpoint?.readEntries
              ? options.checkpoint.readEntries(transcriptPath, readEntries)
              : readEntries(transcriptPath),
          findArtifact:
            options.checkpoint?.findArtifact ??
            (async (): Promise<ContextArtifactRow | null> => null),
          async resolveConfig() {
            return compactionConfigSchema.parse({});
          },
          executeTaskRun: (input) => core.executeWorkflowTaskRun(input),
          backendSupportsCheckpoint:
            options.checkpoint?.backendSupportsCheckpoint ?? (() => true),
          async appendUserEntryOnce(conversationId, entry) {
            repairedUserEntries.push({ conversationId, id: entry.id });
          },
          confirmQueuedDelivery: (input) => queue.confirmDelivery(input),
          getBackgroundActivity: () => backgroundActivity,
          getBackgroundActivityEpoch: () => backgroundEpoch,
          generate: options.checkpoint?.generate ?? generateCheckpoint,
          now: checkpointNow,
        },
      },
    });
  let core = createCore();

  const fixture = {
    get manager() {
      return core.manager;
    },
    get host() {
      return core.host;
    },
    get registry() {
      return core.registry;
    },
    actor(projectPath: string, sessionName: string, conversationId: string) {
      return core.actor(projectPath, sessionName, conversationId);
    },
    executeWorkflowTaskRun: (
      input: Parameters<typeof core.executeWorkflowTaskRun>[0],
    ) => core.executeWorkflowTaskRun(input),
    providedMachine: (adapter: Parameters<typeof core.providedMachine>[0]) =>
      core.providedMachine(adapter),
    dispose: () => core.dispose(),
    persistence,
    queue,
    identity,
    projectName,
    binding,
    checkpoints,
    transcripts,
    repairedUserEntries,
    hydrateCheckpointAuthority: hydrateAuthority,
    setBackgroundActivity(activity: ConversationBackgroundActivity | null) {
      backgroundActivity = activity;
      backgroundEpoch += 1;
    },
    /**
     * A process crash and a fresh server over the same database: every live
     * actor is discarded without stopping its turn, closing its runtime or
     * settling its receipts, the in-memory runtime registry and the snapshot
     * debounce timers are dropped (an unflushed snapshot is lost, as it would
     * be), and a new manager is composed over the same store, repository,
     * queue and provider seams. Durable rows are exactly what the crash left.
     */
    restart() {
      for (const [key, actor] of core.host.entries()) {
        try {
          actor.stop();
        } catch {
          // A stopped or broken actor is what a crash leaves behind anyway.
        }
        core.host.remove(key, actor);
      }
      resetRuntime();
      resetPersistence();
      installPersistenceDeps();
      core = createCore();
      return fixture;
    },
    async close() {
      try {
        await core.manager.stopConversationActor(
          identity.projectPath,
          identity.sessionName,
          identity.conversationId,
          "fixture_cleanup",
        );
      } catch (error) {
        // A host held for checkpoint reconciliation refuses eviction by
        // design; the registry reset below discards it for the next test.
        if (!(error instanceof ConversationMaintenanceActiveError)) throw error;
      }
      resetRuntime();
      resetPersistence();
      _resetConversationPersistenceAdapterDepsForTesting();
      persistence.close();
    },
  };
  return fixture;
}
