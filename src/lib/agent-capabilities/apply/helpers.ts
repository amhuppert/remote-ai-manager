import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  ResolvedCapabilityCascade,
  RuntimeConfigApplyResult,
} from "@/lib/agent-backends/runtime-config";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeRuntimeState,
  AgentCapabilityDiagnostic,
  AgentCapabilityRuntimeApplicationState,
} from "../schemas";

import type { AgentCapabilityMetadataRegistry } from "../metadata";
import type { ComposeConversationStartResult } from "../runtime-composer";
import type { MutationScope } from "../mutation-service";

export type ApplyConversationIdentity =
  | SessionApplyConversationIdentity
  | ProjectApplyConversationIdentity;

export interface SessionApplyConversationIdentity {
  conversationScope?: "session";
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
  backend: AgentBackendId;
}

export interface ProjectApplyConversationIdentity {
  conversationScope: "project";
  projectPath: string;
  projectName: string;
  conversationId: string;
  worktreePath: string;
  backend: AgentBackendId;
}

export type AffectedConversation = ApplyConversationIdentity;

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
  /** Produce a fresh conversation-start runtime composition that reflects the
   * current persisted overrides + discovery. */
  composeForConversation(
    conversation: ApplyConversationIdentity,
  ): Promise<ComposeConversationStartResult>;
  /** Read the conversation's stored runtime apply state. */
  readRuntimeState(
    conversation: ApplyConversationIdentity,
  ): Promise<AgentCapabilityRuntimeApplicationState | undefined>;
  /** Commit against the fresh persisted state inside its short atomic mutation. */
  updateRuntimeState(
    conversation: ApplyConversationIdentity,
    updater: (
      current: AgentCapabilityRuntimeApplicationState | undefined,
    ) => AgentCapabilityRuntimeApplicationState,
  ): Promise<void>;
  /**
   * Apply a freshly-resolved capability cascade to the conversation's live
   * runtime through the backend descriptor's runtime-config adapter.
   * Translation into the provider payload happens below the seam; the port
   * returns the declared apply disposition and the apply service is
   * responsible for storing the result via `recordApplyOutcome`.
   */
  applyRuntimeConfig?(input: {
    conversation: ApplyConversationIdentity;
    resolved: ResolvedCapabilityCascade;
  }): Promise<RuntimeConfigApplyResult>;
}

export interface CascadeApplyOutcome {
  cascadeKind: AgentCapabilityCascadeKind;
  disposition:
    | "applied"
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
  conversationScope?: "session" | "project";
  sessionName?: string;
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

export type ApplyAtConversationInput = ApplyConversationIdentity;

export interface CapabilityRuntimeApplyService {
  applyAfterOverrideChange(
    input: ApplyAfterMutationInput,
  ): Promise<ApplyAfterMutationResult>;
  applyAtTurnStart(
    input: ApplyAtConversationInput,
  ): Promise<ConversationApplyOutcome>;
}

export type ApplyTrigger = "after-mutation" | "turn-start";

export interface ComposedCascadeInfo {
  cascadeKind: AgentCapabilityCascadeKind;
  attemptedHash: string;
  attemptedItemIds: readonly string[];
}

export interface ApplyOneCascadeResult {
  outcome: CascadeApplyOutcome;
  nextState: AgentCapabilityCascadeRuntimeState | undefined;
  diagnostic?: AgentCapabilityDiagnostic;
}

export interface ApplyContext {
  deps: ApplyServiceDeps;
  metadataRegistry: AgentCapabilityMetadataRegistry;
}

export function mutated(
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

/** Preserve changes accepted while a runtime operation was in flight. */
export function mergeRuntimeOutcomes(
  current: AgentCapabilityRuntimeApplicationState | undefined,
  previous: AgentCapabilityRuntimeApplicationState,
  next: AgentCapabilityRuntimeApplicationState,
): AgentCapabilityRuntimeApplicationState {
  const cascades = { ...current?.cascades };
  const kinds = new Set([
    ...Object.keys(previous.cascades),
    ...Object.keys(next.cascades),
  ]);
  for (const rawKind of kinds) {
    const kind = rawKind as AgentCapabilityCascadeKind;
    const before = previous.cascades[kind];
    const after = next.cascades[kind];
    if (before === after) continue;
    const fresh = cascades[kind];
    if (JSON.stringify(fresh) === JSON.stringify(before)) {
      if (after === undefined) delete cascades[kind];
      else cascades[kind] = after;
    } else if (
      after?.lastApplyStatus === "applied" &&
      fresh &&
      fresh.appliedHash === before?.appliedHash
    ) {
      // Delivery A is real, but it must not clear preference B saved during A.
      cascades[kind] = { ...fresh, appliedHash: after.appliedHash };
    }
  }
  return { cascades };
}

export function conversationScopeOf(
  conversation: Pick<ApplyConversationIdentity, "conversationScope">,
): "session" | "project" {
  return conversation.conversationScope === "project" ? "project" : "session";
}

export function isProjectApplyConversation(
  conversation: ApplyConversationIdentity,
): conversation is ProjectApplyConversationIdentity {
  return conversation.conversationScope === "project";
}

export function conversationIdentityForPorts(
  conversation: ApplyConversationIdentity,
): ApplyConversationIdentity {
  if (isProjectApplyConversation(conversation)) {
    return {
      conversationScope: "project",
      projectPath: conversation.projectPath,
      projectName: conversation.projectName,
      conversationId: conversation.conversationId,
      worktreePath: conversation.worktreePath,
      backend: conversation.backend,
    };
  }
  return {
    conversationScope: conversation.conversationScope,
    projectPath: conversation.projectPath,
    projectName: conversation.projectName,
    sessionName: conversation.sessionName,
    conversationId: conversation.conversationId,
    worktreePath: conversation.worktreePath,
    backend: conversation.backend,
  };
}

export function conversationOutcomeIdentity(
  conversation: ApplyConversationIdentity,
): Pick<
  ConversationApplyOutcome,
  | "projectPath"
  | "conversationScope"
  | "sessionName"
  | "conversationId"
  | "backend"
> {
  if (isProjectApplyConversation(conversation)) {
    return {
      projectPath: conversation.projectPath,
      conversationScope: "project",
      conversationId: conversation.conversationId,
      backend: conversation.backend,
    };
  }
  return {
    projectPath: conversation.projectPath,
    conversationScope: conversation.conversationScope,
    sessionName: conversation.sessionName,
    conversationId: conversation.conversationId,
    backend: conversation.backend,
  };
}

export function composeFailureDiagnostic(input: {
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

export function verificationGatedDiagnostic(input: {
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
