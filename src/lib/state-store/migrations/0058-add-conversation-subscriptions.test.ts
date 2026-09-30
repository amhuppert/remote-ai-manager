import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { addConversationSubscriptions } from "./0058-add-conversation-subscriptions";

let raw: InstanceType<typeof Database> | undefined;
let fixture: PersistenceFixture | undefined;
afterEach(() => {
  raw?.close();
  fixture?.close();
});
const migrate = (db: InstanceType<typeof Database>) =>
  addConversationSubscriptions.up({
    name: addConversationSubscriptions.name,
    context: { db, configDir: null },
  });
describe("0058 additive conversation subscriptions", () => {
  it("creates an idempotent schema on a prior database and preserves inbox facts", async () => {
    raw = new Database(":memory:");
    raw.exec("CREATE TABLE tickets(id TEXT PRIMARY KEY)");
    await migrate(raw);
    raw
      .prepare(
        `INSERT INTO conversation_subscriptions VALUES ('sub','/project','conversation','ticket','ticket','Linked','passive',NULL,NULL,'following','1','created','updated',NULL,NULL,NULL)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO conversation_subscription_deliveries VALUES ('delivery','sub','/project','conversation','ticket','ticket','occurrence','{}','recorded','uncertain','attempt',1,'queued',NULL,'finished','Unknown acceptance')`,
      )
      .run();
    await migrate(raw);
    expect(
      raw
        .prepare(
          "SELECT state,attempt_id FROM conversation_subscription_deliveries",
        )
        .all(),
    ).toEqual([{ state: "uncertain", attempt_id: "attempt" }]);
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='ticket_status_changes'",
        )
        .all(),
    ).toHaveLength(1);
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='schema_migrations'",
        )
        .all(),
    ).toHaveLength(0);
  });
  it("agrees with the synchronous floor and leaves the compatibility gate unchanged", async () => {
    fixture = createPersistenceFixture();
    const before = fixture.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    await migrate(fixture.db);
    expect(
      fixture.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(before);
    expect(
      fixture.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_subscriptions','conversation_subscription_deliveries','ticket_status_changes')",
        )
        .all(),
    ).toHaveLength(3);
  });
});
