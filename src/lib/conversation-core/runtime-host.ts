import type {
  ConversationBackendCreateInput,
  ConversationBackendFactory,
  ConversationBackendRuntime,
} from "@/lib/agent-backends/conversation";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { ExecutionClass } from "@/lib/agent-backends/execution-schemas";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { Logger } from "@/lib/logging";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import {
  runtimeConfigurationChanges,
  type DesiredRuntimeConfiguration,
} from "@/lib/workflows/conversation/pre-turn/runtime-recreate";
import {
  ManagedConversationRuntime,
  type BackendRuntimeIndex,
} from "@/lib/workflows/conversation/core-coexistence";

import type { AdmittedConversationProfile } from "@/lib/conversations/profile-admission";
import type { ComposedTooling, RuntimeApplicationState } from "./runtime-application-state";

export interface HostedConversation {
  conversationId: string;
  projectPath: string;
  projectName: string;
  target: ConversationTarget;
  worktreePath: string;
  backend: AgentBackendId;
  executionClass: ExecutionClass;
  persistedRef: AgentSessionRef | null;
  /**
   * The conversation the agent acts as when it calls CC (CC_CONVERSATION).
   * Set for session conversations whose agent must prove who it is, such as a
   * supervised seat reporting task progress; absent for every other runtime.
   */
  callerIdentity?: string;
  /** The profile admitted for this turn; instructions carry its stored block rather than re-reading the row. */
  profile?: AdmittedConversationProfile;
}

export interface RuntimeRequirements {
  modelSelection: BackendModelSelection;
  fsWritePolicy?: FsWritePolicy;
  instructionSelection: { askUserQuestionsEnabled?: boolean; autonomous: boolean };
}

