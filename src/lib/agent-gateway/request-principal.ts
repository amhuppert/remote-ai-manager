/** Coordinates trusted agents against session membership and current lane bindings. */
import { NextResponse } from "next/server";
import {
  CONVERSATION_IDENTITY_HEADER,
  readConversationIdentity,
  type ConversationIdentityReading,
} from "./conversation-identity";
import {
  LANE_IDENTITY_HEADER,
  readLaneIdentity,
  type LaneIdentityReading,
} from "./lane-identity";
import { createAgentAuth, type OptionalTokenValidation } from "./token";
import type { SessionState } from "@/lib/sessions/schemas";

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
 * What a route must supply to be guarded. All optional so a production route
 * inherits the registered verifiers and a test injects its own; the defaults
 * are resolved per call rather than at module scope, because building a
 * verifier reads the config directory and doing that during the build's module
 * evaluation reads the BUILD machine's config rather than the server's.
 */
export interface WorkflowMutationGuardDeps {
  auth?: {
    validateOptionalToken(request: Request): Promise<OptionalTokenValidation>;
  };
  readConversationIdentity?(
    request: Request,
  ): Promise<ConversationIdentityReading>;
  readLaneIdentity?(request: Request): Promise<LaneIdentityReading>;
}

/** The 401 for a presented instance token that is not the expected one. */
export function invalidTokenResponse(): Response {
  return NextResponse.json(
    { error: "Invalid Command Center API token" },
    { status: 401 },
  );
}

export function classifyRoutePrincipal(
  request: Request,
  session: SessionState,
  deps: WorkflowMutationGuardDeps,
) {
  return classifyWorkflowRequestPrincipal(
    request,
    {
      sessionName: session.sessionName,
      conversationIds: session.conversations.map(
        (conversation) => conversation.id,
      ),
    },
    {
      validateOptionalToken: (req) => validateTransport(req, deps),
      readConversationIdentity: (req) => verifyConversation(req, deps),
      readLaneIdentity: (req) => verifyLane(req, deps),
    },
  );
}

function validateTransport(
  request: Request,
  deps: WorkflowMutationGuardDeps,
): Promise<OptionalTokenValidation> {
  return (deps.auth ?? createAgentAuth()).validateOptionalToken(request);
}

function verifyConversation(
  request: Request,
  deps: WorkflowMutationGuardDeps,
): Promise<ConversationIdentityReading> {
  return deps.readConversationIdentity !== undefined
    ? deps.readConversationIdentity(request)
    : Promise.resolve(
        readConversationIdentity(
          request.headers.get(CONVERSATION_IDENTITY_HEADER),
        ),
      );
}

function verifyLane(
  request: Request,
  deps: WorkflowMutationGuardDeps,
): Promise<LaneIdentityReading> {
  return deps.readLaneIdentity !== undefined
    ? deps.readLaneIdentity(request)
    : Promise.resolve(
        readLaneIdentity(request.headers.get(LANE_IDENTITY_HEADER)),
      );
}
