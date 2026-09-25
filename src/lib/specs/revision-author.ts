import { z } from "zod";

import {
  agentActorProvenanceSchema,
  type AgentActorProvenance,
  type SpecEventRow,
} from "./schemas";

/**
 * The events an author leaves on a draft: content writes and review requests.
 * Review acts are absent on purpose — a human's comment is not authorship.
 */
const AUTHORING_EVENT_TYPES = new Set([
  "spec-changed",
  "spec-revision-changed",
]);

const revisionScopedPayloadSchema = z.object({
  revisionId: z.string().min(1),
});

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The agent conversation that most recently wrote or proposed `revisionId`,
 * or null when no agent with a conversation did. Review feedback goes here: a
 * draft is reviewed while its author keeps working on it, so the author is
 * whoever last touched it rather than whoever first asked for review.
 */
export function revisionAuthor(
  events: readonly SpecEventRow[],
  revisionId: string,
): AgentActorProvenance | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || !AUTHORING_EVENT_TYPES.has(event.event_type)) {
      continue;
    }
    const payload = revisionScopedPayloadSchema.safeParse(
      parseJson(event.payload_json),
    );
    if (!payload.success || payload.data.revisionId !== revisionId) continue;
    const actor = agentActorProvenanceSchema.safeParse(
      parseJson(event.actor_json),
    );
    if (actor.success) return actor.data;
  }
  return null;
}
