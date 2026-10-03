import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createPendingIntentsRepo } from "@/lib/state-store/pending-intents-repo";
import { createIntentLedger, type IntentLedger } from "./ledger";

const at = "2026-10-03T10:00:00.000Z";
const contextOwner = { kind: "context" as const, id: "ctx-1" };
const runOwner = { kind: "run" as const, id: "run-1" };
let fixture: PersistenceFixture;
let ledger: IntentLedger;

beforeEach(() => {
  fixture = createPersistenceFixture();
  ledger = createIntentLedger(createPendingIntentsRepo(fixture.db));
});
afterEach(() => fixture.close());

describe("intent ledger", () => {
  it("records an intent with its exact prepared request and permit", () => {
    const intent = ledger.record({
      requester: contextOwner,
      executor: "conversation",
      cause: "work:ctx-1:1",
      permit: { controllerId: "context:ctx-1", generation: 2 },
      request: { kind: "work", message: "Implement the task" },
      recordedAt: at,
    });

    expect(ledger.pending(contextOwner)).toEqual([intent]);
    expect(intent).toMatchObject({
      requester: contextOwner,
      executor: "conversation",
      cause: "work:ctx-1:1",
      permit: { controllerId: "context:ctx-1", generation: 2 },
      request: { kind: "work", message: "Implement the task" },
    });
  });

  it("returns the existing intent when the same executor and cause are recorded again", () => {
    const first = ledger.record({
      requester: contextOwner,
      executor: "workspace",
      cause: "capture:ctx-1:1",
      permit: null,
      request: { kind: "capture" },
      recordedAt: at,
    });
    const second = ledger.record({
      requester: contextOwner,
      executor: "workspace",
      cause: "capture:ctx-1:1",
      permit: null,
      request: { kind: "capture", changed: true },
      recordedAt: "2026-10-03T10:05:00.000Z",
    });

    expect(second).toEqual(first);
    expect(ledger.pending(contextOwner)).toHaveLength(1);
  });

  it("lists only the owner's intents, in recording order, until each is closed", () => {
    const work = ledger.record({
      requester: contextOwner,
      executor: "conversation",
      cause: "work:ctx-1:1",
      permit: null,
      request: {},
      recordedAt: at,
    });
    const review = ledger.record({
      requester: contextOwner,
      executor: "conversation",
      cause: "review:ctx-1:1:seat-a",
      permit: null,
      request: {},
      recordedAt: "2026-10-03T10:01:00.000Z",
    });
    ledger.record({
      requester: runOwner,
      executor: "context",
      cause: "start:run-1:api:0",
      permit: null,
      request: {},
      recordedAt: at,
    });

    expect(ledger.pending(contextOwner).map((i) => i.id)).toEqual([
      work.id,
      review.id,
    ]);

    ledger.close(work.id);
    expect(ledger.pending(contextOwner).map((i) => i.id)).toEqual([review.id]);
  });

  it("enumerates every owner that still has pending intents", () => {
    const only = ledger.record({
      requester: contextOwner,
      executor: "requests",
      cause: "question:q-1",
      permit: null,
      request: {},
      recordedAt: at,
    });
    ledger.record({
      requester: runOwner,
      executor: "context",
      cause: "start:run-1:api:0",
      permit: null,
      request: {},
      recordedAt: at,
    });

    expect(ledger.owners()).toEqual(
      expect.arrayContaining([contextOwner, runOwner]),
    );

    ledger.close(only.id);
    expect(ledger.owners()).toEqual([runOwner]);
  });
});
