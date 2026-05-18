/**
 * Capability runtime apply service.
 *
 * Orchestrates the three lifecycle events that move a conversation's
 * per-cascade runtime apply state forward:
 *
 *   1. `applyAfterOverrideChange` — Override mutation just persisted. Fan
 *      out to every active conversation affected by the edited scope/cascade,
 *      compute a fresh runtime composition per conversation, and either live-
 *      apply (idle Claude), stage idle-drain (running Claude), stage next-turn
 *      (Codex), defer to next conversation (Claude sub-agents), or record
 *      unsupported (verification-gated cascades). Never mutates Codex live.
 *   2. `applyWhenConversationBecomesIdle` — Claude conversation transitioned
 *      from running to idle. Drain any cascades stored as `staged-idle`
 *      against the freshly-composed runtime payload through the Claude apply
 *      port. Records `applied` on success or `rejected` with sanitized error
 *      on failure; the previously-applied hash is preserved on failure via
 *      `recordApplyOutcome`. A previous `rejected` record with a preserved
 *      `pendingHash` is also retried here — that is the retry surface for
 *      transient Claude apply failures.
 *   3. `applyAtTurnStart` — A new turn is starting. Promote `staged-next-turn`
 *      entries to `applied` because the backend ingests the fresh options at
 *      turn boundary (Codex rebuilds SDK options per turn; Claude seeded
 *      `staged-next-turn` at session creation). A previous `rejected` Codex
 *      record with a preserved `pendingHash` is retried here — that is the
 *      retry surface for transient Codex apply failures. Deferred-next-
 *      conversation entries are left alone — only a fresh conversation
 *      runtime can apply those. Claude `rejected` records are not retried at
 *      turn-start; they wait for the next idle transition because Claude
 *      cannot be mutated at turn boundary.
 *
 * Failure isolation:
 *   - A discovery or composition failure for one cascade does not affect the
 *     other cascades on the same conversation; the outcome record carries a
 *     diagnostic and that cascade is recorded as `rejected`.
 *   - A live-apply failure for one conversation does not affect other
 *     conversations — each conversation gets its own outcome record.
 *   - The cached pending hash + items are preserved on `rejected` so retries
 *     can proceed without losing the operator's intent.
 *
 * Dependency boundaries: the service takes ports for conversation enumeration,
 * conversation runtime state I/O, fresh composition, and the Claude live-apply
 * adapter. Tests provide synchronous fakes; production wiring injects the real
 * state-store, the runtime registry, and the Claude `QuerySession` adapter.
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/errors";
import type {
  AgentBackendId,
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeRuntimeState,
  AgentCapabilityDiagnostic,
  AgentCapabilityRuntimeApplicationState,
} from "@/lib/schemas";

import {
  defaultAgentCapabilityMetadataRegistry,
  type AgentCapabilityMetadataRegistry,
} from "./metadata";
import type { ClaudeRuntimeCapabilityConfig } from "./claude-runtime-translator";
import type { CodexRuntimeCapabilityConfig } from "./codex-runtime-translator";
import {
  computeCascadeRuntimeHash,
  recordApplyOutcome,
  sanitizeApplyError,
} from "./runtime-hashes";
import type { ComposeConversationStartResult } from "./runtime-composer";
import {
  planCascadeFailure,
  planCascadeApply,
  planIdleDrainCascadeApply,
  planMissingTargetCascadeAfterMutation,
  planTurnStartCascadeApply,
  type ApplyTriggerMode,
  type CascadeApplyPlan,
} from "./apply-planner";
import type { MutationScope } from "./mutation-service";

const logger = createLogger("agent-capabilities.apply-service");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AffectedConversation {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
  backend: AgentBackendId;
  /** Snapshot taken when the service enumerated the conversation. Re-checked
   * before live-apply so a turn that started between enumeration and apply
   * does not get interrupted. */
  isTurnActive: boolean;
}

export interface ClaudeApplyPortInput {
  conversationId: string;
  config: ClaudeRuntimeCapabilityConfig;
}

export type ClaudeApplyPortResult =
  | { status: "applied" }
  | { status: "rejected"; error: string }
  | { status: "skipped-turn-active" };

export interface CodexApplyPortInput {
  conversationId: string;
  config: CodexRuntimeCapabilityConfig;
}

export type CodexApplyPortResult =
  | { status: "applied" }
  | { status: "rejected"; error: string };

export interface ApplyServiceDeps {
  metadataRegistry?: AgentCapabilityMetadataRegistry;
  /**
   * Returns active conversations whose effective view depends on the edited
   * scope/cascade. Inactive conversations are excluded — they pick up new
   * config when their runtime is created.
   */
  listAffectedConversations(input: {
    scope: MutationScope;
    cascadeKind: AgentCapabilityCascadeKind;
    changedItemIds: readonly string[];
  }): Promise<readonly AffectedConversation[]>;
  /** Re-check a conversation's runtime turn-active flag immediately before
   * live-apply. */
  isTurnActive(conversation: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): boolean;
  /** Produce a fresh conversation-start runtime composition that reflects the
   * current persisted overrides + discovery. */
  composeForConversation(conversation: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
    backend: AgentBackendId;
  }): Promise<ComposeConversationStartResult>;
  /** Read the conversation's stored runtime apply state. */
  readRuntimeState(conversation: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<AgentCapabilityRuntimeApplicationState | undefined>;
  /** Persist a new runtime apply state for the conversation; the apply service
   * writes the entire state object atomically via this port. */
  writeRuntimeState(conversation: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    state: AgentCapabilityRuntimeApplicationState;
  }): Promise<void>;
  /** Live-apply Claude config for one conversation. Returns the disposition;
   * the apply service is responsible for storing the result via
   * `recordApplyOutcome`. */
  applyClaudeRuntime?(
    input: ClaudeApplyPortInput,
  ): Promise<ClaudeApplyPortResult>;
  /**
   * Push a recomposed Codex capability config into the live Codex runtime so
   * the next turn ingests it. Codex runtimes always rebuild `CodexOptions` per
   * turn, so this only needs to replace the runtime's staged config and never
   * interrupts an in-flight turn. Returns `rejected` when the runtime is
   * closed or missing; the apply service records the failure rather than
   * falsely promoting state to `applied`.
   */
  applyCodexRuntime?(input: CodexApplyPortInput): Promise<CodexApplyPortResult>;
}

