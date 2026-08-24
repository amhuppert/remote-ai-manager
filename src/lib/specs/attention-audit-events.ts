import { createLogger } from "@/lib/logging";
import {
  actorProvenanceSchema,
  specAssumptionCitationsMutatedEventPayloadSchema,
  specReviewRecordMutatedEventPayloadSchema,
} from "./schemas";
import type { SpecEventRow } from "./schemas";
import type { SpecAttentionAuditEventView } from "./view-schemas";

const logger = createLogger("specs.attention-audit-events");

export function projectAttentionAuditEvents(
  events: readonly SpecEventRow[],
): SpecAttentionAuditEventView[] {
  const projected: SpecAttentionAuditEventView[] = [];
  for (const event of events) {
    if (
      event.event_type !== "spec-review-record-mutated" &&
      event.event_type !== "spec-assumption-citations-mutated"
    ) {
      continue;
    }

    const payload = parseJson(event.payload_json);
    const actor = actorProvenanceSchema.safeParse(parseJson(event.actor_json));
    if (!actor.success) {
      logger.warn("specs.attention_audit.actor_unreadable", {
        eventId: event.id,
        eventType: event.event_type,
        specId: event.spec_id,
        issueCount: actor.error.issues.length,
      });
    }

    if (event.event_type === "spec-review-record-mutated") {
      const parsed =
        specReviewRecordMutatedEventPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn("specs.attention_audit.payload_unreadable", {
          eventId: event.id,
          eventType: event.event_type,
          specId: event.spec_id,
          issueCount: parsed.error.issues.length,
        });
        continue;
      }
      projected.push({
        kind: "record",
        eventId: event.id,
        occurredAt: event.occurred_at,
        actor: actor.success ? actor.data : null,
        payload: parsed.data,
      });
      continue;
    }

    const parsed =
      specAssumptionCitationsMutatedEventPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn("specs.attention_audit.payload_unreadable", {
        eventId: event.id,
        eventType: event.event_type,
        specId: event.spec_id,
        issueCount: parsed.error.issues.length,
      });
      continue;
    }
    projected.push({
      kind: "citations",
      eventId: event.id,
      occurredAt: event.occurred_at,
      actor: actor.success ? actor.data : null,
      payload: parsed.data,
    });
  }
  return projected;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
