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
 *   - Route every write through a focused single-column mutation boundary — the
 *     project column via `mutateProjectAgentCapabilityOverrides`, session via
 *     `mutateSessionAgentCapabilityOverrides`, session conversation via
 *     `mutateConversationAgentCapabilityOverrides`, and project conversation via
 *     `mutateProjectConversationAgentCapabilityOverrides`. Each is a synchronous
 *     (`withWriteQueueSync`) conditional write of only the
 *     `agent_capability_overrides` column, never restamping `last_activity_at`
 *     (an override edit is config, not activity).
 *   - For a conflict-checked patch, the expected-hash precondition recomputes
 *     the effective hash (config discovery + whole-chain I/O) and so runs
 *     OUTSIDE the write queue; the short synchronous commit fences the target
 *     AND every state-backed ancestor the effective hash depends on (project for
 *     a session/project-conversation; project + session for a session
 *     conversation), retrying — and re-running the precondition — when any of
 *     them changed in the window. A fence miss writes nothing (no restamp), and
 *     the sanitized patch log is emitted only after the queue releases.
 *   - Never store a resolved view; only the cascade actually patched is
 *     written, and untouched cascades on the layer are passed through.
 *   - Strip the `agentCapabilityOverrides` field entirely once every cascade
 *     has been reset away, keeping the persisted state slim.
 */

import { createLogger, type Logger } from "@/lib/logging";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityOverrideOperation,
  AgentCapabilityOverrides,
} from "./schemas";
import { getStateStore, type StateStore } from "@/lib/state-store";

import { applyCapabilityOperations } from "./patch";

const defaultLogger = createLogger("agent-capabilities.scope-store");

/**
 * Upper bound on fence retries for a conflict-checked project patch. Each retry
 * costs one precondition recompute; a genuine concurrent writer resolves in one
 * retry, so the ceiling only guards against pathological unbounded contention
 * (where it surfaces a loud error rather than spinning forever).
 */
const MAX_FENCE_RETRIES = 8;

type StateManager = StateStore;

export interface ScopeCapabilityOverrideStoreDeps {
  stateManager: StateManager;
  /**
   * Sanitized patch logger. Injectable so the queue-exit-before-log ordering
   * test can observe that `logPatch` is emitted only AFTER the focused write
   * queue has released (the log is synchronous `appendFileSync` I/O and must
   * never run inside the critical section). Defaults to the module logger.
   */
  logger?: Logger;
}

export interface ScopeCapabilityPatchInput {
  cascadeKind: AgentCapabilityCascadeKind;
  operations: readonly AgentCapabilityOverrideOperation[];
  /**
   * Optional guard run OUTSIDE the write queue against the current overrides
   * read before the commit (its expected-hash recompute does config discovery +
   * whole-chain I/O, which must not hold the queue). Throwing aborts the patch
   * without persisting and propagates to the caller. The subsequent commit
   * fences the target and every state-backed ancestor the effective hash
   * depends on, retrying — and re-running this precondition — on a change, so
   * two concurrent patches sharing an expected hash cannot both succeed. Used by
   * the mutation service for atomic expected-hash conflict detection.
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
  const logger = deps.logger ?? defaultLogger;

  /**
   * Emit the sanitized patch log. Called only AFTER the focused write queue has
   * released (every call site is outside the `mutate*AgentCapabilityOverrides`
   * await), because `logger.info` reaches a synchronous `appendFileSync` in the
   * production logger and must never run inside the critical section
   * (no-slow-work-in-critical-section).
   */
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

