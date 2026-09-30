import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";
import { addConversationSubscriptionControls } from "./0060-add-conversation-subscription-controls";
let raw: InstanceType<typeof Database> | undefined;
let fixture: PersistenceFixture | undefined;
afterEach(() => {
  raw?.close();
  fixture?.close();
});
it("adds pause and recipient state idempotently and fences older delivery code", async () => {
  raw = new Database(":memory:");
  raw.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT);CREATE TABLE conversation_subscriptions(id TEXT PRIMARY KEY);INSERT INTO conversation_subscriptions(id) VALUES ('existing')",
  );
  const migrate = () =>
    addConversationSubscriptionControls.up({
      name: addConversationSubscriptionControls.name,
      context: {
        db:
          raw ??
          (() => {
            throw Error("Expected db");
          })(),
        configDir: null,
      },
    });
  await migrate();
  await migrate();
  expect(
    raw.prepare("SELECT id,paused_at FROM conversation_subscriptions").all(),
  ).toEqual([{ id: "existing", paused_at: null }]);
  expect(raw.prepare("SELECT version FROM schema_migrations").all()).toEqual([
    { version: 25 },
  ]);
  expect(() =>
    enforceCurrentSchemaCompatibility(
      raw ??
        (() => {
          throw Error("Expected db");
        })(),
      ":memory:",
      24,
    ),
  ).toThrow(/greater than known build version/);
});
it("agrees with the fresh synchronous floor", async () => {
  fixture = createPersistenceFixture();
  await addConversationSubscriptionControls.up({
    name: addConversationSubscriptionControls.name,
    context: { db: fixture.db, configDir: null },
  });
  expect(
    fixture.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_subscription_preferences','conversation_subscription_read_state')",
      )
      .all(),
  ).toHaveLength(2);
  expect(
    fixture.db.prepare("PRAGMA table_info(conversation_subscriptions)").all(),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "paused_at" })]),
  );
});
