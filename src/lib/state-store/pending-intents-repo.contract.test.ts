import { afterEach, describe, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { pendingIntentSchema } from "@/lib/intents/schemas";
import { createPendingIntentsRepo } from "./pending-intents-repo";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

describe("pending intents repository", () => {
  it("round-trips a controlled intent with a structured request", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createPendingIntentsRepo(db);

    await assertRoundTripDurability({
      label: "pending intent",
      schema: pendingIntentSchema,
      buildMaximalFixture: () => ({
        id: "intent-1",
        requester: { kind: "context" as const, id: "ctx-1" },
        executor: "workspace" as const,
        cause: "accept:ctx-1:cand-2",
        permit: { controllerId: "context:ctx-1", generation: 4 },
        request: { kind: "accept", candidateId: "cand-2", paths: ["a", "b"] },
        recordedAt: "2026-10-03T10:00:00.000Z",
      }),
      persist: (value) => {
        repo.insertIfAbsent(value);
        return value;
      },
      reload: (value) =>
        createPendingIntentsRepo(db).getByCause(value.executor, value.cause),
    });
  });
});