export interface CascadeApplyOutcome {
  cascadeKind: AgentCapabilityCascadeKind;
  disposition:
    | "applied"
    | "staged-idle"
    | "staged-next-turn"
    | "deferred-next-conversation"
    | "unsupported"
    | "rejected"
    | "idempotent-no-op";
  attemptedHash?: string;
  error?: string;
}

export interface ConversationApplyOutcome {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  backend: AgentBackendId;
  cascades: readonly CascadeApplyOutcome[];
  diagnostics: readonly AgentCapabilityDiagnostic[];
}

export interface ApplyAfterMutationInput {
  scope: MutationScope;
  cascadeKind: AgentCapabilityCascadeKind;
  changedItemIds: readonly string[];
  operationId?: string;
}

export interface ApplyAfterMutationResult {
  conversations: readonly ConversationApplyOutcome[];
}

export interface ApplyAtConversationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
  backend: AgentBackendId;
}

export interface CapabilityRuntimeApplyService {
  applyAfterOverrideChange(
    input: ApplyAfterMutationInput,
  ): Promise<ApplyAfterMutationResult>;
  applyWhenConversationBecomesIdle(
    input: ApplyAtConversationInput,
  ): Promise<ConversationApplyOutcome>;
  applyAtTurnStart(
    input: ApplyAtConversationInput,
  ): Promise<ConversationApplyOutcome>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createCapabilityRuntimeApplyService(
  deps: ApplyServiceDeps,
): CapabilityRuntimeApplyService {
  const metadataRegistry =
    deps.metadataRegistry ?? defaultAgentCapabilityMetadataRegistry;

  async function applyAfterOverrideChange(
    input: ApplyAfterMutationInput,
  ): Promise<ApplyAfterMutationResult> {
    const affected = await deps.listAffectedConversations({
      scope: input.scope,
      cascadeKind: input.cascadeKind,
      changedItemIds: input.changedItemIds,
    });
    logger.info("apply.planned", {
      cascadeKind: input.cascadeKind,
      operationId: input.operationId,
      affectedCount: affected.length,
      changedCount: input.changedItemIds.length,
    });

    const outcomes: ConversationApplyOutcome[] = [];
    for (const conversation of affected) {
      const outcome = await applyToConversation({
        conversation,
        targetCascade: input.cascadeKind,
        trigger: "after-mutation",
        operationId: input.operationId,
      });
      outcomes.push(outcome);
    }
    return { conversations: outcomes };
  }

  async function applyWhenConversationBecomesIdle(
    input: ApplyAtConversationInput,
  ): Promise<ConversationApplyOutcome> {
    return applyToConversation({
      conversation: {
        ...input,
        isTurnActive: false,
      },
      targetCascade: undefined,
      trigger: "idle-drain",
    });
  }

  async function applyAtTurnStart(
    input: ApplyAtConversationInput,
  ): Promise<ConversationApplyOutcome> {
    return applyToConversation({
      conversation: {
        ...input,
        isTurnActive: false,
      },
      targetCascade: undefined,
      trigger: "turn-start",
    });
  }

  interface ApplyToConversationInput {
    conversation: AffectedConversation;
    targetCascade: AgentCapabilityCascadeKind | undefined;
    trigger: "after-mutation" | "idle-drain" | "turn-start";
    operationId?: string;
  }

  async function applyToConversation(
    input: ApplyToConversationInput,
  ): Promise<ConversationApplyOutcome> {
    const { conversation, targetCascade, trigger, operationId } = input;
    const diagnostics: AgentCapabilityDiagnostic[] = [];
    let composition: ComposeConversationStartResult;
    try {
      composition = await deps.composeForConversation({
        projectPath: conversation.projectPath,
        projectName: conversation.projectName,
        sessionName: conversation.sessionName,
        conversationId: conversation.conversationId,
        worktreePath: conversation.worktreePath,
        backend: conversation.backend,
      });
    } catch (err) {
      return handleComposeThrow({
        conversation,
        targetCascade,
        trigger,
        operationId,
        error: err,
      });
    }

    diagnostics.push(...composition.diagnostics);

    const existingState = (await deps.readRuntimeState({
      projectPath: conversation.projectPath,
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
    })) ?? { cascades: {} };

    const nextState: AgentCapabilityRuntimeApplicationState = {
      cascades: { ...existingState.cascades },
    };
    const outcomes: CascadeApplyOutcome[] = [];

    const composedCascades = collectComposedCascades(composition);
    const failedCascadeKinds = new Set<AgentCapabilityCascadeKind>(
      composition.failedCascadeKinds,
    );
    const cascadeKindsToProcess = determineCascadesToProcess({
      trigger,
      targetCascade,
      composedCascades,
      existingState,
      failedCascadeKinds,
    });
    logger.info("apply.conversation_planned", {
      trigger,
      projectPath: conversation.projectPath,
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
      backend: conversation.backend,
      targetCascade,
      cascadeCount: cascadeKindsToProcess.length,
      cascadeKinds: cascadeKindsToProcess,
      operationId,
    });

    for (const cascadeKind of cascadeKindsToProcess) {
      const previous = nextState.cascades[cascadeKind];
      const result = await applyOneCascade({
        cascadeKind,
        conversation,
        composedCascades,
        failedCascadeKinds,
        claudeRuntimeConfig: composition.claudeRuntime,
        codexRuntimeConfig: composition.codexRuntime
          ? { config: composition.codexRuntime.config }
          : undefined,
        previous,
        trigger,
        operationId,
      });
      if (result.nextState !== undefined) {
        nextState.cascades[cascadeKind] = result.nextState;
      } else if (nextState.cascades[cascadeKind] !== undefined) {
        delete nextState.cascades[cascadeKind];
      }
      outcomes.push(result.outcome);
      if (result.diagnostic) {
        diagnostics.push(result.diagnostic);
      }
      logCascadeOutcome({
        trigger,
        conversation,
        previous,
        outcome: result.outcome,
        operationId,
      });
    }

    if (mutated(existingState, nextState)) {
      await deps.writeRuntimeState({
        projectPath: conversation.projectPath,
        sessionName: conversation.sessionName,
        conversationId: conversation.conversationId,
        state: nextState,
      });
    }

    return {
      projectPath: conversation.projectPath,
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
      backend: conversation.backend,
      cascades: outcomes,
      diagnostics,
    };
  }

  interface ComposedCascadeInfo {
    cascadeKind: AgentCapabilityCascadeKind;
    attemptedHash: string;
    attemptedItemIds: readonly string[];
  }

  function collectComposedCascades(
    composition: ComposeConversationStartResult,
  ): Map<AgentCapabilityCascadeKind, ComposedCascadeInfo> {
    const out = new Map<AgentCapabilityCascadeKind, ComposedCascadeInfo>();
    // composeConversationStartRuntime already seeded runtimeState for non-
    // verification-gated cascades. Reuse those entries directly so the apply
    // service shares one canonical hash with conversation-start seeding.
    for (const [rawCascadeKind, state] of Object.entries(
      composition.runtimeState.cascades,
    )) {
      const cascadeKind = rawCascadeKind as AgentCapabilityCascadeKind;
      if (!state) continue;
      const attemptedHash =
        state.pendingHash ??
        state.appliedHash ??
        computeCascadeRuntimeHash({ cascadeKind, rows: [] });
      out.set(cascadeKind, {
        cascadeKind,
        attemptedHash,
        attemptedItemIds: state.pendingItemIds ?? [],
      });
    }
    return out;
  }

  function determineCascadesToProcess(input: {
    trigger: "after-mutation" | "idle-drain" | "turn-start";
    targetCascade: AgentCapabilityCascadeKind | undefined;
    composedCascades: Map<AgentCapabilityCascadeKind, ComposedCascadeInfo>;
    existingState: AgentCapabilityRuntimeApplicationState;
    failedCascadeKinds: ReadonlySet<AgentCapabilityCascadeKind>;
  }): readonly AgentCapabilityCascadeKind[] {
    if (input.trigger === "after-mutation" && input.targetCascade) {
      return [input.targetCascade];
    }
    const kinds = new Set<AgentCapabilityCascadeKind>();
    for (const kind of input.composedCascades.keys()) kinds.add(kind);
    for (const kind of input.failedCascadeKinds) kinds.add(kind);
    for (const rawKind of Object.keys(input.existingState.cascades)) {
      kinds.add(rawKind as AgentCapabilityCascadeKind);
    }
    return [...kinds];
  }

  interface ApplyOneCascadeInput {
    cascadeKind: AgentCapabilityCascadeKind;
    conversation: AffectedConversation;
    composedCascades: Map<AgentCapabilityCascadeKind, ComposedCascadeInfo>;
    failedCascadeKinds: ReadonlySet<AgentCapabilityCascadeKind>;
    claudeRuntimeConfig: ClaudeRuntimeCapabilityConfig | undefined;
    codexRuntimeConfig: CodexRuntimeCapabilityConfig | undefined;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
    trigger: "after-mutation" | "idle-drain" | "turn-start";
    operationId?: string;
  }

  interface ApplyOneCascadeResult {
    outcome: CascadeApplyOutcome;
    nextState: AgentCapabilityCascadeRuntimeState | undefined;
    diagnostic?: AgentCapabilityDiagnostic;
  }

  async function applyOneCascade(
    input: ApplyOneCascadeInput,
  ): Promise<ApplyOneCascadeResult> {
    const {
      cascadeKind,
      conversation,
      composedCascades,
      failedCascadeKinds,
      claudeRuntimeConfig,
      codexRuntimeConfig,
      previous,
      trigger,
      operationId,
    } = input;
    const metadata = metadataRegistry.get(cascadeKind);

    if (metadata.backend !== conversation.backend) {
      logCascadePlan({
        trigger,
        conversation,
        cascadeKind,
        previous,
        plannedDisposition: "unsupported",
        operationId,
      });
      return {
        outcome: {
          cascadeKind,
          disposition: "unsupported",
        },
        nextState: previous,
      };
    }

    if (failedCascadeKinds.has(cascadeKind)) {
      logCascadePlan({
        trigger,
        conversation,
        cascadeKind,
        previous,
        plannedDisposition: "rejected",
        operationId,
      });
      return rejectForDiscoveryFailure({
        cascadeKind,
        conversation,
        previous,
        metadata,
      });
    }

    if (metadata.compositionSupport === "verification-gated") {
      logCascadePlan({
        trigger,
        conversation,
        cascadeKind,
        previous,
        plannedDisposition: "unsupported",
        operationId,
      });
      return unsupportedVerificationGatedResult({
        cascadeKind,
        conversation,
        previous,
      });
    }

    const composed = composedCascades.get(cascadeKind);

    if (trigger === "idle-drain") {
      return handleIdleDrain({
        cascadeKind,
        conversation,
        composed,
        claudeRuntimeConfig,
        previous,
        operationId,
      });
    }

    if (trigger === "turn-start") {
      return handleTurnStart({
        cascadeKind,
        conversation,
        composed,
        codexRuntimeConfig,
        previous,
      });
    }

    if (!composed) {
      return handleMissingTargetCascadeAfterMutation({
        cascadeKind,
        conversation,
        previous,
        metadata,
        operationId,
      });
    }

    const liveTurnActive = deps.isTurnActive({
      projectPath: conversation.projectPath,
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
    });
    const triggerMode: ApplyTriggerMode = liveTurnActive
      ? "turn-active"
      : "idle";

    const plan = planCascadeApply({
      metadata,
      previous,
      attemptedHash: composed.attemptedHash,
      attemptedItemIds: composed.attemptedItemIds,
      triggerMode,
    });
    logCascadePlan({
      trigger,
      conversation,
      cascadeKind,
      previous,
      plannedDisposition: plan.disposition,
      attemptedHash: composed.attemptedHash,
      pendingItemCount: composed.attemptedItemIds.length,
      operationId,
    });

    return executePlan({
      plan,
      cascadeKind,
      conversation,
      composed,
      claudeRuntimeConfig,
      previous,
      operationId,
    });
  }

  interface ExecutePlanInput {
    plan: CascadeApplyPlan;
    cascadeKind: AgentCapabilityCascadeKind;
    conversation: AffectedConversation;
    composed: ComposedCascadeInfo;
    claudeRuntimeConfig: ClaudeRuntimeCapabilityConfig | undefined;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
    operationId?: string;
  }

  async function executePlan(
    input: ExecutePlanInput,
  ): Promise<ApplyOneCascadeResult> {
    const {
      plan,
      cascadeKind,
      conversation,
      composed,
      claudeRuntimeConfig,
      previous,
      operationId,
    } = input;
    switch (plan.disposition) {
      case "idempotent-no-op":
        return {
          outcome: { cascadeKind, disposition: "idempotent-no-op" },
          nextState: previous,
        };
      case "unsupported":
        return {
          outcome: { cascadeKind, disposition: "unsupported" },
          nextState: previous,
        };
      case "staged-idle":
        return {
          outcome: {
            cascadeKind,
            disposition: "staged-idle",
            attemptedHash: composed.attemptedHash,
          },
          nextState: recordApplyOutcome({
            previous,
            attemptedHash: composed.attemptedHash,
            attemptedItemIds: composed.attemptedItemIds,
            outcome: { status: "staged-idle" },
          }),
        };
      case "staged-next-turn":
        return {
          outcome: {
            cascadeKind,
            disposition: "staged-next-turn",
            attemptedHash: composed.attemptedHash,
          },
          nextState: recordApplyOutcome({
            previous,
            attemptedHash: composed.attemptedHash,
            attemptedItemIds: composed.attemptedItemIds,
            outcome: { status: "staged-next-turn" },
          }),
        };
      case "deferred-next-conversation":
        return {
          outcome: {
            cascadeKind,
            disposition: "deferred-next-conversation",
            attemptedHash: composed.attemptedHash,
          },
          nextState: recordApplyOutcome({
            previous,
            attemptedHash: composed.attemptedHash,
            attemptedItemIds: composed.attemptedItemIds,
            outcome: { status: "deferred-next-conversation" },
          }),
        };
      case "try-live-apply":
        return executeClaudeLiveApply({
          cascadeKind,
          conversation,
          composed,
          claudeRuntimeConfig,
          previous,
          operationId,
        });
    }
  }

  interface ExecuteClaudeLiveApplyInput {
    cascadeKind: AgentCapabilityCascadeKind;
    conversation: AffectedConversation;
    composed: ComposedCascadeInfo;
    claudeRuntimeConfig: ClaudeRuntimeCapabilityConfig | undefined;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
    operationId?: string;
  }

  async function executeClaudeLiveApply(
    input: ExecuteClaudeLiveApplyInput,
  ): Promise<ApplyOneCascadeResult> {
    const {
      cascadeKind,
      conversation,
      composed,
      claudeRuntimeConfig,
      previous,
      operationId,
    } = input;
    const port = deps.applyClaudeRuntime;
    if (!port || !claudeRuntimeConfig) {
      return {
        outcome: {
          cascadeKind,
          disposition: "staged-idle",
          attemptedHash: composed.attemptedHash,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash: composed.attemptedHash,
          attemptedItemIds: composed.attemptedItemIds,
          outcome: { status: "staged-idle" },
        }),
        diagnostic: {
          severity: "info",
          code: "agent-capability-apply-failed",
          message:
            "Claude live-apply port unavailable; change staged for idle drain",
          backend: "claude",
          cascadeKind,
        },
      };
    }

    let result: ClaudeApplyPortResult;
    try {
      result = await port({
        conversationId: conversation.conversationId,
        config: claudeRuntimeConfig,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      const sanitized = sanitizeApplyError(message);
      logger.error("apply.failed", {
        cascadeKind,
        conversationId: conversation.conversationId,
        operationId,
        error: sanitized,
      });
      return {
        outcome: {
          cascadeKind,
          disposition: "rejected",
          attemptedHash: composed.attemptedHash,
          error: sanitized,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash: composed.attemptedHash,
          attemptedItemIds: composed.attemptedItemIds,
          outcome: { status: "rejected", error: message },
        }),
        diagnostic: {
          severity: "error",
          code: "agent-capability-apply-failed",
          message: `Claude apply failed: ${sanitizeApplyError(message)}`,
          backend: "claude",
          cascadeKind,
        },
      };
    }

    if (result.status === "skipped-turn-active") {
      return {
        outcome: {
          cascadeKind,
          disposition: "staged-idle",
          attemptedHash: composed.attemptedHash,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash: composed.attemptedHash,
          attemptedItemIds: composed.attemptedItemIds,
          outcome: { status: "staged-idle" },
        }),
      };
    }

    if (result.status === "rejected") {
      const sanitized = sanitizeApplyError(result.error);
      logger.error("apply.failed", {
        cascadeKind,
        conversationId: conversation.conversationId,
        operationId,
        error: sanitized,
      });
      return {
        outcome: {
          cascadeKind,
          disposition: "rejected",
          attemptedHash: composed.attemptedHash,
          error: sanitized,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash: composed.attemptedHash,
          attemptedItemIds: composed.attemptedItemIds,
          outcome: { status: "rejected", error: result.error },
        }),
        diagnostic: {
          severity: "error",
          code: "agent-capability-apply-failed",
          message: `Claude apply rejected: ${sanitizeApplyError(result.error)}`,
          backend: "claude",
          cascadeKind,
        },
      };
    }

