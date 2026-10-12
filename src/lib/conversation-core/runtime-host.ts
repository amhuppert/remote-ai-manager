import type {
  ConversationBackendCreateInput,
  ConversationBackendFactory,
  ConversationBackendRuntime,
} from "@/lib/agent-backends/conversation";
import type {
  BackendModelSelection,
  CaptureMode,
} from "@/lib/agent-backends/schemas";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { ExecutionClass } from "@/lib/agent-backends/execution-schemas";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { Logger } from "@/lib/logging";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import {
  runtimeConfigurationChanges,
  type DesiredRuntimeConfiguration,
} from "@/lib/conversation-core/turn/runtime-recreate";
import {
  ManagedConversationRuntime,
  type BackendRuntimeIndex,
} from "@/lib/conversation-core/turn/runtime-binding";

import type { AdmittedConversationProfile } from "@/lib/conversations/profile-admission";
import type {
  ComposedTooling,
  RuntimeApplicationState,
} from "./runtime-application-state";

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
  instructionSelection: {
    askUserQuestionsEnabled?: boolean;
    autonomous: boolean;
  };
}

export interface RuntimeHostDeps {
  factory(backend: AgentBackendId): ConversationBackendFactory;
  instructions(
    conversation: HostedConversation,
    selection: RuntimeRequirements["instructionSelection"],
  ): Promise<{
    sessionInstructions: string[];
    alignmentVersion: number | null;
    /** Whether the session charter applies to this runtime's turn (an attended session turn). */
    alignmentEligible: boolean;
  }>;
  tooling(conversation: HostedConversation): Promise<ComposedTooling>;
  /** Every runtime created for turns is seeded before it is handed out; a failure fails the creation. A capture runtime is not. */
  beginSeed: RuntimeApplicationState["beginSeed"];
  callbacks(
    conversation: HostedConversation,
    /** Keeps late work the runtime's callbacks start (notices, loss handling) open until the runtime closes. */
    track: (work: Promise<void>) => void,
  ): Pick<
    ConversationBackendCreateInput,
    | "onCostSettled"
    | "onBackgroundActivity"
    | "onBackgroundTasksLost"
    | "onExternalTurnEvent"
    | "onOwedWorkChanged"
    | "onTerminated"
  >;
  index: BackendRuntimeIndex;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export interface RuntimeHost {
  obtain(
    conversation: HostedConversation,
    requirements: RuntimeRequirements,
  ): Promise<{ runtime: ConversationBackendRuntime; created: boolean }>;
  replace(
    conversationId: string,
    persistedRef: AgentSessionRef | null,
  ): Promise<ConversationBackendRuntime>;
  /**
   * A runtime for a checkpoint's handoff capture: the conversation's own
   * session, resumed with the capture's purpose and no session instructions,
   * hosted in place of any live runtime so a release closes it.
   */
  obtainForCapture(
    conversation: HostedConversation,
    capture: CaptureRequest,
  ): Promise<ConversationBackendRuntime>;
  release(conversationId: string): Promise<void>;
  /**
   * What a turn with these needs would change in the conversation's live
   * runtime (the dimensions `runtimeConfigurationChanges` names); empty when
   * nothing would, or when no runtime is live. The runtime is left as it is.
   * An empty answer for a live runtime is the turn's decision: its next
   * `obtain` reuses that runtime without comparing again, so a configuration
   * saved meanwhile applies at the next check rather than closing work the
   * turn's input was prepared for.
   */
  drift(
    conversation: HostedConversation,
    requirements: RuntimeRequirements,
  ): Promise<string[]>;
  /**
   * Closes again a runtime whose close failed (a checkpoint's reconcile or
   * recovery); throws if it fails again. Only then may a new runtime start.
   */
  retryRelease(conversationId: string): Promise<void>;
  /** Why the conversation's runtime could not be closed or collected, or null. */
  closeFailure(conversationId: string): string | null;
  /** Whether the conversation's next turn would reuse a live runtime rather than create one. */
  isLive(conversationId: string): boolean;
  /** The live runtime the conversation's running turn holds, or null. */
  runtime(conversationId: string): ConversationBackendRuntime | null;
  /** The session charter the conversation's latest runtime was created with, and whether it applied to that runtime's turn. */
  alignment(
    conversationId: string,
  ): { version: number | null; eligible: boolean } | null;
  /** Records unverified process cleanup; true the first time. Closing then fails and no new runtime starts. */
  recordCleanupFailure(
    conversationId: string,
    failure: { kind: "cleanup_unverified"; message: string },
  ): boolean;
  releaseAll(): Promise<void>;
}

/** What a handoff capture's runtime is created for. */
interface CaptureRequest {
  modelSelection: BackendModelSelection;
  captureId: string;
  mode: CaptureMode;
}

interface Hosted {
  managed: ManagedConversationRuntime;
  conversation: HostedConversation;
  requirements: RuntimeRequirements;
  /** A close that failed: the old process may still run, so nothing new starts here. */
  closeFailure: Error | null;
  /** The live runtime a turn's drift check decided to reuse, until that turn's obtain takes it. */
  kept: ConversationBackendRuntime | null;
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
  /**
   * The charter each conversation's latest runtime was created with. It
   * outlives the runtime's close, so a turn whose acceptance bookkeeping
   * overlaps a stop still knows what the agent received.
   */
  const charters = new Map<
    string,
    { version: number | null; eligible: boolean }
  >();

