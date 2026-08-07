/**
 * The signed graph-workflow lane capability (D4 R7).
 *
 * The instance API token authenticates "a cctl on this machine"; it carries no
 * per-caller identity, so it cannot answer the question runtime expansion has
 * to ask: is THIS request coming from the implementer lane currently bound to
 * THIS execution context? The capability is that missing claim — minted
 * server-side at lane dispatch, injected into the lane's environment, and
 * presented back on the expansion request.
 *
 * The claim is deliberately narrow. It proves the caller was handed lane
 * credentials for one (execution, context, conversation) triple; it does NOT
 * prove that binding is still current. Freshness is the route's job: the
 * expansion service re-reads the context's bound implementer conversation
 * inside the serialized mutation and refuses when it no longer matches, so a
 * capability that outlives its lane is inert rather than trusted.
 *
 * Format: `cclc1.<base64url(payload)>.<base64url(HMAC-SHA256(prefix.payload))>`
 * with the instance token as the key. Signed rather than random-and-stored so
 * verification needs no extra persisted state and a restart with the same token
 * file keeps in-flight lanes working.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const LANE_CAPABILITY_PREFIX = "cclc1";

/** The env var carrying the capability into a lane conversation's agent. */
export const LANE_CAPABILITY_ENV_VAR = "CC_WORKFLOW_LANE_CAPABILITY";

/** The request header the lane presents its capability on. */
export const LANE_CAPABILITY_HEADER = "x-cc-lane-capability";

/**
 * The only lane kind that may hold a capability today. Modelled as a union so a
 * second kind is a deliberate widening here, and so a forged token claiming an
 * unknown kind is refused rather than silently accepted as an implementer.
 */
export type LaneCapabilityKind = "implementer";

export interface LaneCapabilityScope {
  laneKind: LaneCapabilityKind;
  executionId: string;
  contextId: string;
  conversationId: string;
}

export type LaneCapabilityVerification =
  | { kind: "valid"; scope: LaneCapabilityScope; issuedAt: number }
  | { kind: "absent" }
  | {
      kind: "invalid";
      reason:
        | "malformed"
        | "bad_signature"
        | "unsupported_lane_kind"
        | "no_secret";
    };

/**
 * Short keys keep the token compact enough to sit in an environment variable
 * beside the rest of the CC contract. They are internal to this module — every
 * consumer reads the named {@link LaneCapabilityScope}.
 */
interface LaneCapabilityPayload {
  k: string;
  e: string;
  c: string;
  v: string;
  i: number;
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${LANE_CAPABILITY_PREFIX}.${encodedPayload}`)
    .digest("base64url");
}

export function mintLaneCapability(
  scope: LaneCapabilityScope,
  secret: string,
  issuedAt: number,
): string {
  const payload: LaneCapabilityPayload = {
    k: scope.laneKind,
    e: scope.executionId,
    c: scope.contextId,
    v: scope.conversationId,
    i: issuedAt,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString(
    "base64url",
  );
  return `${LANE_CAPABILITY_PREFIX}.${encoded}.${sign(encoded, secret)}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodePayload(encoded: string): LaneCapabilityPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  // Own-property reads only: an inherited `e`/`c`/`v` is not signed content, and
  // treating one as a scope claim is the same class of defect as routing on a
  // payload nobody produced.
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) record[key] = value;
  if (
    !isNonEmptyString(record["k"]) ||
    !isNonEmptyString(record["e"]) ||
    !isNonEmptyString(record["c"]) ||
    !isNonEmptyString(record["v"]) ||
    typeof record["i"] !== "number"
  ) {
    return null;
  }
  return {
    k: record["k"],
    e: record["e"],
    c: record["c"],
    v: record["v"],
    i: record["i"],
  };
}

function signaturesMatch(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf-8");
  const providedBytes = Buffer.from(provided, "utf-8");
  if (expectedBytes.length !== providedBytes.length) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}

/**
 * Classify a presented capability. Signature is checked BEFORE the claim is
 * read as scope, so an unsigned payload can never influence a refusal reason
 * (or anything else) beyond "bad signature".
 */
export function verifyLaneCapability(
  token: string | null | undefined,
  secret: string | null,
): LaneCapabilityVerification {
  if (token === null || token === undefined || token === "") {
    return { kind: "absent" };
  }
  if (secret === null || secret === "") {
    return { kind: "invalid", reason: "no_secret" };
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== LANE_CAPABILITY_PREFIX) {
    return { kind: "invalid", reason: "malformed" };
  }
  const encoded = parts[1] ?? "";
  const signature = parts[2] ?? "";
  if (!signaturesMatch(sign(encoded, secret), signature)) {
    return { kind: "invalid", reason: "bad_signature" };
  }

  const payload = decodePayload(encoded);
  if (payload === null) {
    return { kind: "invalid", reason: "malformed" };
  }
  if (payload.k !== "implementer") {
    return { kind: "invalid", reason: "unsupported_lane_kind" };
  }

  return {
    kind: "valid",
    scope: {
      laneKind: "implementer",
      executionId: payload.e,
      contextId: payload.c,
      conversationId: payload.v,
    },
    issuedAt: payload.i,
  };
}
