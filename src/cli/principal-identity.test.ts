import { describe, expect, it } from "vitest";
import { resolveCliPrincipalIdentity } from "./shared";

describe("environment workflow principal", () => {
  it("uses the injected caller identity rather than the routing conversation", () => {
    expect(
      resolveCliPrincipalIdentity({
        CC_SESSION: "session",
        CC_CONVERSATION: "caller",
        CC_CONVERSATION_ID: "routing-target",
      }),
    ).toEqual({
      conversation: JSON.stringify({
        sessionName: "session",
        conversationId: "caller",
      }),
    });
  });
  it("attaches the injected lane scope without a signing key", () => {
    expect(
      resolveCliPrincipalIdentity({
        CC_CONVERSATION_ID: "lane-conversation",
        CC_WORKFLOW_EXECUTION_ID: "execution",
        CC_WORKFLOW_CONTEXT_ID: "context",
      }),
    ).toEqual({
      lane: JSON.stringify({
        laneKind: "implementer",
        executionId: "execution",
        contextId: "context",
        conversationId: "lane-conversation",
      }),
    });
  });
  it("does not turn a routing-only conversation into a workflow caller", () => {
    expect(
      resolveCliPrincipalIdentity({
        CC_SESSION: "session",
        CC_CONVERSATION_ID: "parent",
      }),
    ).toEqual({});
  });
});
