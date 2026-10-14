import { describe, expect, it } from "vitest";
import { resolveCliPrincipalIdentity } from "./transport";

describe("environment caller principal", () => {
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
  it("does not turn a routing-only conversation into a caller", () => {
    expect(
      resolveCliPrincipalIdentity({
        CC_SESSION: "session",
        CC_CONVERSATION_ID: "parent",
      }),
    ).toEqual({});
  });
});
