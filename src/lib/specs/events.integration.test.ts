import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { specChangedEventSchema, type SSEEvent } from "@/lib/api/sse-events";
import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { parseSseEventData, stampSseEnvelope } from "@/lib/events/sse-envelope";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import { createSpecEventsPublisher } from "./events";

const SPEC_ID = "spec-event-pair";
const PROJECT_PATH = "/repos/spec-event-pair";
const OCCURRED_AT = "2026-07-18T14:30:00.000Z";

let db: Db;

function seedSpec(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    "event-pair",
    "Before mutation",
    '{"preset":"contract-bearing"}',
    null,
    null,
    OCCURRED_AT,
    OCCURRED_AT,
  );
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedSpec();
  _resetPublicationForTesting();
});

afterEach(() => {
  _resetPublicationForTesting();
  db.close();
});

describe("spec event mutation pairing", () => {
  it("commits the durable event with the mutation before publishing an envelope-valid SSE event", async () => {
    const repo = createSpecEventsRepo(db);
    const writeQueue = createWriteQueue();
    const published: SSEEvent[] = [];
    let observedCommittedMutation = false;
    let observedDurableEvent = false;

    setPublicationBroadcastForTesting((event) => {
      published.push(event);
      expect(
        db.prepare("SELECT name FROM specs WHERE id = ?").get(SPEC_ID),
      ).toEqual({ name: "After mutation" });
      observedCommittedMutation = true;
      observedDurableEvent = repo.findBySpecId(SPEC_ID).length === 1;
    });

    const publisher = createSpecEventsPublisher({
      appendInTransaction: repo.appendInTransaction,
    });
    const prepared = await writeQueue.withWriteQueue(
      "specs.test.event-pair",
      async () => {
        const mutate = db.transaction(() => {
          db.prepare("UPDATE specs SET name = ? WHERE id = ?").run(
            "After mutation",
            SPEC_ID,
          );
          return publisher.appendInTransaction({
            actor: {
              kind: "agent",
              conversationId: "conversation-1",
            },
            durableEventType: "spec-changed",
            durablePayload: {
              kind: "draft-element-updated",
              revisionId: "revision-1",
              elementId: "requirement-1",
            },
            sseEvent: {
              type: "spec-changed",
              kind: "content-changed",
              projectPath: PROJECT_PATH,
              specId: SPEC_ID,
              specSlug: "event-pair",
              occurredAt: OCCURRED_AT,
              revisionId: "revision-1",
              elementIds: ["requirement-1"],
            },
          });
        });

        return mutate();
      },
    );

    expect(published).toEqual([]);
    publisher.publishAfterCommit(prepared);

    expect(observedCommittedMutation).toBe(true);
    expect(observedDurableEvent).toBe(true);
    expect(repo.findBySpecId(SPEC_ID)).toEqual([
      expect.objectContaining({
        spec_id: SPEC_ID,
        occurred_at: OCCURRED_AT,
        event_type: "spec-changed",
      }),
    ]);
    expect(JSON.parse(repo.findBySpecId(SPEC_ID)[0]!.payload_json)).toEqual({
      elementId: "requirement-1",
      kind: "draft-element-updated",
      revisionId: "revision-1",
    });
    expect(published).toHaveLength(1);

    const stamped = stampSseEnvelope(published[0]!, 1_700_000_000_000);
    const bareEvent = parseSseEventData(JSON.stringify(stamped));
    expect(specChangedEventSchema.safeParse(bareEvent)).toEqual(
      expect.objectContaining({ success: true }),
    );
  });
});