    logger.info("apply.succeeded", {
      cascadeKind,
      conversationId: conversation.conversationId,
      operationId,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "applied",
        attemptedHash: composed.attemptedHash,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash: composed.attemptedHash,
        attemptedItemIds: composed.attemptedItemIds,
        outcome: { status: "applied" },
      }),
    };
  }

  interface IdleDrainInput {
    cascadeKind: AgentCapabilityCascadeKind;
    conversation: AffectedConversation;
    composed: ComposedCascadeInfo | undefined;
    claudeRuntimeConfig: ClaudeRuntimeCapabilityConfig | undefined;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
    operationId?: string;
  }

  async function handleIdleDrain(
    input: IdleDrainInput,
  ): Promise<ApplyOneCascadeResult> {
    const {
      cascadeKind,
      conversation,
      composed,
      claudeRuntimeConfig,
      previous,
      operationId,
    } = input;
    const plan = planIdleDrainCascadeApply({ previous, composed });
    logCascadePlan({
      trigger: "idle-drain",
      conversation,
      cascadeKind,
      previous,
      plannedDisposition: plan.disposition,
      attemptedHash:
        plan.disposition === "try-live-apply" ? plan.attemptedHash : undefined,
      pendingItemCount:
        plan.disposition === "try-live-apply"
          ? plan.attemptedItemIds.length
          : undefined,
      reason: plan.disposition === "idempotent-no-op" ? plan.reason : undefined,
      operationId,
    });

    if (plan.disposition === "idempotent-no-op") {
      if (plan.reason === "hash-drift" && composed && previous?.pendingHash) {
        // Drift between the hash recorded at staging time and what the composer
        // now emits (e.g., overrides changed again before the drain ran). The
        // staged record was for a different effective payload, so leave it in
        // place rather than overwriting `lastApplyError` / pending state for a
        // hash the operator never intended to drain. A subsequent
        // `applyAfterOverrideChange` will re-stage with the new hash.
        logger.info("apply.idle_drain_skipped_hash_drift", {
          cascadeKind,
          conversationId: conversation.conversationId,
          stagedHash: previous.pendingHash,
          composedHash: composed.attemptedHash,
        });
      }
      if (plan.stateAction === "clear-obsolete") {
        return {
          outcome: { cascadeKind, disposition: "idempotent-no-op" },
          nextState: undefined,
        };
      }
      return {
        outcome: { cascadeKind, disposition: "idempotent-no-op" },
        nextState: previous,
      };
    }

    return executeClaudeLiveApply({
      cascadeKind,
      conversation,
      composed: {
        cascadeKind,
        attemptedHash: plan.attemptedHash,
        attemptedItemIds: plan.attemptedItemIds,
      },
      claudeRuntimeConfig,
      previous,
      operationId,
    });
  }

  interface MissingTargetCascadeAfterMutationInput {
    cascadeKind: AgentCapabilityCascadeKind;
    conversation: AffectedConversation;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
    metadata: ReturnType<AgentCapabilityMetadataRegistry["get"]>;
    operationId?: string;
  }

  function handleMissingTargetCascadeAfterMutation(
    input: MissingTargetCascadeAfterMutationInput,
  ): ApplyOneCascadeResult {
    const { cascadeKind, conversation, previous, metadata, operationId } =
      input;
    const plan = planMissingTargetCascadeAfterMutation({
      metadata,
      previous,
    });
    logCascadePlan({
      trigger: "after-mutation",
      conversation,
      cascadeKind,
      previous,
      plannedDisposition: plan.disposition,
      attemptedHash:
        plan.disposition === "rejected" ? plan.attemptedHash : undefined,
      pendingItemCount:
        plan.disposition === "rejected"
          ? plan.attemptedItemIds.length
          : undefined,
      reason: plan.disposition === "rejected" ? plan.reason : undefined,
      operationId,
    });

    if (plan.disposition === "unsupported") {
      return {
        outcome: { cascadeKind, disposition: "unsupported" },
        nextState: previous,
      };
    }

    const reason =
      "Runtime composition did not emit the mutated target cascade";
    const sanitized = sanitizeApplyError(reason);
    logger.error("apply.missing_target_cascade", {
      cascadeKind,
      conversationId: conversation.conversationId,
      backend: conversation.backend,
      operationId,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "rejected",
        attemptedHash: plan.attemptedHash,
        error: sanitized,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash: plan.attemptedHash,
        attemptedItemIds: plan.attemptedItemIds,
        outcome: { status: "rejected", error: reason },
      }),
      diagnostic: {
        severity: "error",
        code: "agent-capability-apply-failed",
        message: `Capability recomposition failed: ${sanitized}`,
        backend: conversation.backend,
        cascadeKind,
      },
    };
  }

  interface TurnStartInput {
    cascadeKind: AgentCapabilityCascadeKind;
    conversation: AffectedConversation;
    composed: ComposedCascadeInfo | undefined;
    codexRuntimeConfig: CodexRuntimeCapabilityConfig | undefined;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
  }

  async function handleTurnStart(
    input: TurnStartInput,
  ): Promise<ApplyOneCascadeResult> {
    const {
      cascadeKind,
      conversation,
      composed,
      codexRuntimeConfig,
      previous,
    } = input;
    const plan = planTurnStartCascadeApply({
      backend: conversation.backend,
      previous,
      composed,
    });
    logCascadePlan({
      trigger: "turn-start",
      conversation,
      cascadeKind,
      previous,
      plannedDisposition: plan.disposition,
      attemptedHash:
        plan.disposition === "try-turn-start-apply" ||
        plan.disposition === "applied"
          ? plan.attemptedHash
          : undefined,
      pendingItemCount:
        plan.disposition === "try-turn-start-apply" ||
        plan.disposition === "applied"
          ? plan.attemptedItemIds.length
          : undefined,
      reason: plan.disposition === "idempotent-no-op" ? plan.reason : undefined,
    });

    switch (plan.disposition) {
      case "idempotent-no-op":
        if (plan.reason === "hash-drift" && composed && previous?.pendingHash) {
          logger.info("apply.turn_start_skipped_hash_drift", {
            cascadeKind,
            conversationId: conversation.conversationId,
            stagedHash: previous.pendingHash,
            composedHash: composed.attemptedHash,
          });
        }
        return {
          outcome: { cascadeKind, disposition: "idempotent-no-op" },
          nextState:
            plan.stateAction === "clear-obsolete" ? undefined : previous,
        };
      case "deferred-next-conversation":
        return {
          outcome: { cascadeKind, disposition: "deferred-next-conversation" },
          nextState: previous,
        };
      case "try-turn-start-apply":
        if (!previous) {
          return {
            outcome: { cascadeKind, disposition: "idempotent-no-op" },
            nextState: undefined,
          };
        }
        return executeCodexTurnStartApply({
          cascadeKind,
          conversation,
          codexRuntimeConfig,
          attemptedHash: plan.attemptedHash,
          attemptedItemIds: plan.attemptedItemIds,
          previous,
        });
      case "applied":
        return {
          outcome: {
            cascadeKind,
            disposition: "applied",
            attemptedHash: plan.attemptedHash,
          },
          nextState: recordApplyOutcome({
            previous,
            attemptedHash: plan.attemptedHash,
            attemptedItemIds: plan.attemptedItemIds,
            outcome: { status: "applied" },
          }),
        };
    }
  }

  interface ExecuteCodexTurnStartApplyInput {
    cascadeKind: AgentCapabilityCascadeKind;
    conversation: AffectedConversation;
    codexRuntimeConfig: CodexRuntimeCapabilityConfig | undefined;
    attemptedHash: string;
    attemptedItemIds: readonly string[];
    previous: AgentCapabilityCascadeRuntimeState;
  }

  async function executeCodexTurnStartApply(
    input: ExecuteCodexTurnStartApplyInput,
  ): Promise<ApplyOneCascadeResult> {
    const {
      cascadeKind,
      conversation,
      codexRuntimeConfig,
      attemptedHash,
      attemptedItemIds,
      previous,
    } = input;
    const port = deps.applyCodexRuntime;
    if (!port || !codexRuntimeConfig) {
      const reason = !port
        ? "codex runtime apply port unavailable"
        : "codex runtime composition missing";
      logger.error("apply.codex_turn_start_unavailable", {
        cascadeKind,
        conversationId: conversation.conversationId,
        reason,
      });
      return {
        outcome: {
          cascadeKind,
          disposition: "rejected",
          attemptedHash,
          error: sanitizeApplyError(reason),
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash,
          attemptedItemIds,
          outcome: { status: "rejected", error: reason },
        }),
        diagnostic: {
          severity: "error",
          code: "agent-capability-apply-failed",
          message: `Codex turn-start apply failed: ${sanitizeApplyError(reason)}`,
          backend: "codex",
          cascadeKind,
        },
      };
    }

    let result: CodexApplyPortResult;
    try {
      result = await port({
        conversationId: conversation.conversationId,
        config: codexRuntimeConfig,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      const sanitized = sanitizeApplyError(message);
      logger.error("apply.codex_turn_start_failed", {
        cascadeKind,
        conversationId: conversation.conversationId,
        error: sanitized,
      });
      return {
        outcome: {
          cascadeKind,
          disposition: "rejected",
          attemptedHash,
          error: sanitized,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash,
          attemptedItemIds,
          outcome: { status: "rejected", error: message },
        }),
        diagnostic: {
          severity: "error",
          code: "agent-capability-apply-failed",
          message: `Codex apply failed: ${sanitizeApplyError(message)}`,
          backend: "codex",
          cascadeKind,
        },
      };
    }

    if (result.status === "rejected") {
      const sanitized = sanitizeApplyError(result.error);
      logger.error("apply.codex_turn_start_rejected", {
        cascadeKind,
        conversationId: conversation.conversationId,
        error: sanitized,
      });
      return {
        outcome: {
          cascadeKind,
          disposition: "rejected",
          attemptedHash,
          error: sanitized,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash,
          attemptedItemIds,
          outcome: { status: "rejected", error: result.error },
        }),
        diagnostic: {
          severity: "error",
          code: "agent-capability-apply-failed",
          message: `Codex apply rejected: ${sanitizeApplyError(result.error)}`,
          backend: "codex",
          cascadeKind,
        },
      };
    }

    logger.info("apply.codex_turn_start_succeeded", {
      cascadeKind,
      conversationId: conversation.conversationId,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "applied",
        attemptedHash,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash,
        attemptedItemIds,
        outcome: { status: "applied" },
      }),
    };
  }

  function logCascadePlan(input: {
    trigger: "after-mutation" | "idle-drain" | "turn-start";
    conversation: AffectedConversation;
    cascadeKind: AgentCapabilityCascadeKind;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
    plannedDisposition: string;
    attemptedHash?: string;
    pendingItemCount?: number;
    reason?: string;
    operationId?: string;
  }): void {
    logger.info("apply.cascade_planned", {
      trigger: input.trigger,
      cascadeKind: input.cascadeKind,
      conversationId: input.conversation.conversationId,
      backend: input.conversation.backend,
      operationId: input.operationId,
      previousStatus: input.previous?.lastApplyStatus,
      plannedDisposition: input.plannedDisposition,
      attemptedHash: input.attemptedHash,
      pendingItemCount: input.pendingItemCount,
      reason: input.reason,
    });
  }

  function logCascadeOutcome(input: {
    trigger: "after-mutation" | "idle-drain" | "turn-start";
    conversation: AffectedConversation;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
    outcome: CascadeApplyOutcome;
    operationId?: string;
  }): void {
    const fields = {
      trigger: input.trigger,
      cascadeKind: input.outcome.cascadeKind,
      conversationId: input.conversation.conversationId,
      backend: input.conversation.backend,
      operationId: input.operationId,
      previousStatus: input.previous?.lastApplyStatus,
      disposition: input.outcome.disposition,
      attemptedHash: input.outcome.attemptedHash,
      error: input.outcome.error,
    };

    if (
      input.previous?.lastApplyStatus === "rejected" &&
      input.outcome.disposition === "applied"
    ) {
      logger.info("apply.retry_recovered", fields);
    }
    if (
      input.previous?.lastApplyStatus === "rejected" &&
      input.outcome.disposition === "rejected"
    ) {
      logger.error("apply.retry_failed", fields);
    }

    if (input.outcome.disposition === "rejected") {
      logger.error("apply.cascade_outcome", fields);
      return;
    }
    if (input.outcome.disposition === "unsupported") {
      logger.warn("apply.cascade_outcome", fields);
      return;
    }
    logger.info("apply.cascade_outcome", fields);
  }

  interface RejectForDiscoveryFailureInput {
    cascadeKind: AgentCapabilityCascadeKind;
    conversation: AffectedConversation;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
    metadata: ReturnType<AgentCapabilityMetadataRegistry["get"]>;
  }

  function rejectForDiscoveryFailure(
    input: RejectForDiscoveryFailureInput,
  ): ApplyOneCascadeResult {
    const { cascadeKind, conversation, previous, metadata } = input;
    const plan = planCascadeFailure({
      metadata,
      previous,
      failureKind: "failed-discovery",
    });

    if (plan.disposition === "unsupported") {
      return unsupportedVerificationGatedResult({
        cascadeKind,
        conversation,
        previous,
      });
    }

    const reason =
      "Upstream capability discovery failed for this cascade; recomposition was skipped";
    const sanitized = sanitizeApplyError(reason);
    logger.error("apply.discovery_failed", {
      cascadeKind,
      conversationId: conversation.conversationId,
      backend: conversation.backend,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "rejected",
        attemptedHash: plan.attemptedHash,
        error: sanitized,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash: plan.attemptedHash,
        attemptedItemIds: plan.attemptedItemIds,
        outcome: { status: "rejected", error: reason },
      }),
      diagnostic: {
        severity: "error",
        code: "agent-capability-apply-failed",
        message: `Capability recomposition failed: ${sanitized}`,
        backend: conversation.backend,
        cascadeKind,
      },
    };
  }

  function unsupportedVerificationGatedResult(input: {
    cascadeKind: AgentCapabilityCascadeKind;
    conversation: AffectedConversation;
    previous: AgentCapabilityCascadeRuntimeState | undefined;
  }): ApplyOneCascadeResult {
    return {
      outcome: {
        cascadeKind: input.cascadeKind,
        disposition: "unsupported",
      },
      nextState: input.previous,
      diagnostic: verificationGatedDiagnostic({
        conversation: input.conversation,
        cascadeKind: input.cascadeKind,
      }),
    };
  }

  function verificationGatedDiagnostic(input: {
    conversation: AffectedConversation;
    cascadeKind: AgentCapabilityCascadeKind;
  }): AgentCapabilityDiagnostic {
    return {
      severity: "warning",
      code: "agent-capability-runtime-verification-gated",
      message:
        "Capability runtime application is verification-gated for this cascade; no runtime configuration was emitted.",
      backend: input.conversation.backend,
      cascadeKind: input.cascadeKind,
    };
  }

  interface HandleComposeThrowInput {
    conversation: AffectedConversation;
    targetCascade: AgentCapabilityCascadeKind | undefined;
    trigger: "after-mutation" | "idle-drain" | "turn-start";
    operationId?: string;
    error: unknown;
  }

  async function handleComposeThrow(
    input: HandleComposeThrowInput,
  ): Promise<ConversationApplyOutcome> {
    const { conversation, targetCascade, trigger, operationId, error } = input;
    const rawMessage = getErrorMessage(error);
    const sanitized = sanitizeApplyError(rawMessage);
    logger.error("apply.compose_failed", {
      projectPath: conversation.projectPath,
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
      backend: conversation.backend,
      trigger,
      operationId,
      error: sanitized,
    });

    if (trigger === "after-mutation") {
      if (targetCascade === undefined) {
        return {
          projectPath: conversation.projectPath,
          sessionName: conversation.sessionName,
          conversationId: conversation.conversationId,
          backend: conversation.backend,
          cascades: [],
          diagnostics: [composeFailureDiagnostic({ conversation, sanitized })],
        };
      }
      return persistTargetComposeFailure({
        conversation,
        targetCascade,
        rawMessage,
        sanitized,
      });
    }

    return persistLifecycleComposeFailure({
      conversation,
      trigger,
      rawMessage,
      sanitized,
    });
  }

  function composeFailureDiagnostic(input: {
    conversation: AffectedConversation;
    sanitized: string;
    cascadeKind?: AgentCapabilityCascadeKind;
  }): AgentCapabilityDiagnostic {
    return {
      severity: "error",
      code: "agent-capability-apply-failed",
      message: `Failed to compose runtime capabilities: ${input.sanitized}`,
      backend: input.conversation.backend,
      ...(input.cascadeKind !== undefined
        ? { cascadeKind: input.cascadeKind }
        : {}),
    };
  }

  async function persistLifecycleComposeFailure(input: {
    conversation: AffectedConversation;
    trigger: "idle-drain" | "turn-start";
    rawMessage: string;
    sanitized: string;
  }): Promise<ConversationApplyOutcome> {
    const { conversation, trigger, rawMessage, sanitized } = input;
    const existingState = (await deps.readRuntimeState({
      projectPath: conversation.projectPath,
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
    })) ?? { cascades: {} };

    const nextState: AgentCapabilityRuntimeApplicationState = {
      cascades: { ...existingState.cascades },
    };
    const cascades: CascadeApplyOutcome[] = [];
    const diagnostics: AgentCapabilityDiagnostic[] = [];

    for (const [rawKind, previous] of Object.entries(existingState.cascades)) {
      if (!previous) continue;
      const cascadeKind = rawKind as AgentCapabilityCascadeKind;
      const metadata = metadataRegistry.get(cascadeKind);
      if (metadata.backend !== conversation.backend) continue;
      if (
        !isPendingForLifecycleComposeFailure({
          trigger,
          conversation,
          previous,
        })
      ) {
        continue;
      }

      if (metadata.compositionSupport === "verification-gated") {
        const outcome: CascadeApplyOutcome = {
          cascadeKind,
          disposition: "unsupported",
        };
        logCascadePlan({
          trigger,
          conversation,
          cascadeKind,
          previous,
          plannedDisposition: "unsupported",
        });
        cascades.push(outcome);
        diagnostics.push(
          verificationGatedDiagnostic({ conversation, cascadeKind }),
        );
        logCascadeOutcome({ trigger, conversation, previous, outcome });
        continue;
      }

      const plan = planCascadeFailure({
        metadata,
        previous,
        failureKind: "compose-throw",
      });
      if (plan.disposition === "unsupported") {
        const outcome: CascadeApplyOutcome = {
          cascadeKind,
          disposition: "unsupported",
        };
        logCascadePlan({
          trigger,
          conversation,
          cascadeKind,
          previous,
          plannedDisposition: "unsupported",
        });
        cascades.push(outcome);
        diagnostics.push(
          verificationGatedDiagnostic({ conversation, cascadeKind }),
        );
        logCascadeOutcome({ trigger, conversation, previous, outcome });
        continue;
      }

      nextState.cascades[cascadeKind] = recordApplyOutcome({
        previous,
        attemptedHash: plan.attemptedHash,
        attemptedItemIds: plan.attemptedItemIds,
        outcome: { status: "rejected", error: rawMessage },
      });
      const outcome: CascadeApplyOutcome = {
        cascadeKind,
        disposition: "rejected",
        attemptedHash: plan.attemptedHash,
        error: sanitized,
      };
      logCascadePlan({
        trigger,
        conversation,
        cascadeKind,
        previous,
        plannedDisposition: "rejected",
        attemptedHash: plan.attemptedHash,
        pendingItemCount: plan.attemptedItemIds.length,
        reason: plan.reason,
      });
      cascades.push(outcome);
      diagnostics.push(
        composeFailureDiagnostic({ conversation, sanitized, cascadeKind }),
      );
      logCascadeOutcome({ trigger, conversation, previous, outcome });
      logger.error("apply.lifecycle_compose_failure_persisted", {
        trigger,
        cascadeKind,
        conversationId: conversation.conversationId,
        backend: conversation.backend,
        attemptedHash: plan.attemptedHash,
        pendingItemCount: plan.attemptedItemIds.length,
        error: sanitized,
      });
    }

    if (cascades.length === 0) {
      return {
        projectPath: conversation.projectPath,
        sessionName: conversation.sessionName,
        conversationId: conversation.conversationId,
        backend: conversation.backend,
        cascades: [],
        diagnostics: [composeFailureDiagnostic({ conversation, sanitized })],
      };
    }

    if (mutated(existingState, nextState)) {
      await deps.writeRuntimeState({
        projectPath: conversation.projectPath,
        sessionName: conversation.sessionName,
        conversationId: conversation.conversationId,
        state: nextState,
      });
    }

    return {
      projectPath: conversation.projectPath,
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
      backend: conversation.backend,
      cascades,
      diagnostics,
    };
  }

  function isPendingForLifecycleComposeFailure(input: {
    trigger: "idle-drain" | "turn-start";
    conversation: AffectedConversation;
    previous: AgentCapabilityCascadeRuntimeState;
  }): boolean {
    const { trigger, conversation, previous } = input;
    if (previous.pendingHash === undefined) return false;
    if (trigger === "idle-drain") {
      return (
        previous.lastApplyStatus === "staged-idle" ||
        previous.lastApplyStatus === "rejected"
      );
    }
    if (previous.lastApplyStatus === "staged-next-turn") return true;
    return (
      conversation.backend === "codex" &&
      previous.lastApplyStatus === "rejected"
    );
  }

  async function persistTargetComposeFailure(input: {
    conversation: AffectedConversation;
    targetCascade: AgentCapabilityCascadeKind;
    rawMessage: string;
    sanitized: string;
  }): Promise<ConversationApplyOutcome> {
    const { conversation, targetCascade, rawMessage, sanitized } = input;
    const diagnostics: AgentCapabilityDiagnostic[] = [
      composeFailureDiagnostic({
        conversation,
        sanitized,
        cascadeKind: targetCascade,
      }),
    ];

    const metadata = metadataRegistry.get(targetCascade);
    if (metadata.backend !== conversation.backend) {
      logCascadePlan({
        trigger: "after-mutation",
        conversation,
        cascadeKind: targetCascade,
        previous: undefined,
        plannedDisposition: "unsupported",
      });
      logCascadeOutcome({
        trigger: "after-mutation",
        conversation,
        previous: undefined,
        outcome: { cascadeKind: targetCascade, disposition: "unsupported" },
      });
      return {
        projectPath: conversation.projectPath,
        sessionName: conversation.sessionName,
        conversationId: conversation.conversationId,
        backend: conversation.backend,
        cascades: [
          {
            cascadeKind: targetCascade,
            disposition: "unsupported",
          },
        ],
        diagnostics,
      };
    }

    const unsupportedPlan = planCascadeFailure({
      metadata,
      previous: undefined,
      failureKind: "compose-throw",
    });
    if (unsupportedPlan.disposition === "unsupported") {
      logCascadePlan({
        trigger: "after-mutation",
        conversation,
        cascadeKind: targetCascade,
        previous: undefined,
        plannedDisposition: "unsupported",
      });
      logCascadeOutcome({
        trigger: "after-mutation",
        conversation,
        previous: undefined,
        outcome: { cascadeKind: targetCascade, disposition: "unsupported" },
      });
      return {
        projectPath: conversation.projectPath,
        sessionName: conversation.sessionName,
        conversationId: conversation.conversationId,
        backend: conversation.backend,
        cascades: [
          {
            cascadeKind: targetCascade,
            disposition: "unsupported",
          },
        ],
        diagnostics: [
          verificationGatedDiagnostic({
            conversation,
            cascadeKind: targetCascade,
          }),
        ],
      };
    }

    const existingState = (await deps.readRuntimeState({
      projectPath: conversation.projectPath,
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
    })) ?? { cascades: {} };
    const previous = existingState.cascades[targetCascade];
    const plan = planCascadeFailure({
      metadata,
      previous,
      failureKind: "compose-throw",
    });
    if (plan.disposition === "unsupported") {
      logCascadePlan({
        trigger: "after-mutation",
        conversation,
        cascadeKind: targetCascade,
        previous,
        plannedDisposition: "unsupported",
      });
      logCascadeOutcome({
        trigger: "after-mutation",
        conversation,
        previous,
        outcome: { cascadeKind: targetCascade, disposition: "unsupported" },
      });
      return {
        projectPath: conversation.projectPath,
        sessionName: conversation.sessionName,
        conversationId: conversation.conversationId,
        backend: conversation.backend,
        cascades: [
          {
            cascadeKind: targetCascade,
            disposition: "unsupported",
          },
        ],
        diagnostics: [
          verificationGatedDiagnostic({
            conversation,
            cascadeKind: targetCascade,
          }),
        ],
      };
    }

    const nextCascadeState = recordApplyOutcome({
      previous,
      attemptedHash: plan.attemptedHash,
      attemptedItemIds: plan.attemptedItemIds,
      outcome: { status: "rejected", error: rawMessage },
    });
    const nextState: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        ...existingState.cascades,
        [targetCascade]: nextCascadeState,
      },
    };
    if (previous !== nextCascadeState) {
      await deps.writeRuntimeState({
        projectPath: conversation.projectPath,
        sessionName: conversation.sessionName,
        conversationId: conversation.conversationId,
        state: nextState,
      });
    }

    const outcome: CascadeApplyOutcome = {
      cascadeKind: targetCascade,
      disposition: "rejected",
      attemptedHash: plan.attemptedHash,
      error: sanitized,
    };
    logCascadePlan({
      trigger: "after-mutation",
      conversation,
      cascadeKind: targetCascade,
      previous,
      plannedDisposition: "rejected",
      attemptedHash: plan.attemptedHash,
      pendingItemCount: plan.attemptedItemIds.length,
      reason: plan.reason,
    });
    logCascadeOutcome({
      trigger: "after-mutation",
      conversation,
      previous,
      outcome,
    });

    return {
      projectPath: conversation.projectPath,
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
      backend: conversation.backend,
      cascades: [outcome],
      diagnostics,
    };
  }

  return {
    applyAfterOverrideChange,
    applyWhenConversationBecomesIdle,
    applyAtTurnStart,
  };
}

function mutated(
  before: AgentCapabilityRuntimeApplicationState,
  after: AgentCapabilityRuntimeApplicationState,
): boolean {
  const beforeKeys = Object.keys(before.cascades);
  const afterKeys = Object.keys(after.cascades);
  if (beforeKeys.length !== afterKeys.length) return true;
  for (const key of afterKeys) {
    const k = key as AgentCapabilityCascadeKind;
    if (before.cascades[k] !== after.cascades[k]) return true;
  }
  return false;
}
