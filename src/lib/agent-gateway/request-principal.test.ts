/** Coordinates trusted agents against session membership and current lane bindings. */
import { describe, expect, it } from "vitest";
import type { ConversationIdentityReading } from "./conversation-identity";
import type { LaneIdentityReading } from "./lane-identity";
import type { OptionalTokenValidation } from "./token";
import {
  classifyWorkflowRequestPrincipal,
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
