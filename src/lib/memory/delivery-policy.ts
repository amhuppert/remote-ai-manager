import type { GlobalConfig } from "@/lib/config/schemas";
import { resolveMemoryConfig } from "@/lib/config/schemas";
import type { ConversationRole } from "@/lib/conversations/schemas";
import { createLogger } from "@/lib/logging";

import type {
  MemoryActor,
  MemoryContributionPolicy,
  MemoryIndexBudget,
  MemoryReadPolicy,
} from "./schemas";

/** Role-based settings govern every memory delivery and mutation. Ordinary
 * conversations use memory.conversations; historical role rows use memory.roles.
 */

const logger = createLogger("memory.policy");

/**
 * The three roles the cascade distinguishes. `conversation` is every
 * human-addressed conversation (including the planner and legacy
 * initialization rows): those hold no lane and take the global conversation
 * policy. Historical lane roles map onto memory.roles.
 */
export type MemoryPolicyRole = "conversation" | "implementer" | "validator";

/** Which tier decided a policy half. */
export type MemoryPolicySource = "global";

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

/** Resolve one conversation role through the current global settings. */
export function resolveMemoryDeliveryPolicy(
  config: GlobalConfig,
  role: ConversationRole,
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
  const global = resolveMemoryConfig(config).roles[policyRole];
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
}

export interface MemoryPolicyResolverDeps {
  readConfig(): Promise<GlobalConfig>;
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
      return resolveMemoryDeliveryPolicy(config, subject.role);
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

export interface MemoryContributionGateDeps {
  resolver: MemoryPolicyResolver;
  locateConversation(
    conversationId: string,
  ): Promise<MemoryConversationLocation | null>;
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
      const policy = await deps.resolver.resolve({
        projectPath: location.projectPath,
        conversation: location.conversation,
        role: location.role,
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
