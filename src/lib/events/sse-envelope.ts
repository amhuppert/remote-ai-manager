/**
 * The SSE transport envelope, owned end-to-end by this module.
 *
 * `broadcast()` stamps transport metadata (`_sentAt`, epoch ms) into every
 * frame so clients can measure transport latency. Domain event schemas must
 * never see that metadata: several are `.strict()` (project-scope conversation
 * events, agent-capabilities, MCP live-update events), and an unstripped stamp
 * makes their `safeParse` fail — the event is then silently dropped and the UI
 * goes stale for the whole turn. Keeping the stamp and strip sides in one
 * module is what stops them drifting apart.
 *
 * This module is dependency-free so it is safe to import from client
 * components and server broadcast code alike.
 */

/** Merge the transport stamp into an outgoing event payload. */
export function stampSseEnvelope(
  event: object,
  sentAt: number,
): Record<string, unknown> {
  return { ...event, _sentAt: sentAt };
}

/**
 * Parse an incoming SSE frame's `data` string and strip the transport
 * envelope, returning the bare domain event for schema parsing. Non-object
 * payloads pass through untouched. Malformed JSON throws, matching
 * `JSON.parse` semantics so callers keep their existing error handling.
 */
export function parseSseEventData(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }
  const { _sentAt, ...event } = parsed as Record<string, unknown>;
  void _sentAt;
  return event;
}

/**
 * Read the transport stamp from a frame's `data` string without touching the
 * domain payload. Returns null when absent or unreadable — transport timing
 * is best-effort instrumentation, never a hard dependency.
 */
export function readSseEnvelopeSentAt(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "_sentAt" in parsed) {
      const value = (parsed as { _sentAt: unknown })._sentAt;
      return typeof value === "number" ? value : null;
    }
  } catch {
    // best-effort
  }
  return null;
}
