/**
 * The HTTP half of workflow mutation authority (D7 R9.1/R9.4).
 *
 * {@link ./request-principal} decides WHO is calling and WHETHER they may act;
 * this turns those answers into the one refusal vocabulary every mutation route
 * speaks. It lives apart from any single route module because three of them —
 * the lifecycle verbs, live edit, and charter amendment — must answer from the
 * SAME policy: a caller refused by one must not be admitted by another simply
 * because that route grew its own check. Where they legitimately differ — every
 * verb that STEERS a run admits any verified session conversation, while
 * answering a context's approval gate keeps the run's recorded origin — the
 * difference is a declared `authority` the policy module interprets, never a
 * second check a route performs for itself.
 *
 * Every refusal here is WRITE-FREE by construction: the guard reads state and
 * builds a response, and the routes call it before the mutation they perform.
 */

import { NextResponse } from "next/server";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import type { ConversationCapabilityVerification } from "@/lib/agent-gateway/conversation-capability";
import type { LaneCapabilityVerification } from "@/lib/agent-gateway/lane-capability";
import type { OptionalTokenValidation } from "@/lib/agent-gateway/token";
import { createLogger } from "@/lib/logging";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "./schemas";
import { resolveBoundConversationId } from "./lane-binding";
import {
  ExecutionTurnoverError,
  LaneBindingTurnoverError,
  runWithExecutionPrincipalFence,
  type GraphWorkflowPrincipalFence,
} from "./principal-fence";
import {
  authorizeExecutionMutation,
  classifyWorkflowRequestPrincipal,
  type ExecutionMutationAuthority,
  type WorkflowRequestPrincipal,
} from "./request-principal";

const logger = createLogger("graph-workflow");

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
  verifyConversationCapability?(
    request: Request,
  ): Promise<ConversationCapabilityVerification>;
  verifyLaneCapability?(request: Request): Promise<LaneCapabilityVerification>;
}

/** The 401 for a presented instance token that is not the expected one. */
export function invalidTokenResponse(): Response {
  return NextResponse.json(
    { error: "Invalid Command Center API token" },
    { status: 401 },
  );
}

/**
 * The refusal for an agent that could not prove which conversation it is.
 * Identical in shape for every verb: an agent that cannot name itself gets the
 * same answer whether it tried to pause or to abandon.
 */
export function unverifiedPrincipalResponse(verb: string): Response {
  return NextResponse.json(
    {
      error: `This agent cannot ${verb} a workflow: it presented no verified conversation capability.`,
      code: "unverified_principal",
      instruction:
        "Run this from an ordinary session conversation, or act from the Command Center UI. The planner and collaboration runtimes are minted no capability and cannot act on a run.",
    },
    { status: 403 },
  );
}

/**
 * The refusal for a verified agent acting on a run it does not own. It NAMES
 * the origin, because the caller's next move depends on knowing which
 * conversation may act — and that id is not a secret from a caller already
 * holding a capability for this session.
 */
export function nonOriginPrincipalResponse(input: {
  verb: string;
  code:
    | "non_origin_principal"
    | "stale_lane_principal"
    | "origin_conversation_absent";
  originConversationId: string | null;
}): Response {
  if (input.code === "origin_conversation_absent") {
    return NextResponse.json(
      {
        error: `No agent can ${input.verb} the execution because its origin conversation no longer exists.`,
        code: input.code,
        ...(input.originConversationId !== null
          ? { originConversationId: input.originConversationId }
          : {}),
        instruction: "Act on this run from the Command Center UI.",
      },
      { status: 403 },
    );
  }

  return NextResponse.json(
    {
      error:
        input.code === "stale_lane_principal"
          ? `This lane cannot ${input.verb} the execution: it is no longer the conversation driving its context.`
          : `This conversation cannot ${input.verb} the execution: it is not the conversation that launched it.`,
      code: input.code,
      ...(input.originConversationId !== null
        ? { originConversationId: input.originConversationId }
        : {}),
      instruction:
        input.originConversationId !== null
          ? `Act from conversation ${input.originConversationId}, which launched this run, or use the Command Center UI.`
          : "This run has no agent origin; act on it from the Command Center UI.",
    },
    { status: 403 },
  );
}

/**
 * Classify the caller against a resolved session. Membership is read from that
 * session, so a capability naming a conversation the session no longer has is
 * unverified rather than trusted — which is what closes the deleted-origin
 * path.
 */
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
      verifyConversationCapability: (req) => verifyConversation(req, deps),
      verifyLaneCapability: (req) => verifyLane(req, deps),
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
): Promise<ConversationCapabilityVerification> {
  return deps.verifyConversationCapability !== undefined
    ? deps.verifyConversationCapability(request)
    : defaultVerifyConversationCapability(request);
}

