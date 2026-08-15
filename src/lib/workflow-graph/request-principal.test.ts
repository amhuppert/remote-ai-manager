/**
 * The shared request-principal classifier and mutation policy (D7 R9/R10).
 *
 * Two questions live here, and keeping them apart is the point. Classification
 * asks WHO is calling and answers it only from things the server can check for
 * itself — token presence, and a signature under a key no agent holds. Policy
 * asks WHETHER that principal may act on this execution, and answers it from
 * the execution's own recorded origin and live lane binding.
 *
 * The failure this design exists to prevent is a claimed id becoming authority.
 * A conversation id in a header, a body, or a capability payload the signature
 * did not cover is a claim; the classifier never promotes one, so naming
 * another conversation requires forging a signature rather than typing an id.
 */

import { describe, expect, it } from "vitest";
import type { ConversationCapabilityVerification } from "@/lib/agent-gateway/conversation-capability";
import type { LaneCapabilityVerification } from "@/lib/agent-gateway/lane-capability";
import type { OptionalTokenValidation } from "@/lib/agent-gateway/token";
import {
  authorizeExecutionMutation,
  authorizeWorkflowLaunch,
  classifyWorkflowRequestPrincipal,
  type PrincipalExecutionFacts,
  type WorkflowPrincipalDeps,
} from "./request-principal";

const SESSION = "session-1";

const request = (): Request => new Request("http://localhost/api/x");

function deps(overrides: {
  transport?: OptionalTokenValidation["kind"];
  conversation?: ConversationCapabilityVerification;
  lane?: LaneCapabilityVerification;
  conversationIds?: readonly string[];
}): WorkflowPrincipalDeps {
  return {
    validateOptionalToken: async () => ({
      kind: overrides.transport ?? "absent",
    }),
    verifyConversationCapability: async () =>
      overrides.conversation ?? { kind: "absent" },
    verifyLaneCapability: async () => overrides.lane ?? { kind: "absent" },
  };
}

const membership = (ids: readonly string[]) => ({
  sessionName: SESSION,
  conversationIds: ids,
});

const validConversation = (
  conversationId: string,
  sessionName: string = SESSION,
): ConversationCapabilityVerification => ({
  kind: "valid",
  scope: { sessionName, conversationId },
  issuedAt: 1,
});

const validLane = (
  executionId: string,
  contextId: string,
  conversationId: string,
): LaneCapabilityVerification => ({
  kind: "valid",
  scope: { laneKind: "implementer", executionId, contextId, conversationId },
  issuedAt: 1,
});

const facts = (
  overrides?: Partial<PrincipalExecutionFacts>,
): PrincipalExecutionFacts => ({
  executionId: "exec-1",
  originConversationId: "origin-conv",
  originConversationExists: true,
  boundLaneConversationId: () => null,
  ...overrides,
});