  async function patchProject(
    projectPath: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult> {
    // No conflict check: read-patch-write atomically inside the write queue.
    // The mutator sees the FRESH persisted overrides, so concurrent patches
    // merge cleanly. Logging is emitted after the queue releases. Common path.
    if (!input.precondition) {
      const result =
        await stateManager.mutateProjectAgentCapabilityOverrides<ScopeCapabilityPatchResult>(
          projectPath,
          "agent-capabilities.patchProject",
          (current) => {
            const result = patchAndPrune(current, input);
            return {
              write: true,
              overrides: pruneEmptyCapabilityOverrides(result.overrides),
              result,
            };
          },
        );
      logPatch(
        "project",
        projectPath,
        input.cascadeKind,
        result.changedItemIds,
      );
      return result;
    }
    return patchProjectChecked(projectPath, input, input.precondition);
  }

  /**
   * Conflict-checked project patch. The precondition recomputes the effective
   * hash — discovery + whole-chain I/O — so it MUST run OUTSIDE the write queue
   * (no-slow-work-in-critical-section). That opens a window in which another
   * patch could land between the check and our commit, so the commit fences on
   * the exact overrides the precondition validated: if they changed, we retry,
   * re-running the precondition against the now-current overrides (which throws
   * the hash conflict when the effective config moved). The bounded retry keeps
   * the "two concurrent patches sharing an expected hash cannot both succeed"
   * guarantee. The project layer has no state-backed ancestor (global is
   * file-backed and fenced by the global store's own lock), so only the target
   * is fenced. Logging is emitted after the queue releases.
   */
  async function patchProjectChecked(
    projectPath: string,
    input: ScopeCapabilityPatchInput,
    precondition: NonNullable<ScopeCapabilityPatchInput["precondition"]>,
  ): Promise<ScopeCapabilityPatchResult> {
    for (let attempt = 0; attempt <= MAX_FENCE_RETRIES; attempt++) {
      const before =
        await stateManager.getProjectAgentCapabilityOverrides(projectPath);
      await precondition(before);
      const outcome =
        await stateManager.mutateProjectAgentCapabilityOverrides<CheckedPatchOutcome>(
          projectPath,
          "agent-capabilities.patchProject",
          (current) => {
            if (!overridesUnchanged(current, before)) {
              return { write: false, result: { committed: false } };
            }
            const result = patchAndPrune(current, input);
            return {
              write: true,
              overrides: pruneEmptyCapabilityOverrides(result.overrides),
              result: { committed: true, result },
            };
          },
        );
      if (outcome.committed) {
        logPatch(
          "project",
          projectPath,
          input.cascadeKind,
          outcome.result.changedItemIds,
        );
        return outcome.result;
      }
    }
    throw new Error(
      `agent-capabilities.patchProject: exceeded fence-retry limit for "${projectPath}"`,
    );
  }

  async function patchSession(
    projectPath: string,
    sessionName: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult> {
    // No conflict check: read-patch-write atomically inside the write queue — the
    // mutator sees the FRESH persisted overrides and `patchAndPrune` is pure, so
    // no slow work runs in the critical section. Logging is emitted after the
    // queue releases. Common path.
    if (!input.precondition) {
      const result =
        await stateManager.mutateSessionAgentCapabilityOverrides<ScopeCapabilityPatchResult>(
          projectPath,
          sessionName,
          "agent-capabilities.patchSession",
          (current) => {
            const result = patchAndPrune(current, input);
            return {
              write: true,
              overrides: pruneEmptyCapabilityOverrides(result.overrides),
              result,
            };
          },
        );
      logPatch(
        "session",
        `${projectPath}/${sessionName}`,
        input.cascadeKind,
        result.changedItemIds,
      );
      return result;
    }
    return patchSessionChecked(
      projectPath,
      sessionName,
      input,
      input.precondition,
    );
  }

  /**
   * Conflict-checked session patch. The precondition recomputes the effective
   * hash — discovery + whole-chain file I/O — so it MUST run OUTSIDE the write
   * queue (no-slow-work-in-critical-section), mirroring `patchProjectChecked`.
   * The session effective hash depends on the global (file), project, and
   * session layers, so the commit fences the target (session) overrides AND the
   * state-backed ancestor (project) — both read atomically inside the queue by
   * `mutateSessionAgentCapabilityOverrides`. If EITHER changed since the
   * out-of-queue snapshot, the commit writes nothing and we retry, re-running
   * the precondition against the now-current state (which throws the hash
   * conflict when the effective config moved). Because the commit is a
   * conditional focused write, a fence miss restamps no activity. Logging is
   * emitted after the queue releases.
   */
  async function patchSessionChecked(
    projectPath: string,
    sessionName: string,
    input: ScopeCapabilityPatchInput,
    precondition: NonNullable<ScopeCapabilityPatchInput["precondition"]>,
  ): Promise<ScopeCapabilityPatchResult> {
    for (let attempt = 0; attempt <= MAX_FENCE_RETRIES; attempt++) {
      const session = await stateManager.getSession(projectPath, sessionName);
      if (!session) {
        throw new Error(
          `Session "${sessionName}" not found in project "${projectPath}" during agent-capabilities.patchSession`,
        );
      }
      const beforeTarget = session.agentCapabilityOverrides;
      const beforeProject =
        await stateManager.getProjectAgentCapabilityOverrides(projectPath);
      await precondition(beforeTarget);
      const outcome =
        await stateManager.mutateSessionAgentCapabilityOverrides<CheckedPatchOutcome>(
          projectPath,
          sessionName,
          "agent-capabilities.patchSession",
          (current, ancestors) => {
            if (
              !overridesUnchanged(current, beforeTarget) ||
              !overridesUnchanged(ancestors.project, beforeProject)
            ) {
              return { write: false, result: { committed: false } };
            }
            const result = patchAndPrune(current, input);
            return {
              write: true,
              overrides: pruneEmptyCapabilityOverrides(result.overrides),
              result: { committed: true, result },
            };
          },
        );
      if (outcome.committed) {
        logPatch(
          "session",
          `${projectPath}/${sessionName}`,
          input.cascadeKind,
          outcome.result.changedItemIds,
        );
        return outcome.result;
      }
    }
    throw new Error(
      `agent-capabilities.patchSession: exceeded fence-retry limit for "${projectPath}/${sessionName}"`,
    );
  }

  async function patchConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult> {
    if (!input.precondition) {
      const result =
        await stateManager.mutateConversationAgentCapabilityOverrides<ScopeCapabilityPatchResult>(
          projectPath,
          sessionName,
          conversationId,
          "agent-capabilities.patchConversation",
          (current) => {
            const result = patchAndPrune(current, input);
            return {
              write: true,
              overrides: pruneEmptyCapabilityOverrides(result.overrides),
              result,
            };
          },
        );
      logPatch(
        "conversation",
        `${projectPath}/${sessionName}/${conversationId}`,
        input.cascadeKind,
        result.changedItemIds,
      );
      return result;
    }
    return patchConversationChecked(
      projectPath,
      sessionName,
      conversationId,
      input,
      input.precondition,
    );
  }

  /**
   * Conflict-checked session-conversation patch — same out-of-queue precondition
   * as `patchSessionChecked`, but the conversation effective hash depends on the
   * global (file), project, session, AND conversation layers, so the commit
   * fences the target (conversation) overrides plus BOTH state-backed ancestors
   * (project + session), read atomically inside the queue. A change to any of
   * the three forces a retry that re-runs the precondition.
   */
  async function patchConversationChecked(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    input: ScopeCapabilityPatchInput,
    precondition: NonNullable<ScopeCapabilityPatchInput["precondition"]>,
  ): Promise<ScopeCapabilityPatchResult> {
    for (let attempt = 0; attempt <= MAX_FENCE_RETRIES; attempt++) {
      const conversation = await stateManager.getConversation(
        projectPath,
        sessionName,
        conversationId,
      );
      if (!conversation) {
        throw new Error(
          `Conversation "${conversationId}" not found in session "${sessionName}" during agent-capabilities.patchConversation`,
        );
      }
      const beforeTarget = conversation.agentCapabilityOverrides;
      const beforeProject =
        await stateManager.getProjectAgentCapabilityOverrides(projectPath);
      const session = await stateManager.getSession(projectPath, sessionName);
      const beforeSession = session?.agentCapabilityOverrides;
      await precondition(beforeTarget);
      const outcome =
        await stateManager.mutateConversationAgentCapabilityOverrides<CheckedPatchOutcome>(
          projectPath,
          sessionName,
          conversationId,
          "agent-capabilities.patchConversation",
          (current, ancestors) => {
            if (
              !overridesUnchanged(current, beforeTarget) ||
              !overridesUnchanged(ancestors.project, beforeProject) ||
              !overridesUnchanged(ancestors.session, beforeSession)
            ) {
              return { write: false, result: { committed: false } };
            }
            const result = patchAndPrune(current, input);
            return {
              write: true,
              overrides: pruneEmptyCapabilityOverrides(result.overrides),
              result: { committed: true, result },
            };
          },
        );
      if (outcome.committed) {
        logPatch(
          "conversation",
          `${projectPath}/${sessionName}/${conversationId}`,
          input.cascadeKind,
          outcome.result.changedItemIds,
        );
        return outcome.result;
      }
    }
    throw new Error(
      `agent-capabilities.patchConversation: exceeded fence-retry limit for "${projectPath}/${sessionName}/${conversationId}"`,
    );
  }

  async function patchProjectConversation(
    projectPath: string,
    conversationId: string,
    input: ScopeCapabilityPatchInput,
  ): Promise<ScopeCapabilityPatchResult> {
    if (!input.precondition) {
      const result =
        await stateManager.mutateProjectConversationAgentCapabilityOverrides<ScopeCapabilityPatchResult>(
          projectPath,
          conversationId,
          "agent-capabilities.patchProjectConversation",
          (current) => {
            const result = patchAndPrune(current, input);
            return {
              write: true,
              overrides: pruneEmptyCapabilityOverrides(result.overrides),
              result,
            };
          },
        );
      logPatch(
        "project-conversation",
        `${projectPath}/${conversationId}`,
        input.cascadeKind,
        result.changedItemIds,
      );
      return result;
    }
    return patchProjectConversationChecked(
      projectPath,
      conversationId,
      input,
      input.precondition,
    );
  }

  /**
   * Conflict-checked project-conversation patch. The project-conversation
   * cascade skips the session layer, so the effective hash depends on the global
   * (file), project, and conversation layers; the commit fences the target
   * (project-conversation) overrides plus the state-backed project ancestor,
   * read atomically inside the queue by
   * `mutateProjectConversationAgentCapabilityOverrides`.
   */
  async function patchProjectConversationChecked(
    projectPath: string,
    conversationId: string,
    input: ScopeCapabilityPatchInput,
    precondition: NonNullable<ScopeCapabilityPatchInput["precondition"]>,
  ): Promise<ScopeCapabilityPatchResult> {
    for (let attempt = 0; attempt <= MAX_FENCE_RETRIES; attempt++) {
      const conversation = await stateManager.getProjectConversation(
        projectPath,
        conversationId,
      );
      if (!conversation) {
        throw new Error(
          `Project conversation "${conversationId}" not found in project "${projectPath}" during agent-capabilities.patchProjectConversation`,
        );
      }
      const beforeTarget = conversation.agentCapabilityOverrides;
      const beforeProject =
        await stateManager.getProjectAgentCapabilityOverrides(projectPath);
      await precondition(beforeTarget);
      const outcome =
        await stateManager.mutateProjectConversationAgentCapabilityOverrides<CheckedPatchOutcome>(
          projectPath,
          conversationId,
          "agent-capabilities.patchProjectConversation",
          (current, ancestors) => {
            if (
              !overridesUnchanged(current, beforeTarget) ||
              !overridesUnchanged(ancestors.project, beforeProject)
            ) {
              return { write: false, result: { committed: false } };
            }
            const result = patchAndPrune(current, input);
            return {
              write: true,
              overrides: pruneEmptyCapabilityOverrides(result.overrides),
              result: { committed: true, result },
            };
          },
        );
      if (outcome.committed) {
        logPatch(
          "project-conversation",
          `${projectPath}/${conversationId}`,
          input.cascadeKind,
          outcome.result.changedItemIds,
        );
        return outcome.result;
      }
    }
    throw new Error(
      `agent-capabilities.patchProjectConversation: exceeded fence-retry limit for "${projectPath}/${conversationId}"`,
    );
  }

  return {
    patchProject,
    patchSession,
    patchConversation,
    patchProjectConversation,
  };
}

/**
 * Result of a conflict-checked commit attempt: either the patch committed (the
 * fenced overrides matched what the precondition validated) or it did not (a
 * concurrent writer changed the overrides in the window, so the caller retries).
 */
type CheckedPatchOutcome =
  | { committed: true; result: ScopeCapabilityPatchResult }
  | { committed: false };

/**
 * Deep-equal fence over the capability overrides the precondition validated. The
 * commit only proceeds when the FRESH persisted overrides still match `before`;
 * a mismatch means a concurrent patch landed between the out-of-queue precondition
 * and this commit, so the caller re-reads and re-validates. Normalizes
 * `undefined`↔`null` so an absent override compares equal to an explicit null.
 */
function overridesUnchanged(
  current: AgentCapabilityOverrides | undefined,
  before: AgentCapabilityOverrides | undefined,
): boolean {
  return deepEqualJson(current ?? null, before ?? null);
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

/**
 * Collapse an empty cascade set to `undefined` so the focused override-column
 * write clears the column (NULL) rather than persisting `{ cascades: {} }`.
 */
function pruneEmptyCapabilityOverrides(
  value: AgentCapabilityOverrides,
): AgentCapabilityOverrides | undefined {
  return Object.keys(value.cascades).length === 0 ? undefined : value;
}

export const defaultScopeCapabilityOverrideStore: ScopeCapabilityOverrideStore =
  createScopeCapabilityOverrideStore({ stateManager: getStateStore() });
