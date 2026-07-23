import {
  specSseEventSchema,
  type SpecSseEvent,
  type SSEEvent,
} from "@/lib/api/sse-events";
import {
  publishEvent,
  publishEventBestEffort,
  type PublishOutcome,
} from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import type {
  SpecEventRow,
  SpecEventType,
  ActorProvenance,
} from "@/lib/specs/schemas";
import type { SpecEventInput } from "@/lib/state-store/spec-events-repo";
import { stableStringify } from "@/lib/state-store/serialization";

const logger = createLogger("specs.events");

export interface SpecEventsPublisherDeps {
  appendInTransaction(event: SpecEventInput): SpecEventRow;
  publish?(event: SSEEvent): PublishOutcome;
}

export interface AppendSpecEventInput {
  actor: ActorProvenance | { kind: "system" };
  durableEventType: SpecEventType;
  durablePayload: unknown;
  sseEvent: SpecSseEvent;
}

export interface PreparedSpecEventPublication {
  durableEvent: SpecEventRow;
  sseEvent: SpecSseEvent;
}

export interface AppendDurableSpecEventInput {
  specId: string;
  occurredAt: string;
  actor: ActorProvenance | { kind: "system" };
  durableEventType: SpecEventType;
  durablePayload: unknown;
}

export interface SpecEventsPublisher {
  appendInTransaction(
    input: AppendSpecEventInput,
  ): PreparedSpecEventPublication;
  appendDurableInTransaction(input: AppendDurableSpecEventInput): SpecEventRow;
  publishAfterCommit(prepared: PreparedSpecEventPublication): void;
}

export function createSpecEventsPublisher(
  deps: SpecEventsPublisherDeps,
): SpecEventsPublisher {
  const injectedPublish = deps.publish;

  function appendInTransaction(
    input: AppendSpecEventInput,
  ): PreparedSpecEventPublication {
    const sseEvent = specSseEventSchema.parse(input.sseEvent);
    const durableEvent = deps.appendInTransaction({
      spec_id: sseEvent.specId,
      occurred_at: sseEvent.occurredAt,
      event_type: input.durableEventType,
      actor_json: stableStringify(input.actor),
      payload_json: stableStringify(input.durablePayload),
    });

    return { durableEvent, sseEvent };
  }

  function publishAfterCommit(prepared: PreparedSpecEventPublication): void {
    publishEventBestEffort({
      publish:
        injectedPublish === undefined
          ? publishEvent
          : (event) => injectedPublish(event),
      logger,
      failureEvent: "specs.events.publish_failed",
      context: {
        durableEventId: prepared.durableEvent.id,
        eventType: prepared.sseEvent.type,
        specId: prepared.sseEvent.specId,
      },
      build: () => specSseEventSchema.parse(prepared.sseEvent),
    });
  }

  function appendDurableInTransaction(
    input: AppendDurableSpecEventInput,
  ): SpecEventRow {
    return deps.appendInTransaction({
      spec_id: input.specId,
      occurred_at: input.occurredAt,
      event_type: input.durableEventType,
      actor_json: stableStringify(input.actor),
      payload_json: stableStringify(input.durablePayload),
    });
  }

  return {
    appendInTransaction,
    appendDurableInTransaction,
    publishAfterCommit,
  };
}
