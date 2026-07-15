/**
 * Scoped agent-capability override persistence.
 *
 * Project, session, and conversation overrides are additive optional fields on
 * existing state records (`agentCapabilityOverrides` on `ProjectState`,
 * `SessionState`, `ConversationState`). Project conversations use the
 * project-conversation state boundary while session conversations use the
 * session conversation boundary. This store exposes per-layer patch methods
 * that:
 *
 *   - Apply patch batches through `applyCapabilityOperations()` so the same
 *     set/reset/prune semantics used at the global layer are reused here.
 *   - Route every write through the existing state-manager mutation boundary
 *     (`mutateState`, `mutateSession`, `mutateConversation`) so the all-or-
 *     nothing write contract and the per-aggregate write mutex are preserved.
 *   - Never store a resolved view; only the cascade actually patched is
 *     written, and untouched cascades on the layer are passed through.
 *   - Strip the `agentCapabilityOverrides` field entirely once every cascade
 *     has been reset away, keeping the persisted state slim.
 */

import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";
import { createLogger } from "@/lib/logging";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityOverrideOperation,
  AgentCapabilityOverrides,
} from "./schemas";
import type { ProjectState } from "@/lib/projects/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { getStateStore, type StateStore } from "@/lib/state-store";

import { applyCapabilityOperations } from "./patch";

const logger = createLogger("agent-capabilities.scope-store");

type StateManager = StateStore;

export interface ScopeCapabilityOverrideStoreDeps {
  stateManager: StateManager;
}

export interface ScopeCapabilityPatchInput {
  cascadeKind: AgentCapabilityCascadeKind;
  operations: readonly AgentCapabilityOverrideOperation[];
  /**
   * Optional guard run inside the state-manager mutation boundary after the
   * snapshot has been taken and before the new overrides are applied.
   * Throwing from the precondition aborts the mutation without persisting
   * and propagates the error to the caller. Used by the mutation service
   * for atomic expected-hash conflict detection.
   */
  precondition?(
    current: AgentCapabilityOverrides | undefined,
  ): Promise<void> | void;
}

export interface ScopeCapabilityPatchResult {
  overrides: AgentCapabilityOverrides;
  changedItemIds: readonly string[];
}

export interface ScopeCapabilityOverrideStore {
  patchProject(
    projectPath: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult>;
  patchSession(
    projectPath: string,
    sessionName: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult>;
  patchConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult>;
  patchProjectConversation(
    projectPath: string,
    conversationId: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult>;
}

export function createScopeCapabilityOverrideStore(
  deps: ScopeCapabilityOverrideStoreDeps,
): ScopeCapabilityOverrideStore {
  const { stateManager } = deps;

  async function patchProject(
    projectPath: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult> {
    return stateManager.mutateState(
      `agent-capabilities.patchProject[${projectPath}]`,
      async (state) => {
        const project = state.projects[projectPath];
        if (!project) {
          throw new Error(`Project "${projectPath}" not found`);
        }
        if (input.precondition) {
          await input.precondition(project.agentCapabilityOverrides);
        }
        const result = patchAndPrune(project.agentCapabilityOverrides, input);
        writeOrDelete(project, result.overrides);
        logPatch(
          "project",
          projectPath,
          input.cascadeKind,
          result.changedItemIds,
        );
        return result;
      },
    );
  }

  async function patchSession(
    projectPath: string,
    sessionName: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult> {
    return stateManager.mutateSession(
      projectPath,
      sessionName,
      "agent-capabilities.patchSession",
      async (session) => {
        if (input.precondition) {
          await input.precondition(session.agentCapabilityOverrides);
        }
        const result = patchAndPrune(session.agentCapabilityOverrides, input);
        writeOrDelete(session, result.overrides);
        logPatch(
          "session",
          `${projectPath}/${sessionName}`,
          input.cascadeKind,
          result.changedItemIds,
        );
        return result;
      },
    );
  }

  async function patchConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult> {
    return stateManager.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "agent-capabilities.patchConversation",
      async (conversation) => {
        if (input.precondition) {
          await input.precondition(conversation.agentCapabilityOverrides);
        }
        const result = patchAndPrune(
          conversation.agentCapabilityOverrides,
          input,
        );
        writeOrDelete(conversation, result.overrides);
        logPatch(
          "conversation",
          `${projectPath}/${sessionName}/${conversationId}`,
          input.cascadeKind,
          result.changedItemIds,
        );
        return result;
      },
    );
  }

  async function patchProjectConversation(
    projectPath: string,
    conversationId: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult> {
    return stateManager.mutateConversation(
      projectPath,
      PROJECT_CONVERSATION_SESSION_SENTINEL,
      conversationId,
      "agent-capabilities.patchProjectConversation",
      async (conversation) => {
        if (input.precondition) {
          await input.precondition(conversation.agentCapabilityOverrides);
        }
        const result = patchAndPrune(
          conversation.agentCapabilityOverrides,
          input,
        );
        writeOrDelete(conversation, result.overrides);
        logPatch(
          "project-conversation",
          `${projectPath}/${conversationId}`,
          input.cascadeKind,
          result.changedItemIds,
        );
        return result;
      },
    );
  }

  return {
    patchProject,
    patchSession,
    patchConversation,
    patchProjectConversation,
  };
}

function patchAndPrune(
  current: AgentCapabilityOverrides | undefined,
  input: ScopeCapabilityPatchInput,
): ScopeCapabilityPatchResult {
  const base: AgentCapabilityOverrides = current ?? { cascades: {} };
  return applyCapabilityOperations({
    current: base,
    cascadeKind: input.cascadeKind,
    operations: input.operations,
  });
}

type CapabilityFieldHolder = ProjectState | SessionState | ConversationState;

function writeOrDelete(
  target: CapabilityFieldHolder,
  value: AgentCapabilityOverrides,
): void {
  if (Object.keys(value.cascades).length === 0) {
    delete target.agentCapabilityOverrides;
    return;
  }
  target.agentCapabilityOverrides = value;
}

function logPatch(
  scope: "project" | "session" | "conversation" | "project-conversation",
  id: string,
  cascadeKind: AgentCapabilityCascadeKind,
  changedItemIds: readonly string[],
): void {
  logger.info(`${scope}.patch`, {
    id,
    cascadeKind,
    changedCount: changedItemIds.length,
  });
}

export const defaultScopeCapabilityOverrideStore: ScopeCapabilityOverrideStore =
  createScopeCapabilityOverrideStore({ stateManager: getStateStore() });
