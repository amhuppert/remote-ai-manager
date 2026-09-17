/** Coordinates trusted agents against session membership and current lane bindings. */
import { describe, expect, it } from "vitest";
import type { ConversationIdentityReading } from "@/lib/agent-gateway/conversation-identity";
import type { LaneIdentityReading } from "@/lib/agent-gateway/lane-identity";
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
  conversation?: ConversationIdentityReading;
  lane?: LaneIdentityReading;
  conversationIds?: readonly string[];
}): WorkflowPrincipalDeps {
  return {
    validateOptionalToken: async () => ({
      kind: overrides.transport ?? "absent",
    }),
    readConversationIdentity: async () =>
      overrides.conversation ?? { kind: "absent" },
    readLaneIdentity: async () => overrides.lane ?? { kind: "absent" },
  };
}

const membership = (ids: readonly string[]) => ({
  sessionName: SESSION,
  conversationIds: ids,
});

const validConversation = (
  conversationId: string,
  sessionName: string = SESSION,
): ConversationIdentityReading => ({
  kind: "valid",
  scope: { sessionName, conversationId },
});

const validLane = (
  executionId: string,
  contextId: string,
  conversationId: string,
): LaneIdentityReading => ({
  kind: "valid",
  scope: { laneKind: "implementer", executionId, contextId, conversationId },
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

  it("derives an agent's conversation principal from the environment identity", async () => {
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

  it("refuses an agent that presents no identity at all", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({ transport: "valid" }),
    );

    expect(result).toEqual({ kind: "unverified", reason: "missing_identity" });
  });

  it("honours a identity presented without an instance token", async () => {
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

  it("honours a lane identity presented without an instance token", async () => {
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

  it("refuses a malformed LANE identity rather than falling back to human authority", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({
        transport: "absent",
        lane: { kind: "invalid", reason: "malformed" },
      }),
    );

    expect(result).toEqual({
      kind: "unverified",
      reason: "lane_invalid:malformed",
    });
  });

  it("refuses a lane identity naming a conversation this session does not have", async () => {
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

  it("refuses a malformed identity even from a token-free caller", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({
        transport: "absent",
        conversation: { kind: "invalid", reason: "malformed" },
      }),
    );

    expect(result).toEqual({
      kind: "unverified",
      reason: "invalid:malformed",
    });
  });

  it("refuses a identity injected for a different session", async () => {
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

  it("refuses a signed identity whose conversation no longer exists", async () => {
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

  it("reports a bad environment identity as unverified rather than reading its payload", async () => {
    const result = await classifyWorkflowRequestPrincipal(
      request(),
      membership(["origin-conv"]),
      deps({
        transport: "valid",
        conversation: { kind: "invalid", reason: "malformed" },
      }),
    );

    expect(result).toEqual({
      kind: "unverified",
      reason: "invalid:malformed",
    });
  });

  it("derives a lane principal from a lane identity", async () => {
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

  it("prefers the lane identity when a caller somehow presents both", async () => {
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

  it("refuses a lane identity scoped to a different execution", () => {
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

describe("authorizeExecutionMutation under any_session_conversation authority", () => {
  it("admits a conversation that did not launch the run", () => {
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "sibling-conv" },
        execution: facts(),
        authority: "any_session_conversation",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("admits a conversation on an unowned run", () => {
    // A run launched from the UI records no origin at all. Under the origin
    // rule that means no agent may act; under membership it means there is
    // simply no origin to compare against.
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "any-conv" },
        execution: facts({ originConversationId: null }),
        authority: "any_session_conversation",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("admits a conversation whose run's recorded origin was deleted", () => {
    // The deleted-origin refusal exists to stop a successor inheriting the
    // vacancy under the origin rule. Membership inherits nothing, so the
    // vacancy is not a refusal here.
    expect(
      authorizeExecutionMutation({
        principal: { kind: "conversation", conversationId: "successor-conv" },
        execution: facts({
          originConversationId: "deleted-origin",
          originConversationExists: false,
        }),
        authority: "any_session_conversation",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("admits the current lane of a run whose recorded origin was deleted", () => {
    // A lane's authority never came from the origin conversation; the deleted-
    // origin gate refused it only as collateral of the rule above.
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
        authority: "any_session_conversation",
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("still refuses a lane whose binding has moved on", () => {
    // Membership widens WHICH conversations may act, not whether a replaced
    // lane may keep acting on the context it no longer drives.
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
        authority: "any_session_conversation",
      }),
    ).toEqual({
      kind: "refused",
      code: "stale_lane_principal",
      originConversationId: "origin-conv",
    });
  });

  it("still refuses a lane identity scoped to a different execution", () => {
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
        authority: "any_session_conversation",
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