export interface RuntimeHostDeps {
  factory(backend: AgentBackendId): ConversationBackendFactory;
  instructions(
    conversation: HostedConversation,
    selection: RuntimeRequirements["instructionSelection"],
  ): Promise<{ sessionInstructions: string[]; alignmentVersion: number | null }>;
  tooling(conversation: HostedConversation): Promise<ComposedTooling>;
  /** Every runtime created is seeded before it is handed out; a failure fails the creation. */
  beginSeed: RuntimeApplicationState["beginSeed"];
  callbacks(
    conversation: HostedConversation,
  ): Pick<ConversationBackendCreateInput, "onCostSettled" | "onBackgroundActivity" | "onBackgroundTasksLost">;
  index: BackendRuntimeIndex;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export interface RuntimeHost {
  obtain(
    conversation: HostedConversation,
    requirements: RuntimeRequirements,
  ): Promise<{ runtime: ConversationBackendRuntime; created: boolean }>;
  replace(conversationId: string, persistedRef: AgentSessionRef | null): Promise<ConversationBackendRuntime>;
  release(conversationId: string): Promise<void>;
  /**
   * Closes again a runtime whose close failed (a checkpoint's reconcile or
   * recovery); throws if it fails again. Only then may a new runtime start.
   */
  retryRelease(conversationId: string): Promise<void>;
  /** Why the conversation's runtime could not be closed or collected, or null. */
  closeFailure(conversationId: string): string | null;
  /** Whether the conversation's next turn would reuse a live runtime rather than create one. */
  isLive(conversationId: string): boolean;
  /** Records unverified process cleanup; true the first time. Closing then fails and no new runtime starts. */
  recordCleanupFailure(conversationId: string, failure: { kind: "cleanup_unverified"; message: string }): boolean;
  releaseAll(): Promise<void>;
}

interface Hosted {
  managed: ManagedConversationRuntime;
  conversation: HostedConversation;
  requirements: RuntimeRequirements;
  /** A close that failed: the old process may still run, so nothing new starts here. */
  closeFailure: Error | null;
}

/**
 * The runtimes of core-owned conversations: one managed handle per
 * conversation, created from that conversation's current instructions,
 * tooling and continuity, and replaced whenever what it was created with
 * changes. Turns on one conversation are serialized by the core, so a host
 * entry is never obtained concurrently.
 */
export function createRuntimeHost(deps: RuntimeHostDeps): RuntimeHost {
  const hosted = new Map<string, Hosted>();

  async function desiredFor(
    conversation: HostedConversation,
    requirements: RuntimeRequirements,
  ): Promise<{ desired: DesiredRuntimeConfiguration; sessionInstructions: string[] }> {
    const { sessionInstructions, alignmentVersion } = await deps.instructions(
      conversation,
      requirements.instructionSelection,
    );
    return {
      sessionInstructions,
      desired: {
        backend: conversation.backend,
        modelSelection: requirements.modelSelection,
        alignmentVersion,
        ...(requirements.fsWritePolicy !== undefined ? { fsWritePolicy: requirements.fsWritePolicy } : {}),
        repeatableInstructions: sessionInstructions,
        instructionSelection: requirements.instructionSelection,
      },
    };
  }

  async function create(entry: Hosted): Promise<ConversationBackendRuntime> {
    const { conversation, requirements, managed } = entry;
    const { desired, sessionInstructions } = await desiredFor(conversation, requirements);
    // Opened before composing, so a save landing during creation stays pending.
    const seeding = await deps.beginSeed(conversation);
    const composed = await deps.tooling(conversation);
    if (managed.backend !== undefined) {
      try {
        await managed.close();
      } catch (error) {
        entry.closeFailure = error instanceof Error ? error : new Error(String(error));
        deps.log.error("conversation_core.runtime_close_failed", {
          conversationId: conversation.conversationId,
          error: entry.closeFailure.message,
        });
        throw entry.closeFailure;
      }
    }
    const incarnation = managed.beginCreation();
    const runtime = await deps.factory(conversation.backend).createRuntime({
      executionClass: conversation.executionClass,
      conversationId: conversation.conversationId,
      projectPath: conversation.projectPath,
      projectName: conversation.projectName,
      conversationTarget: conversation.target,
      worktreePath: conversation.worktreePath,
      persistedRef: conversation.persistedRef,
      ...(conversation.callerIdentity !== undefined
        ? { workflowCallerConversationId: conversation.callerIdentity }
        : {}),
      modelSelection: requirements.modelSelection,
      sessionInstructions,
      tooling: composed.overrides,
      ...(requirements.fsWritePolicy !== undefined ? { fsWritePolicy: requirements.fsWritePolicy } : {}),
      ...deps.callbacks(conversation),
    });
    managed.install(incarnation, runtime, desired, deps.index);
    deps.log.info("conversation_core.runtime_created", {
      conversationId: conversation.conversationId,
      backend: conversation.backend,
      resumed: conversation.persistedRef !== null,
    });
    // Installed first, so a failed seed leaves the runtime for the turn's release to close.
    await seeding.commit(composed, runtime);
    return runtime;
  }

  const host: RuntimeHost = {
    async obtain(conversation, requirements) {
      const existing = hosted.get(conversation.conversationId);
      if (existing?.closeFailure != null) {
        throw new Error(
          `Conversation ${conversation.conversationId} cannot start a runtime: its previous one did not close (${existing.closeFailure.message})`,
        );
      }
      const entry: Hosted = existing ?? {
        managed: new ManagedConversationRuntime(conversation.conversationId),
        conversation,
        requirements,
        closeFailure: null,
      };
      entry.conversation = conversation;
      entry.requirements = requirements;
      hosted.set(conversation.conversationId, entry);
      const live = entry.managed.backend;
      if (live !== undefined && live.status === "alive") {
        const { desired } = await desiredFor(conversation, requirements);
        const changes = runtimeConfigurationChanges({ current: entry.managed.configurationSnapshot, desired });
        if (changes.length === 0) return { runtime: live, created: false };
        deps.log.info("conversation_core.runtime_recreate", { conversationId: conversation.conversationId, changes });
      }
      return { runtime: await create(entry), created: true };
    },

    async replace(conversationId, persistedRef) {
      const entry = hosted.get(conversationId);
      if (entry === undefined) throw new Error(`Conversation ${conversationId} has no hosted runtime to replace`);
      entry.conversation = { ...entry.conversation, persistedRef };
      return create(entry);
    },

    isLive(conversationId) {
      return hosted.get(conversationId)?.managed.backend?.status === "alive";
    },

    recordCleanupFailure(conversationId, failure) {
      const entry = hosted.get(conversationId);
      if (entry === undefined) return false;
      return entry.managed.recordCleanupFailure(failure);
    },
    closeFailure(conversationId) {
      const entry = hosted.get(conversationId);
      return entry?.closeFailure?.message ?? entry?.managed.cleanupFailure?.message ?? null;
    },
    async retryRelease(conversationId) {
      const entry = hosted.get(conversationId);
      if (entry === undefined) return;
      entry.managed.reconcileClose();
      entry.closeFailure = null;
      await host.release(conversationId);
    },
    async release(conversationId) {
      const entry = hosted.get(conversationId);
      if (entry === undefined) return;
      try {
        await entry.managed.close();
      } catch (error) {
        entry.closeFailure = error instanceof Error ? error : new Error(String(error));
        deps.log.error("conversation_core.runtime_close_failed", {
          conversationId,
          error: entry.closeFailure.message,
        });
        throw entry.closeFailure;
      }
      hosted.delete(conversationId);
    },

    async releaseAll() {
      const ids = [...hosted.keys()];
      await Promise.allSettled(ids.map((conversationId) => host.release(conversationId)));
    },
  };
  return host;
}
