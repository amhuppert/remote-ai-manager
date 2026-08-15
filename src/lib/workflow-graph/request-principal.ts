/**
 * The one server-side request-principal classifier for graph-workflow mutation
 * (D7 R9/R10), and the policy that decides what a principal may act on.
 *
 * Every mutation route asks the same two questions, and answering them in each
 * route is how they drift apart: one route reads a header, another trusts a
 * body field, a third forgets the check entirely. Both answers live here.
 *
 * WHO — {@link classifyWorkflowRequestPrincipal}. The server derives identity
 * only from things it can check for itself. Absence of an instance token means
 * the human browser UI, whose authority is session-wide and always has been.
 * A valid instance token means an agent, and an agent is only ever the
 * principal a SIGNATURE names: the capability key is never exported, so naming
 * another conversation requires forging a signature rather than typing an id.
 * A conversation id in a header or a request body is a CLAIM and is never
 * promoted here — that is the whole difference between this and a membership
 * check, which every sibling conversation in the session also passes.
 *
 * WHETHER — {@link authorizeExecutionMutation}. A signature proves issuance,
 * not currency, so the policy re-reads the execution: an agent conversation
 * must be the run's immutable recorded origin, and a lane must still be the
 * conversation driving its own context on its own execution. Human UI is
 * admitted unconditionally, which is the invariant this must not erode.
 *
 * Both answers are about the state the route READ. What keeps them true of the
 * state the route WRITES is {@link ./principal-fence}, which pins the act to
 * that execution's identity inside the serialized mutation.
 *
 * Launch is its own verb ({@link authorizeWorkflowLaunch}) because it is
 * refused for a reason no execution can answer: a lane launching a run would
 * nest one run inside another, and that holds even when the session's lease is
 * free.
 *
 * Reads take no capability at all. Nothing here is imported by a read path.
 */

import type { ConversationCapabilityVerification } from "@/lib/agent-gateway/conversation-capability";
import type { LaneCapabilityVerification } from "@/lib/agent-gateway/lane-capability";
import type { OptionalTokenValidation } from "@/lib/agent-gateway/token";

/** Who the server established the caller to be. Never a caller's own claim. */
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
  /** An agent that could not prove which conversation or lane it is. */
  | { kind: "unverified"; reason: string };

export interface WorkflowPrincipalDeps {
  validateOptionalToken(request: Request): Promise<OptionalTokenValidation>;
  verifyConversationCapability(
    request: Request,
  ): Promise<ConversationCapabilityVerification>;
  verifyLaneCapability(request: Request): Promise<LaneCapabilityVerification>;
}

/**
 * The session facts classification checks a capability against. A capability
 * names a (session, conversation) pair at MINT time; both halves are re-checked
 * so one session's credential cannot be replayed against another, and a
 * capability outliving its conversation cannot act.
 */
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

  // Capabilities are read BEFORE the human-UI fallback, and deliberately
  // without requiring the instance token. A capability is signed with a key no
  // agent holds, so it proves identity on its own — the token adds nothing to
  // it. Reading the token first would mean a caller presenting a valid
  // capability but no token fell through to `human_ui` and gained SESSION-WIDE
  // authority, i.e. presenting a credential would grant strictly more than that
  // credential names. Human UI must mean the absence of every agent credential,
  // not merely the absence of one of them.
  //
  // Lane before conversation: a lane is minted no conversation capability, so a
  // caller holding both carried one in from elsewhere, and the lane principal
  // is the narrower of the two — it can only ever act on its own execution.
  const lane = await deps.verifyLaneCapability(request);
  if (lane.kind === "invalid") {
    // Fail closed, and in particular do NOT fall through to the human-UI
    // branch below. A caller that presented a lane credential and failed to
    // authenticate it must not be answered with session-wide authority — that
    // would make a junk header the cheapest escalation on the port.
    return { kind: "unverified", reason: `lane_invalid:${lane.reason}` };
  }
  if (lane.kind === "valid") {
    // A lane capability signs no session, so membership is the only thing
    // binding it to one: without this a lane credential minted in session A
    // replays against session B, and a lane whose conversation is gone keeps
    // acting on a run it can no longer be driving.
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

  const conversation = await deps.verifyConversationCapability(request);
  if (conversation.kind === "absent") {
    // No capability of either kind. An instance token still marks an agent —
    // one that cannot say which conversation it is, which is a refusal. Only a
    // caller with neither credential is the browser.
    return transport.kind === "valid"
      ? { kind: "unverified", reason: "unsigned" }
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

export function authorizeExecutionMutation(input: {
  principal: WorkflowRequestPrincipal;
  execution: PrincipalExecutionFacts;
}): MutationAuthorization {
  const { principal, execution } = input;

  if (principal.kind === "human_ui") return { kind: "allowed" };

  if (
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