  async function desiredFor(
    conversation: HostedConversation,
    requirements: RuntimeRequirements,
  ): Promise<{
    desired: DesiredRuntimeConfiguration;
    sessionInstructions: string[];
    alignment: { version: number | null; eligible: boolean };
  }> {
    const { sessionInstructions, alignmentVersion, alignmentEligible } =
      await deps.instructions(conversation, requirements.instructionSelection);
    return {
      sessionInstructions,
      alignment: { version: alignmentVersion, eligible: alignmentEligible },
      desired: {
        backend: conversation.backend,
        modelSelection: requirements.modelSelection,
        alignmentVersion,
        ...(requirements.fsWritePolicy !== undefined
          ? { fsWritePolicy: requirements.fsWritePolicy }
          : {}),
        repeatableInstructions: sessionInstructions,
        instructionSelection: requirements.instructionSelection,
      },
    };
  }

  async function create(
    entry: Hosted,
    capture?: CaptureRequest,
  ): Promise<ConversationBackendRuntime> {
    const { conversation, requirements, managed } = entry;
    // A capture resumes the session as it stands: its instructions are the session's own.
    const { desired, sessionInstructions, alignment } =
      capture === undefined
        ? await desiredFor(conversation, requirements)
        : {
            desired: {
              backend: conversation.backend,
              modelSelection: requirements.modelSelection,
              alignmentVersion: null,
              repeatableInstructions: [],
              instructionSelection: requirements.instructionSelection,
            },
            sessionInstructions: [],
            alignment: null,
          };
    // Opened before composing, so a save landing during creation stays pending. A capture
    // runtime gets no tooling: its mode is established on a session with none.
    const seeding =
      capture === undefined ? await deps.beginSeed(conversation) : null;
    const composed =
      capture === undefined ? await deps.tooling(conversation) : null;
    if (managed.backend !== undefined) {
      try {
        await managed.close();
      } catch (error) {
        entry.closeFailure =
          error instanceof Error ? error : new Error(String(error));
        deps.log.error("conversation_core.runtime_close_failed", {
          conversationId: conversation.conversationId,
          error: entry.closeFailure.message,
        });
        throw entry.closeFailure;
      }
    }
    const incarnation = managed.beginCreation();
    const runtime = await deps.factory(conversation.backend).createRuntime({
      ...(capture !== undefined
        ? { initialPurpose: { kind: "checkpoint_handoff", ...capture } }
        : {}),
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
      tooling: composed?.overrides ?? {},
      ...(requirements.fsWritePolicy !== undefined
        ? { fsWritePolicy: requirements.fsWritePolicy }
        : {}),
      ...deps.callbacks(conversation, (work) => {
        // A failure is the work's own to report; tracking only holds the close open for it.
        void managed.track(work).catch(() => {});
      }),
    });
    managed.install(incarnation, runtime, desired, deps.index);
    if (alignment !== null)
      charters.set(conversation.conversationId, alignment);
    deps.log.info("conversation_core.runtime_created", {
      conversationId: conversation.conversationId,
      backend: conversation.backend,
      resumed: conversation.persistedRef !== null,
      purpose: capture === undefined ? "turn" : "checkpoint_handoff",
    });
    // Installed first, so a failed seed leaves the runtime for the turn's release to close.
    if (seeding !== null && composed !== null)
      await seeding.commit(composed, runtime);
    return runtime;
  }

