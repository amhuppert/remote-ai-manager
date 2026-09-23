import type { z } from "zod";
import { conversationIdentitySchema } from "./schemas";

export const CONVERSATION_IDENTITY_HEADER = "x-cc-conversation-identity";
export const CONVERSATION_IDENTITY_ENV_VAR = "CC_CONVERSATION";

export type ConversationIdentity = z.infer<typeof conversationIdentitySchema>;
export type ConversationIdentityReading =
  | { kind: "valid"; scope: ConversationIdentity }
  | { kind: "absent" }
  | { kind: "invalid"; reason: "malformed" };

/** Current session membership is checked by the request principal classifier. */
export function encodeConversationIdentity(
  scope: ConversationIdentity,
): string {
  // HTTP headers cannot carry arbitrary Unicode; JSON escapes preserve the
  // original session name for the existing decoder and membership check.
  return JSON.stringify(scope).replace(
    /[^\x20-\x7e]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function readConversationIdentity(
  raw: string | null | undefined,
): ConversationIdentityReading {
  if (!raw) return { kind: "absent" };
  try {
    const parsed = conversationIdentitySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { kind: "valid", scope: parsed.data };
  } catch {
    // An unreadable agent identity must not fall through to the human UI.
  }
  return { kind: "invalid", reason: "malformed" };
}
