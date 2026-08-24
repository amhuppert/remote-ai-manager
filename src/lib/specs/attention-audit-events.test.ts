import { describe, expect, it } from "vitest";

import type { SpecEventRow } from "./schemas";
import { projectAttentionAuditEvents } from "./attention-audit-events";

const NOW = "2026-08-23T12:00:00.000Z";

describe("projectAttentionAuditEvents", () => {
  it("validates durable record and citation events while preserving unknown actors", () => {
    const events: SpecEventRow[] = [
      {
        id: 1,
        spec_id: "spec-1",
        occurred_at: NOW,
        event_type: "spec-review-record-mutated",
        actor_json: JSON.stringify({ kind: "system" }),
        payload_json: JSON.stringify({
          schemaVersion: 1,
          recordKind: "question",
          recordId: "question-1",
          recordNumber: 1,
          attentionId: "question-1",
          operation: "imported",
          active: false,
          before: null,
          after: {
            kind: "question",
            recordId: "question-1",
            number: 1,
            recordVersion: 1,
            text: "Which retention window applies?",
            elementId: null,
            provenance: {
              kind: "agent",
              conversationId: "conversation-1",
            },
            status: "answered",
            answer: "Thirty days.",
            answeredAt: NOW,
            withdrawnAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        }),
      },
      {
        id: 2,
        spec_id: "spec-1",
        occurred_at: NOW,
        event_type: "spec-assumption-citations-mutated",
        actor_json: JSON.stringify({ kind: "human" }),
        payload_json: JSON.stringify({
          schemaVersion: 1,
          revisionId: "revision-1",
          beforeCitationVersion: 1,
          afterCitationVersion: 2,
          beforeCitationHash: "1".repeat(64),
          afterCitationHash: "2".repeat(64),
          added: [
            {
              elementId: "requirement-1",
              assumptionId: "assumption-1",
              snapshot: {
                schemaVersion: 1,
                captureKind: "native",
                capturedAt: NOW,
                assumptionId: "assumption-1",
                number: 1,
                recordVersion: 1,
                text: "Retention defaults to 30 days.",
                elementId: "requirement-1",
                proposedBy: {
                  kind: "agent",
                  conversationId: "conversation-1",
                },
                disposition: "confirmed",
                disposedAt: NOW,
                withdrawnAt: null,
                supersedesAssumptionId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            },
          ],
          removed: [],
          refreshed: [],
        }),
      },
      {
        id: 3,
        spec_id: "spec-1",
        occurred_at: NOW,
        event_type: "spec-changed",
        actor_json: JSON.stringify({ kind: "human" }),
        payload_json: "{}",
      },
      {
        id: 4,
        spec_id: "spec-1",
        occurred_at: NOW,
        event_type: "spec-review-record-mutated",
        actor_json: JSON.stringify({ kind: "human" }),
        payload_json: "{}",
      },
    ];

    expect(projectAttentionAuditEvents(events)).toEqual([
      {
        kind: "record",
        eventId: 1,
        occurredAt: NOW,
        actor: null,
        payload: JSON.parse(events[0]?.payload_json ?? "{}"),
      },
      {
        kind: "citations",
        eventId: 2,
        occurredAt: NOW,
        actor: { kind: "human" },
        payload: JSON.parse(events[1]?.payload_json ?? "{}"),
      },
    ]);
  });
});
