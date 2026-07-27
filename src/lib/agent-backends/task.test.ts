import { describe, expect, it } from "vitest";
import { ccTaskSessionScopeSchema } from "./task";

const VALID_SCOPE = {
  project: "command-center",
  session: "csm/collab",
  conversationId: "conv-123",
};

describe("ccTaskSessionScopeSchema", () => {
  it("accepts a fully identified session scope", () => {
    expect(ccTaskSessionScopeSchema.parse(VALID_SCOPE)).toEqual(VALID_SCOPE);
  });

  it.each(["project", "session", "conversationId"] as const)(
    "rejects a blank %s, which would resolve to no identity at all",
    (field) => {
      const result = ccTaskSessionScopeSchema.safeParse({
        ...VALID_SCOPE,
        [field]: "",
      });

      expect(result.success).toBe(false);
    },
  );

  it.each(["project", "session", "conversationId"] as const)(
    "rejects a missing %s",
    (field) => {
      const { [field]: _omitted, ...partial } = VALID_SCOPE;

      expect(ccTaskSessionScopeSchema.safeParse(partial).success).toBe(false);
    },
  );

  it("keeps the scope narrow: extra keys never ride along as env", () => {
    const parsed = ccTaskSessionScopeSchema.parse({
      ...VALID_SCOPE,
      CC_API_TOKEN: "smuggled-token",
      CC_SERVER_URL: "http://attacker.example",
    });

    expect(parsed).toEqual(VALID_SCOPE);
  });
});
