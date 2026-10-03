import { afterEach, describe, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { controlPermitRecordSchema } from "@/lib/control/schemas";
import { createControlPermitsRepo } from "./control-permits-repo";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

describe("control permits repository", () => {
  it("round-trips a child permit with every persisted field", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createControlPermitsRepo(db);
    repo.insert({
      controllerId: "run:parent",
      parentControllerId: null,
      generation: 1,
      state: "open",
      updatedAt: "2026-10-03T10:00:00.000Z",
    });

    await assertRoundTripDurability({
      label: "control permit",
      schema: controlPermitRecordSchema,
      buildMaximalFixture: () => ({
        controllerId: "context:child",
        parentControllerId: "run:parent",
        generation: 3,
        state: "closed" as const,
        updatedAt: "2026-10-03T11:00:00.000Z",
      }),
      persist: (value) => {
        repo.insert(value);
        return value;
      },
      reload: (value) => createControlPermitsRepo(db).get(value.controllerId),
    });
  });
});
