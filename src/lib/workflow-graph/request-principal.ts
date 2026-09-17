/** Coordinates trusted agents against session membership and current lane bindings. */
import type { ConversationIdentityReading } from "@/lib/agent-gateway/conversation-identity";
import type { LaneIdentityReading } from "@/lib/agent-gateway/lane-identity";
import type { OptionalTokenValidation } from "@/lib/agent-gateway/token";

/** Caller identity checked against the current session. */
export type WorkflowRequestPrincipal =
  | { kind: "human_ui" }
  | { kind: "conversation"; conversationId: string }
  | {
      kind: "lane";
      executionId: string;
      contextId: string;
      conversationId: string;
    };

export type WorkflowPrincipalClassification =
  | { kind: "principal"; principal: WorkflowRequestPrincipal }
  /** Transport failed: a presented instance token that is not the expected one. */
  | { kind: "invalid_token" }
  /** An agent that did not name a recognized conversation or lane. */
  | { kind: "unverified"; reason: string };

export interface WorkflowPrincipalDeps {
  validateOptionalToken(request: Request): Promise<OptionalTokenValidation>;
  readConversationIdentity(
    request: Request,
  ): Promise<ConversationIdentityReading>;
  readLaneIdentity(request: Request): Promise<LaneIdentityReading>;
}

export interface WorkflowPrincipalSessionFacts {
  sessionName: string;
  conversationIds: readonly string[];
}

export async function classifyWorkflowRequestPrincipal(
  request: Request,
  session: WorkflowPrincipalSessionFacts,
  deps: WorkflowPrincipalDeps,
): Promise<WorkflowPrincipalClassification> {
  const transport = await deps.validateOptionalToken(request);
  if (transport.kind === "invalid") return { kind: "invalid_token" };

  const lane = await deps.readLaneIdentity(request);
  if (lane.kind === "invalid") {
    return { kind: "unverified", reason: `lane_invalid:${lane.reason}` };
  }
  if (lane.kind === "valid") {
    if (!session.conversationIds.includes(lane.scope.conversationId)) {
      return { kind: "unverified", reason: "lane_conversation_absent" };
    }
    return {
      kind: "principal",
      principal: {
        kind: "lane",
        executionId: lane.scope.executionId,
        contextId: lane.scope.contextId,
        conversationId: lane.scope.conversationId,
      },
    };
  }

  const conversation = await deps.readConversationIdentity(request);
  if (conversation.kind === "absent") {
    return transport.kind === "valid"
      ? { kind: "unverified", reason: "missing_identity" }
      : { kind: "principal", principal: { kind: "human_ui" } };
  }
  if (conversation.kind === "invalid") {
    return { kind: "unverified", reason: `invalid:${conversation.reason}` };
  }
  if (conversation.scope.sessionName !== session.sessionName) {
    return { kind: "unverified", reason: "session_mismatch" };
  }
  if (!session.conversationIds.includes(conversation.scope.conversationId)) {
    return { kind: "unverified", reason: "conversation_absent" };
  }
  return {
    kind: "principal",
    principal: {
      kind: "conversation",
      conversationId: conversation.scope.conversationId,
    },
  };
}

/**
 * The execution facts policy decides against, narrowed to what authorization
 * actually reads. A structural input rather than the full execution so the
 * policy stays pure and the lane-binding read stays the caller's — the caller
 * is the one holding a live execution to resolve it from.
 */
export interface PrincipalExecutionFacts {
  executionId: string;
  /** The run's immutable recorded origin; null on an unowned run. */
  originConversationId: string | null;
  /** Whether that recorded origin is still a conversation in the session. */
  originConversationExists: boolean;
  /** Which conversation drives `contextId` right now, or null if none does. */
  boundLaneConversationId(contextId: string): string | null;
}

export type MutationAuthorization =
  | { kind: "allowed" }
  | {
      kind: "refused";
      code:
        | "non_origin_principal"
        | "stale_lane_principal"
        | "origin_conversation_absent";
      /** Named in the refusal so the caller learns which conversation may act. */
      originConversationId: string | null;
    };

/**
 * Which conversations an act on a launched execution admits.
 *
 * `any_session_conversation` is membership authority: every conversation the
 * classifier verified into this session. Every verb that STEERS a run — the
 * lifecycle verbs and live editing — uses it. Acting on a run in flight is
 * work on the run rather than a decision about its launch, the conversation
 * holding the context to pause or repair it is routinely not the one that
 * typed the launch, and a UI-launched run records no origin at all, which
 * under the rule below meant no agent could ever act on it.
 *
 * `origin_conversation` is launch authority: only the run's immutable recorded
 * origin, and a run whose origin was deleted admits no agent at all — nobody
 * inherits the vacancy. Answering a context's approval gate uses it, because
 * the run posed that question to whoever launched it; membership authority
 * would let any sibling answer on their behalf. `any_session_conversation`
 * correspondingly retires the deleted-origin refusal, whose only job is to
 * keep that vacancy from being inherited.
 *
 * Neither value touches lane authority: a lane must still be the conversation
 * currently driving its own context on its own execution, because that is a
 * currency check rather than an ownership one.
 */
export type ExecutionMutationAuthority =
  | "origin_conversation"
  | "any_session_conversation";

export function authorizeExecutionMutation(input: {
  principal: WorkflowRequestPrincipal;
  execution: PrincipalExecutionFacts;
  /** Defaults to launch authority, so a new caller inherits the narrow rule. */
  authority?: ExecutionMutationAuthority;
}): MutationAuthorization {
  const { principal, execution } = input;
  const originGated =
    (input.authority ?? "origin_conversation") === "origin_conversation";

  if (principal.kind === "human_ui") return { kind: "allowed" };

  if (
    originGated &&
    execution.originConversationId !== null &&
    !execution.originConversationExists
  ) {
    return {
      kind: "refused",
      code: "origin_conversation_absent",
      originConversationId: execution.originConversationId,
    };
  }

  if (principal.kind === "conversation") {
    if (!originGated) return { kind: "allowed" };
    // Null origin is refused rather than matched: an unowned run would
    // otherwise admit every agent whose own id is also absent, and "no origin"
    // must mean "no agent", not "any agent".
    const allowed =
      execution.originConversationId !== null &&
      execution.originConversationId === principal.conversationId;
    return allowed
      ? { kind: "allowed" }
      : {
          kind: "refused",
          code: "non_origin_principal",
          originConversationId: execution.originConversationId,
        };
  }

  const current = execution.boundLaneConversationId(principal.contextId);
  const allowed =
    principal.executionId === execution.executionId &&
    current !== null &&
    current === principal.conversationId;
  return allowed
    ? { kind: "allowed" }
    : {
        kind: "refused",
        code: "stale_lane_principal",
        originConversationId: execution.originConversationId,
      };
}

export type LaunchAuthorization =
  | { kind: "allowed" }
  | { kind: "refused"; code: "workflow_nesting_refused" };

/**
 * Launch admits the human UI and any ordinary conversation. A lane is refused
 * as NESTING rather than as a lease conflict, because the reason is structural:
 * a run must not launch a run, and a free lease does not change that.
 */
export function authorizeWorkflowLaunch(
  principal: WorkflowRequestPrincipal,
): LaunchAuthorization {
  return principal.kind === "lane"
    ? { kind: "refused", code: "workflow_nesting_refused" }
    : { kind: "allowed" };
}
