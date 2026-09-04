import type { GlobalConfig } from "@/lib/config/schemas";
import { resolveMemoryConfig } from "@/lib/config/schemas";
import type { ConversationRole } from "@/lib/conversations/schemas";
import { createLogger } from "@/lib/logging";
import type { CollaborationConfigSource } from "@/lib/workflow-graph/collaboration-schemas";
import type { ResolvedMemoryPolicyConfig } from "@/lib/workflow-graph/definition-schemas";
import { coerceGlobalDefaults } from "@/lib/workflow-graph/resolve-config";

import type {
  MemoryActor,
  MemoryContributionPolicy,
  MemoryIndexBudget,
  MemoryReadPolicy,
} from "./schemas";

/**
 * The memory delivery policy cascade (spec R10, D7): what a conversation reads
 * unasked and whether it may write, resolved by ROLE through the configuration
 * cascade. Ordinary conversations read `memory.conversations` from global
 * settings; workflow lanes read the per-role policy their execution context was
 * seeded with (global defaults → workflow definition → per-context override,
 * see `resolveMemoryPolicyWithProvenance`), or the global role default when the
 * context predates the snapshot. Every ambient delivery path and every memory
 * mutation resolves its policy here and nowhere else.
 */

const logger = createLogger("memory.policy");

/**
 * The three roles the cascade distinguishes. `conversation` is every
 * human-addressed conversation (including the planner and legacy
 * initialization rows): those hold no lane and take the global conversation
 * policy. The lane roles map onto the per-role blocks of the workflow cascade.
 */
export type MemoryPolicyRole = "conversation" | "implementer" | "validator";

export type MemoryPolicySource = CollaborationConfigSource;

/** One resolved policy: which role it is for and, per half, which tier decided it. */
export interface MemoryPolicyResolution {
  readonly role: MemoryPolicyRole;
  readonly read: {
    readonly value: MemoryReadPolicy;
    readonly source: MemoryPolicySource;
  };
  readonly contribute: {
    readonly value: MemoryContributionPolicy;
    readonly source: MemoryPolicySource;
  };
}

export function memoryPolicyRoleFor(role: ConversationRole): MemoryPolicyRole {
  switch (role) {
    case "iteration":
      return "implementer";
    case "validator":
      return "validator";
    default:
      return "conversation";
  }
}

/**
 * Pure resolution. `contextPolicy` is the per-role snapshot the lane's
 * execution context carries (seeded through the workflow cascade); it is
 * consulted for lane roles only, because an ordinary conversation holds no
 * context and the snapshot's tiers do not apply to it.
 */
export function resolveMemoryDeliveryPolicy(
  config: GlobalConfig,
  role: ConversationRole,
  contextPolicy: ResolvedMemoryPolicyConfig | null,
): MemoryPolicyResolution {
  const policyRole = memoryPolicyRoleFor(role);
  if (policyRole === "conversation") {
    const conversations = resolveMemoryConfig(config).conversations;
    return {
      role: policyRole,
      read: { value: conversations.read, source: "global" },
      contribute: { value: conversations.contribute, source: "global" },
    };
  }
  if (contextPolicy !== null) {
    const snapshot = contextPolicy[policyRole];
    return {
      role: policyRole,
      read: { value: snapshot.read.value, source: snapshot.read.source },
      contribute: {
        value: snapshot.contribute.value,
        source: snapshot.contribute.source,
      },
    };
  }
  const global = coerceGlobalDefaults(config.workflowDefaults).memory[
    policyRole
  ];
  return {
    role: policyRole,
    read: { value: global.read, source: "global" },
    contribute: { value: global.contribute, source: "global" },
  };
}

// ============================================================
// Live resolution
// ============================================================

/** The conversation whose policy is being resolved, as delivery and the gate both know it. */
export interface MemoryPolicySubject {
  readonly projectPath: string;
  readonly conversation:
    | { readonly kind: "session"; readonly sessionName: string }
    | { readonly kind: "project" };
  readonly role: ConversationRole;
  /** The lane's execution context, when the conversation drives one; null otherwise. */
  readonly workflow: {
    readonly executionId: string;
    readonly contextId: string;
  } | null;
}

export interface MemoryPolicyContextRef {
  readonly projectPath: string;
  readonly sessionName: string;
  readonly executionId: string;
  readonly contextId: string;
}

