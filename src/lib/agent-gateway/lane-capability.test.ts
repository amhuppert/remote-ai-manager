import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LANE_CAPABILITY_PREFIX,
  mintLaneCapability,
  verifyLaneCapability,
  type LaneCapabilityScope,
} from "./lane-capability";

const SECRET = "0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210";

const SCOPE: LaneCapabilityScope = {
  laneKind: "implementer",
  executionId: "execution-1",
  contextId: "context-plan",
  conversationId: "conversation-7",
};

/**
 * Sign an arbitrary payload the way the module does. Used only to forge tokens
 * the typed mint API cannot express (an unknown lane kind), so the refusal
 * under test is the CLAIM being rejected rather than a signature mismatch.
 */
function signRawPayload(payload: unknown, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(`${LANE_CAPABILITY_PREFIX}.${encoded}`)
    .digest("base64url");
  return `${LANE_CAPABILITY_PREFIX}.${encoded}.${signature}`;
}

describe("lane capability", () => {
  it("round-trips the full scope under the signing secret", () => {
    const token = mintLaneCapability(SCOPE, SECRET, 1_700_000_000_000);

    expect(verifyLaneCapability(token, SECRET)).toEqual({
      kind: "valid",
      scope: SCOPE,
      issuedAt: 1_700_000_000_000,
    });
  });

  it("refuses a token signed with a different secret", () => {
    const token = mintLaneCapability(SCOPE, OTHER_SECRET, 1);

    expect(verifyLaneCapability(token, SECRET)).toEqual({
      kind: "invalid",
      reason: "bad_signature",
    });
  });

  it("refuses a token whose scope was edited after signing", () => {
    const token = mintLaneCapability(SCOPE, SECRET, 1);
    const [prefix, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        k: "implementer",
        e: "execution-1",
        c: "context-other",
        v: "conversation-7",
        i: 1,
      }),
      "utf-8",
    ).toString("base64url");

    expect(
      verifyLaneCapability(`${prefix}.${forgedPayload}.${signature}`, SECRET),
    ).toEqual({ kind: "invalid", reason: "bad_signature" });
  });

  it("refuses a malformed or absent token without throwing", () => {
    expect(verifyLaneCapability(null, SECRET)).toEqual({ kind: "absent" });
    expect(verifyLaneCapability("", SECRET)).toEqual({ kind: "absent" });
    expect(verifyLaneCapability("not-a-capability", SECRET)).toEqual({
      kind: "invalid",
      reason: "malformed",
    });
    expect(verifyLaneCapability("v9.aaa.bbb", SECRET)).toEqual({
      kind: "invalid",
      reason: "malformed",
    });
  });

  it("refuses a correctly signed token that claims a non-implementer lane", () => {
    const forged = signRawPayload(
      {
        k: "validator",
        e: "execution-1",
        c: "context-plan",
        v: "conversation-7",
        i: 1,
      },
      SECRET,
    );

    expect(verifyLaneCapability(forged, SECRET)).toEqual({
      kind: "invalid",
      reason: "unsupported_lane_kind",
    });
  });

  it("refuses a correctly signed token whose scope fields are missing", () => {
    const forged = signRawPayload(
      { k: "implementer", e: "execution-1" },
      SECRET,
    );

    expect(verifyLaneCapability(forged, SECRET)).toEqual({
      kind: "invalid",
      reason: "malformed",
    });
  });

  it("refuses verification when there is no signing secret", () => {
    const token = mintLaneCapability(SCOPE, SECRET, 1);

    expect(verifyLaneCapability(token, null)).toEqual({
      kind: "invalid",
      reason: "no_secret",
    });
  });
});
