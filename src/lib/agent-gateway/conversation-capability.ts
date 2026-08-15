/**
 * The signed conversation capability (D7 R9.4, decision D11).
 *
 * A launch has to know WHICH conversation is calling, and the bare caller
 * header cannot answer that: it is a claim, and confirming the claimed id
 * belongs to the session only proves the conversation exists — a sibling
 * conversation, a lane, or a copied id passes that check unchanged. This
 * capability is the missing half: the principal is derived from a signature, so
 * naming another conversation requires forging one.
 *
 * The signing key is deliberately NOT the instance token. `CC_API_TOKEN` is
 * exported into every agent environment, so an instance-token HMAC is
 * caller-computable and proves nothing — signing with a secret the verifier
 * shares with every caller verifies nothing. The key lives in its own file
 * beside the api token and is never exported to any environment.
 *
 * Format mirrors the lane capability: `cccc1.<base64url(payload)>.<base64url(
 * HMAC-SHA256(prefix.payload))>`. Signed rather than random-and-stored so
 * verification needs no extra persisted state and a restart with the same key
 * file keeps in-flight conversations working.
 *
 * Minting and verification are both defined against this format; WHICH runtimes
 * are minted one is a policy the conversation-spawn actor owns, and it is an
 * allowlist decided at spawn — only a declared ordinary session conversation.
 * A caller holding none verifies as `absent` and its launch records no owner,
 * which the launch routes read as "no verified principal" rather than as a
 * claim to trust.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const CONVERSATION_CAPABILITY_PREFIX = "cccc1";

/** The env var carrying the capability into a session conversation's agent. */
export const CONVERSATION_CAPABILITY_ENV_VAR = "CC_CONVERSATION_CAPABILITY";

/** The request header a conversation presents its capability on. */
export const CONVERSATION_CAPABILITY_HEADER = "x-cc-conversation-capability";

/**
 * What a valid capability proves: this caller was handed credentials for one
 * (session, conversation) pair. The session is signed too, so a capability
 * minted for one session cannot be replayed against another.
 */
export interface ConversationCapabilityScope {
  sessionName: string;
  conversationId: string;
}

export type ConversationCapabilityVerification =
  | { kind: "valid"; scope: ConversationCapabilityScope; issuedAt: number }
  | { kind: "absent" }
  | { kind: "invalid"; reason: "malformed" | "bad_signature" | "no_secret" };

/**
 * Short keys keep the token compact enough to sit in an environment variable
 * beside the rest of the CC contract. Internal to this module — every consumer
 * reads the named {@link ConversationCapabilityScope}.
 */
interface ConversationCapabilityPayload {
  s: string;
  v: string;
  i: number;
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${CONVERSATION_CAPABILITY_PREFIX}.${encodedPayload}`)
    .digest("base64url");
}

export function mintConversationCapability(
  scope: ConversationCapabilityScope,
  secret: string,
  issuedAt: number,
): string {
  const payload: ConversationCapabilityPayload = {
    s: scope.sessionName,
    v: scope.conversationId,
    i: issuedAt,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString(
    "base64url",
  );
  return `${CONVERSATION_CAPABILITY_PREFIX}.${encoded}.${sign(encoded, secret)}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodePayload(encoded: string): ConversationCapabilityPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  // Own-property reads only: an inherited `s`/`v` is not signed content, and
  // treating one as a scope claim is the same class of defect as deriving a
  // principal from a payload nobody produced.
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) record[key] = value;
  if (
    !isNonEmptyString(record["s"]) ||
    !isNonEmptyString(record["v"]) ||
    typeof record["i"] !== "number"
  ) {
    return null;
  }
  return { s: record["s"], v: record["v"], i: record["i"] };
}

function signaturesMatch(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf-8");
  const providedBytes = Buffer.from(provided, "utf-8");
  if (expectedBytes.length !== providedBytes.length) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}

/**
 * Classify a presented capability. The signature is checked BEFORE the claim is
 * read as scope, so an unsigned payload can never influence anything beyond
 * "bad signature" — in particular it can never become a principal.
 */
export function verifyConversationCapability(
  token: string | null | undefined,
  secret: string | null,
): ConversationCapabilityVerification {
  if (token === null || token === undefined || token === "") {
    return { kind: "absent" };
  }
  if (secret === null || secret === "") {
    return { kind: "invalid", reason: "no_secret" };
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CONVERSATION_CAPABILITY_PREFIX) {
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

  return {
    kind: "valid",
    scope: { sessionName: payload.s, conversationId: payload.v },
    issuedAt: payload.i,
  };
}
