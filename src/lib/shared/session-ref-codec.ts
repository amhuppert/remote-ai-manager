import { agentSessionRefSchema, type AgentSessionRef } from "./schemas";

/** Persisted refs use the same canonical shape as the backend-neutral runtime. */
export const persistedAgentSessionRefSchema = agentSessionRefSchema;

/** Select canonical fields so storage never mirrors provider-specific handles. */
export function encodeAgentSessionRefForStorage(
  ref: AgentSessionRef,
): AgentSessionRef {
  return { backend: ref.backend, ref: ref.ref };
}