export interface MemoryPolicyResolverDeps {
  /** Global settings, re-read per resolution so an edit is live on the next turn. */
  readConfig(): Promise<GlobalConfig>;
  /**
   * The per-role snapshot frozen on the execution context at seed time, or
   * null when the execution or context is gone or predates the snapshot.
   */
  findContextPolicy(
    ref: MemoryPolicyContextRef,
  ): Promise<ResolvedMemoryPolicyConfig | null>;
}

export interface MemoryPolicyResolver {
  resolve(subject: MemoryPolicySubject): Promise<MemoryPolicyResolution>;
}

export function createMemoryPolicyResolver(
  deps: MemoryPolicyResolverDeps,
): MemoryPolicyResolver {
  return {
    async resolve(subject) {
      const config = await deps.readConfig();
      // Lanes are session conversations; a project conversation can name no
      // context, and an ordinary conversation's policy ignores one anyway.
      const contextPolicy =
        subject.workflow !== null &&
        subject.conversation.kind === "session" &&
        memoryPolicyRoleFor(subject.role) !== "conversation"
          ? await deps.findContextPolicy({
              projectPath: subject.projectPath,
              sessionName: subject.conversation.sessionName,
              executionId: subject.workflow.executionId,
              contextId: subject.workflow.contextId,
            })
          : null;
      return resolveMemoryDeliveryPolicy(config, subject.role, contextPolicy);
    },
  };
}

// ============================================================
// Contribution gate
// ============================================================

/** Where a conversation id lives, as the state store can place it. */
export interface MemoryConversationLocation {
  readonly projectPath: string;
  readonly conversation:
    | { readonly kind: "session"; readonly sessionName: string }
    | { readonly kind: "project" };
  readonly role: ConversationRole;
}

export interface MemoryLaneBindingRef {
  readonly projectPath: string;
  readonly sessionName: string;
  readonly conversationId: string;
}

export interface MemoryContributionGateDeps {
  resolver: MemoryPolicyResolver;
  /** Null when no session or project conversation carries this id. */
  locateConversation(
    conversationId: string,
  ): Promise<MemoryConversationLocation | null>;
  /**
   * The execution context this conversation is driving right now, or null
   * when it drives none (no active execution, or the lane is between
   * iterations). Read from the execution's own lane bindings, never from a
   * caller-supplied id.
   */
  findLaneBinding(ref: MemoryLaneBindingRef): Promise<{
    readonly executionId: string;
    readonly contextId: string;
  } | null>;
}

export type MemoryContributionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "contribution_off";
      readonly policy: MemoryPolicyResolution;
    }
  | {
      readonly allowed: false;
      readonly reason: "caller_unresolved";
      readonly conversationId: string;
    };

export interface MemoryContributionGate {
  decide(actor: MemoryActor): Promise<MemoryContributionDecision>;
}

/**
 * Decides whether an actor may mutate memory (R10). A human always may — the
 * Library is the repair surface. An agent is placed by its conversation id:
 * the conversation's role and, for a lane, the execution context it is bound
 * to resolve the policy. A caller Command Center cannot place at all is
 * refused: the roles the spec ships as off are exactly the ones that would
 * otherwise slip through as "no role".
 */
export function createMemoryContributionGate(
  deps: MemoryContributionGateDeps,
): MemoryContributionGate {
  return {
    async decide(actor) {
      if (actor.kind === "user") return { allowed: true };
      const location = await deps.locateConversation(actor.conversationId);
      if (location === null) {
        logger.warn("memory.policy.caller_unresolved", {
          conversationId: actor.conversationId,
        });
        return {
          allowed: false,
          reason: "caller_unresolved",
          conversationId: actor.conversationId,
        };
      }
      const workflow =
        location.conversation.kind === "session" &&
        memoryPolicyRoleFor(location.role) !== "conversation"
          ? await deps.findLaneBinding({
              projectPath: location.projectPath,
              sessionName: location.conversation.sessionName,
              conversationId: actor.conversationId,
            })
          : null;
      const policy = await deps.resolver.resolve({
        projectPath: location.projectPath,
        conversation: location.conversation,
        role: location.role,
        workflow,
      });
      if (policy.contribute.value === "off") {
        return { allowed: false, reason: "contribution_off", policy };
      }
      return { allowed: true };
    },
  };
}

/**
 * The index budget as global settings hold it (R10.3). Global settings are
 * the only source: no project, workflow, or conversation layer is consulted,
 * because none may override it.
 */
export function resolveMemoryIndexBudget(
  config: GlobalConfig,
): MemoryIndexBudget {
  return resolveMemoryConfig(config).indexBudget;
}