describe("classifyWorkflowRequestPrincipal", () => {
  it("classifies a credential-free caller as the human UI", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({ transport: "absent" }),
    );

    expect(result).toEqual({
      kind: "principal",
      principal: { kind: "human_ui" },
    });
  });

  it("rejects a malformed or wrong instance token outright", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({ transport: "invalid" }),
    );

    expect(result).toEqual({ kind: "invalid_token" });
  });

  it("derives an agent's conversation principal from the signature", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv", "sibling-conv"]),
      deps({
        transport: "valid",
        conversation: validConversation("sibling-conv"),
      }),
    );

    expect(result).toEqual({
      kind: "principal",
      principal: { kind: "conversation", conversationId: "sibling-conv" },
    });
  });

  it("refuses an agent that presents no capability at all", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({ transport: "valid" }),
    );

    expect(result).toEqual({ kind: "unverified", reason: "unsigned" });
  });

  it("honours a capability presented without an instance token", async () => {
    // The capability is signed with a key no agent holds, so it proves identity
    // on its own. Falling through to human_ui here would mean presenting a
    // credential granted SESSION-WIDE authority — strictly more than the
    // credential names, which is an escalation, not a fallback.
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({
        transport: "absent",
        conversation: validConversation("origin-conv"),
      }),
    );

    expect(result).toEqual({
      kind: "principal",
      principal: { kind: "conversation", conversationId: "origin-conv" },
    });
  });

  it("honours a lane capability presented without an instance token", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["lane-conv"]),
      deps({
        transport: "absent",
        lane: validLane("exec-1", "context-a", "lane-conv"),
      }),
    );

    expect(result).toEqual({
      kind: "principal",
      principal: {
        kind: "lane",
        executionId: "exec-1",
        contextId: "context-a",
        conversationId: "lane-conv",
      },
    });
  });

  it("refuses a forged LANE capability rather than falling back to human authority", async () => {
    // The cheapest escalation available to anything that can reach the port:
    // send a junk lane header, no token, no conversation capability. Falling
    // through to human_ui would answer a failed authentication with
    // SESSION-WIDE authority — strictly more than the credential even claimed,
    // and enough to launch a run.
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({
        transport: "absent",
        lane: { kind: "invalid", reason: "bad_signature" },
      }),
    );

    expect(result).toEqual({
      kind: "unverified",
      reason: "lane_invalid:bad_signature",
    });
  });

  it("refuses a lane capability naming a conversation this session does not have", async () => {
    // A lane capability signs no session, so membership is the only thing
    // binding it to one: without this check a lane credential from session A
    // replays against session B, and a lane whose conversation was deleted
    // keeps acting.
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({
        transport: "valid",
        lane: validLane("exec-1", "context-a", "lane-conv"),
      }),
    );

    expect(result).toEqual({
      kind: "unverified",
      reason: "lane_conversation_absent",
    });
  });

  it("refuses a forged capability even from a token-free caller", async () => {
    // Otherwise the cheapest forgery would be to send a bad capability with no
    // token and be handed human authority for failing to authenticate.
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({
        transport: "absent",
        conversation: { kind: "invalid", reason: "bad_signature" },
      }),
    );

    expect(result).toEqual({
      kind: "unverified",
      reason: "invalid:bad_signature",
    });
  });

  it("refuses a capability minted for a different session", async () => {
    // A capability is a bearer credential; without the session in the signed
    // payload it would replay from one session into another.
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({
        transport: "valid",
        conversation: validConversation("origin-conv", "other-session"),
      }),
    );

    expect(result).toEqual({ kind: "unverified", reason: "session_mismatch" });
  });

  it("refuses a signed capability whose conversation no longer exists", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["someone-else"]),
      deps({
        transport: "valid",
        conversation: validConversation("deleted-conv"),
      }),
    );

    expect(result).toEqual({
      kind: "unverified",
      reason: "conversation_absent",
    });
  });

  it("reports a bad signature as unverified rather than reading its payload", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({
        transport: "valid",
        conversation: { kind: "invalid", reason: "bad_signature" },
      }),
    );

    expect(result).toEqual({
      kind: "unverified",
      reason: "invalid:bad_signature",
    });
  });

  it("derives a lane principal from a lane capability", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["lane-conv"]),
      deps({
        transport: "valid",
        lane: validLane("exec-1", "context-a", "lane-conv"),
      }),
    );

    expect(result).toEqual({
      kind: "principal",
      principal: {
        kind: "lane",
        executionId: "exec-1",
        contextId: "context-a",
        conversationId: "lane-conv",
      },
    });
  });

  it("prefers the lane capability when a caller somehow presents both", async () => {
    // A lane is minted no conversation capability, so holding both means one of
    // them was carried in from elsewhere. Reading the lane one keeps the
    // narrower principal — a lane can only act on its own execution.
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["lane-conv", "origin-conv"]),
      deps({
        transport: "valid",
        lane: validLane("exec-1", "context-a", "lane-conv"),
        conversation: validConversation("origin-conv"),
      }),
    );

    expect(result).toEqual({
      kind: "principal",
      principal: {
        kind: "lane",
        executionId: "exec-1",
        contextId: "context-a",
        conversationId: "lane-conv",
      },
    });
  });
});