function verifyLane(
  request: Request,
  deps: WorkflowMutationGuardDeps,
): Promise<LaneCapabilityVerification> {
  return deps.verifyLaneCapability !== undefined
    ? deps.verifyLaneCapability(request)
    : defaultVerifyLaneCapability(request);
}

/**
 * The gate for the acts no agent may perform at all — definition approval and
 * rejection, which are human review, not workflow authority.
 *
 * Human-only has to mean the absence of EVERY agent credential rather than the
 * absence of the instance token alone. An agent holds its capability in the
 * same environment as the token, so it can present one without the other; a
 * token-only check would read that caller as the browser and hand it the
 * review act it is barred from. This is the same ordering rule the principal
 * classifier follows, kept in one place so the two cannot drift.
 *
 * Returns the refusal to return, or null when the caller is the human UI.
 */
export async function guardHumanOnlyAct(input: {
  request: Request;
  deps: WorkflowMutationGuardDeps;
  error: string;
  instruction: string;
}): Promise<Response | null> {
  const transport = await validateTransport(input.request, input.deps);
  if (transport.kind === "invalid") return invalidTokenResponse();

  const presentsAgentCredential =
    transport.kind === "valid" ||
    (await verifyLane(input.request, input.deps)).kind !== "absent" ||
    (await verifyConversation(input.request, input.deps)).kind !== "absent";
  if (!presentsAgentCredential) return null;

  return NextResponse.json(
    {
      error: input.error,
      code: "human_act_required",
      instruction: input.instruction,
    },
    { status: 403 },
  );
}

let conversationVerifier:
  | ((request: Request) => Promise<ConversationCapabilityVerification>)
  | null = null;
let laneVerifier:
  | ((request: Request) => Promise<LaneCapabilityVerification>)
  | null = null;

async function defaultVerifyConversationCapability(
  request: Request,
): Promise<ConversationCapabilityVerification> {
  const { createConversationCapabilityVerifier } =
    await import("@/lib/agent-gateway/token");
  conversationVerifier ??= createConversationCapabilityVerifier();
  return conversationVerifier(request);
}

async function defaultVerifyLaneCapability(
  request: Request,
): Promise<LaneCapabilityVerification> {
  const { createLaneCapabilityVerifier } =
    await import("@/lib/agent-gateway/token");
  laneVerifier ??= createLaneCapabilityVerifier();
  return laneVerifier(request);
}

/**
 * The 409 for an act whose authorization was outrun by the lease.
 *
 * Not a 403: the caller did nothing wrong and may well be the successor's
 * origin too. It is the same shape of answer as any other optimistic-
 * concurrency loss — re-read the run and decide again.
 */
function executionTurnoverResponse(
  verb: string,
  error: ExecutionTurnoverError,
): Response {
  return NextResponse.json(
    {
      error: `The run this ${verb} was authorized against is no longer the session's active execution, so nothing was written.`,
      code: "execution_turnover",
      authorizedExecutionId: error.fence.executionId,
      ...(error.actualExecutionId !== null
        ? { activeExecutionId: error.actualExecutionId }
        : {}),
      instruction:
        "Re-read the session's active execution and issue the act against the run you mean to affect.",
    },
    { status: 409 },
  );
}

export type PinnedMutationOutcome<T> =
  | { kind: "acted"; value: T }
  | { kind: "turnover"; refusal: Response };

/**
 * Perform an authorized act pinned to the execution it was authorized against.
 *
 * The guard answers WHETHER a principal may act on the run it READ; the verbs
 * then write through a session-keyed API, so between those two moments the
 * lease can turn over and spend E1's authorization on E2. Running the act
 * inside the fence makes the serialized mutation re-check execution identity
 * and lane-binding currency against the row it is about to write, then abort
 * write-free if either moved ({@link ./principal-fence}).
 *
 * A null fence means nothing to pin: the human UI, whose authority is
 * session-wide by contract, and verbs with no resolved run.
 * {@link ExecutionTurnoverError} and {@link LaneBindingTurnoverError} are
 * normalized here; a manager refusal or an illegal transition is still the
 * caller's to handle.
 */