  /** How `requirements` differ from what the entry's live runtime was created with; empty when none is live. */
  async function changesFor(
    entry: Hosted | undefined,
    conversation: HostedConversation,
    requirements: RuntimeRequirements,
  ): Promise<string[]> {
    if (entry?.managed.backend?.status !== "alive") return [];
    const { desired } = await desiredFor(conversation, requirements);
    return runtimeConfigurationChanges({
      current: entry.managed.configurationSnapshot,
      desired,
    });
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
        kept: null,
      };
      entry.conversation = conversation;
      entry.requirements = requirements;
      hosted.set(conversation.conversationId, entry);
      const live = entry.managed.backend;
      const decided = entry.kept;
      entry.kept = null;
      // A runtime is live here only when custody kept it for this turn (design C5b §4.1).
      if (live !== undefined && live.status === "alive") {
        if (decided === live) return { runtime: live, created: false };
        const changes = await changesFor(entry, conversation, requirements);
        if (changes.length === 0) return { runtime: live, created: false };
        deps.log.info("conversation_core.runtime_recreate", {
          conversationId: conversation.conversationId,
          changes,
        });
      }
      return { runtime: await create(entry), created: true };
    },

    async drift(conversation, requirements) {
      const entry = hosted.get(conversation.conversationId);
      if (entry === undefined) return [];
      entry.kept = null;
      const live = entry.managed.backend;
      const changes = await changesFor(entry, conversation, requirements);
      if (changes.length === 0 && live?.status === "alive") entry.kept = live;
      return changes;
    },

    async obtainForCapture(conversation, capture) {
      const existing = hosted.get(conversation.conversationId);
      if (existing?.closeFailure != null) {
        throw new Error(
          `Conversation ${conversation.conversationId} cannot start a runtime: its previous one did not close (${existing.closeFailure.message})`,
        );
      }
      const requirements: RuntimeRequirements = {
        modelSelection: capture.modelSelection,
        instructionSelection: { autonomous: true },
      };
      const entry: Hosted = existing ?? {
        managed: new ManagedConversationRuntime(conversation.conversationId),
        conversation,
        requirements,
        closeFailure: null,
        kept: null,
      };
      entry.conversation = conversation;
      entry.requirements = requirements;
      entry.kept = null;
      hosted.set(conversation.conversationId, entry);
      return create(entry, capture);
    },

    async replace(conversationId, persistedRef) {
      const entry = hosted.get(conversationId);
      if (entry === undefined)
        throw new Error(
          `Conversation ${conversationId} has no hosted runtime to replace`,
        );
      entry.conversation = { ...entry.conversation, persistedRef };
      return create(entry);
    },

    alignment(conversationId) {
      return charters.get(conversationId) ?? null;
    },
    runtime(conversationId) {
      const backend = hosted.get(conversationId)?.managed.backend ?? null;
      return backend?.status === "alive" ? backend : null;
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
      return (
        entry?.closeFailure?.message ??
        entry?.managed.cleanupFailure?.message ??
        null
      );
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
        entry.closeFailure =
          error instanceof Error ? error : new Error(String(error));
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
      await Promise.allSettled(
        ids.map((conversationId) => host.release(conversationId)),
      );
    },
  };
  return host;
}