describe("authorizeExecutionMutation", () => {
  it("admits the human UI regardless of which conversation launched the run", () => {
    expect(
      authorizeExecutionMutation({
        principal: { kind: "human_ui" },
        execution: facts({ originConversationId: "someone-elses-conv" }),
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("admits the immutable origin conversation", () => {
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "origin-conv" },
        execution: facts(),
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("refuses a non-origin conversation and names the origin", () => {
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "sibling-conv" },
        execution: facts(),
      }),
    ).toEqual({
      kind: "refused",
      code: "non_origin_principal",
      originConversationId: "origin-conv",
    });
  });

  it("refuses every agent on an unowned run, which has no origin to match", () => {
    // An unowned run predates origin capture or was launched by the human UI.
    // Matching "null === null" would make every agent its origin.
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "any-conv" },
        execution: facts({ originConversationId: null }),
      }),
    ).toEqual({
      kind: "refused",
      code: "non_origin_principal",
      originConversationId: null,
    });
  });

  it("refuses an agent whose origin conversation was deleted", () => {
    // The origin id survives the conversation's deletion, so the run keeps an
    // origin no live caller can be. Classification already refuses the deleted
    // conversation's own capability; this is the second half — nobody inherits
    // the vacancy.
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "successor-conv" },
        execution: facts({ originConversationId: "deleted-origin" }),
      }),
    ).toEqual({
      kind: "refused",
      code: "non_origin_principal",
      originConversationId: "deleted-origin",
    });
  });

  it("admits the execution's current lane", () => {
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "exec-1",
          contextId: "context-a",
          conversationId: "lane-conv",
        },
        execution: facts({
          boundLaneConversationId: (contextId) =>
            contextId === "context-a" ? "lane-conv" : null,
        }),
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("refuses the current lane when the execution's recorded origin was deleted", () => {
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "exec-1",
          contextId: "context-a",
          conversationId: "lane-conv",
        },
        execution: facts({
          originConversationExists: false,
          boundLaneConversationId: () => "lane-conv",
        }),
      }),
    ).toEqual({
      kind: "refused",
      code: "origin_conversation_absent",
      originConversationId: "origin-conv",
    });
  });

  it("refuses a lane whose binding has moved on", () => {
    // A signature proves issuance, not currency: a replaced lane still holds a
    // perfectly valid capability.
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "exec-1",
          contextId: "context-a",
          conversationId: "retired-lane-conv",
        },
        execution: facts({
          boundLaneConversationId: () => "current-lane-conv",
        }),
      }),
    ).toEqual({
      kind: "refused",
      code: "stale_lane_principal",
      originConversationId: "origin-conv",
    });
  });

  it("refuses a lane capability scoped to a different execution", () => {
    expect(
      authorizeExecutionMutation({
        principal: {
          kind: "lane",
          executionId: "other-exec",
          contextId: "context-a",
          conversationId: "lane-conv",
        },
        execution: facts({
          boundLaneConversationId: () => "lane-conv",
        }),
      }),
    ).toEqual({
      kind: "refused",
      code: "stale_lane_principal",
      originConversationId: "origin-conv",
    });
  });
});

describe("authorizeWorkflowLaunch", () => {
  it("admits the human UI", () => {
    expect(authorizeWorkflowLaunch({ kind: "human_ui" })).toEqual({
      kind: "allowed",
    });
  });

  it("admits an ordinary conversation", () => {
    expect(
      authorizeWorkflowLaunch({
        kind: "conversation",
        conversationId: "origin-conv",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("refuses a workflow lane as nesting, whatever the lease says", () => {
    // The lease is a separate question. A lane holding a valid, current
    // capability still must not launch a run from inside a run.
    expect(
      authorizeWorkflowLaunch({
        kind: "lane",
        executionId: "exec-1",
        contextId: "context-a",
        conversationId: "lane-conv",
      }),
    ).toEqual({ kind: "refused", code: "workflow_nesting_refused" });
  });
});