export async function runPinnedMutation<T>(
  fence: GraphWorkflowPrincipalFence | null,
  verb: string,
  run: () => Promise<T>,
): Promise<PinnedMutationOutcome<T>> {
  if (fence === null) return { kind: "acted", value: await run() };
  try {
    return {
      kind: "acted",
      value: await runWithExecutionPrincipalFence(fence, run),
    };
  } catch (error) {
    if (error instanceof LaneBindingTurnoverError) {
      logger.warn("graph-workflow.mutation.lane_binding_turnover", {
        sessionName: fence.sessionName,
        verb,
        executionId: fence.executionId,
        contextId:
          fence.principal.kind === "lane"
            ? fence.principal.contextId
            : undefined,
        authorizedConversationId:
          fence.principal.kind === "lane"
            ? fence.principal.conversationId
            : undefined,
        activeConversationId: error.actualConversationId,
      });
      return {
        kind: "turnover",
        refusal: nonOriginPrincipalResponse({
          verb,
          code: "stale_lane_principal",
          originConversationId: fence.originConversationId,
        }),
      };
    }
    if (!(error instanceof ExecutionTurnoverError)) throw error;
    logger.warn("graph-workflow.mutation.execution_turnover", {
      sessionName: fence.sessionName,
      verb,
      authorizedExecutionId: fence.executionId,
      activeExecutionId: error.actualExecutionId,
      principal: fence.principal.kind,
    });
    return {
      kind: "turnover",
      refusal: executionTurnoverResponse(verb, error),
    };
  }
}

export type GuardedExecutionMutation = {
  principal: WorkflowRequestPrincipal;
  /**
   * Pass to {@link runPinnedMutation} around the act's writes. Null when there
   * is nothing to pin — see that function.
   */
  fence: GraphWorkflowPrincipalFence | null;
};

/**
 * The one mutation gate every lifecycle verb passes through.
 *
 * Returns a ready-to-return refusal, or the established principal plus the
 * fence that keeps its authorization attached to the execution it was granted
 * over. `execution` null means the verb has no run to scope against yet, so any
 * verified principal is admitted and the per-execution authority check happens
 * once the run is resolved.
 */
export async function guardExecutionMutation(input: {
  request: Request;
  session: SessionState;
  deps: WorkflowMutationGuardDeps;
  verb: string;
  execution: GraphWorkflowExecution | null;
  /**
   * Which conversations this act admits. Omitted means launch authority — the
   * narrow rule — so a verb that never states one cannot widen by accident.
   */
  authority?: ExecutionMutationAuthority;
  /**
   * The project the session lives in. Part of the fence rather than inferred,
   * because the fence names a (projectPath, sessionName) pair: a fenced act's
   * writes to OTHER sessions — collaboration dispatch does this — stay outside
   * its claim.
   */
  projectPath: string;
}): Promise<{ refusal: Response } | GuardedExecutionMutation> {
  const classified = await classifyRoutePrincipal(
    input.request,
    input.session,
    input.deps,
  );
  if (classified.kind === "invalid_token") {
    return { refusal: invalidTokenResponse() };
  }
  if (classified.kind === "unverified") {
    logger.warn("graph-workflow.mutation.principal_unverified", {
      sessionName: input.session.sessionName,
      verb: input.verb,
      reason: classified.reason,
    });
    return { refusal: unverifiedPrincipalResponse(input.verb) };
  }

  const { principal } = classified;
  // Nothing to pin: the human UI acts on "whatever this session is running" by
  // contract (R9.2), and a verb with no resolved run has no identity to hold
  // still — its own launch reservation is the authority there.
  if (input.execution === null || principal.kind === "human_ui") {
    return { principal, fence: null };
  }

  const execution = input.execution;
  const authorization = authorizeExecutionMutation({
    principal,
    authority: input.authority,
    execution: {
      executionId: execution.id,
      originConversationId: execution.ownerConversationId,
      originConversationExists:
        execution.ownerConversationId !== null &&
        input.session.conversations.some(
          (conversation) => conversation.id === execution.ownerConversationId,
        ),
      boundLaneConversationId: (contextId) =>
        resolveBoundConversationId(execution, contextId),
    },
  });
  if (authorization.kind === "refused") {
    logger.warn("graph-workflow.mutation.principal_refused", {
      sessionName: input.session.sessionName,
      verb: input.verb,
      code: authorization.code,
      principal: principal.kind,
      owned: execution.ownerConversationId !== null,
    });
    return {
      refusal: nonOriginPrincipalResponse({
        verb: input.verb,
        code: authorization.code,
        originConversationId: authorization.originConversationId,
      }),
    };
  }
  return {
    principal,
    fence: {
      projectPath: input.projectPath,
      sessionName: input.session.sessionName,
      executionId: execution.id,
      originConversationId: execution.ownerConversationId,
      principal,
    },
  };
}
