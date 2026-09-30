import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";
import {
  addConversationSubscriptionWaits,
  CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_VERSION,
} from "./0059-add-conversation-subscription-waits";

let raw: InstanceType<typeof Database> | undefined;
let fixture: PersistenceFixture | undefined;
afterEach(() => {
  raw?.close();
  fixture?.close();
});
const migrate = (db: InstanceType<typeof Database>) =>
  addConversationSubscriptionWaits.up({
    name: addConversationSubscriptionWaits.name,
    context: { db, configDir: null },
  });
describe("0059 durable wait and typed queue metadata cutover", () => {
  it("creates idempotent tables on a prior database and fences older queue readers", async () => {
    const db = new Database(":memory:");
    raw = db;
    raw.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT)",
    );
    await migrate(raw);
    raw
      .prepare(
        "INSERT INTO conversation_subscription_waits VALUES ('wait','sub','/project','conversation','waiting','2026-10-01T12:00:00Z',NULL,NULL,'{}')",
      )
      .run();
    await migrate(raw);
    expect(
      raw.prepare("SELECT id FROM conversation_subscription_waits").all(),
    ).toEqual([{ id: "wait" }]);
    expect(raw.prepare("SELECT version FROM schema_migrations").all()).toEqual([
      { version: CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_VERSION },
    ]);
    expect(() =>
      enforceCurrentSchemaCompatibility(
        db,
        ":memory:",
        CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_VERSION - 1,
      ),
    ).toThrow(/greater than known build version/);
  });
  it("agrees with the fresh synchronous schema floor", async () => {
    fixture = createPersistenceFixture();
    await migrate(fixture.db);
    expect(
      fixture.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_subscription_waits','conversation_subscription_wake_batches')",
        )
        .all(),
    ).toHaveLength(2);
  });
});
