import { afterEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "../conversation-subscriptions-repo";
import { createWriteQueue } from "../write-queue";
import { conversationSubscriptionSchema } from "@/lib/subscriptions/schemas";
import { runSubscriptionSource } from "./0068-run-subscription-source";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
const recipient = { projectPath: "/project", conversationId: "owner" };
const at = "2026-10-06T12:00:00.000Z";

const PRIOR_SHAPE = `
  DROP TABLE conversation_subscriptions;
  DROP TABLE conversation_subscription_deliveries;
  CREATE TABLE conversation_subscriptions (id TEXT PRIMARY KEY,project_path TEXT NOT NULL,conversation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('notepad','ticket','spec','workflow','validation','git_job','conversation')),
    source_id TEXT NOT NULL,reason TEXT NOT NULL,mode TEXT NOT NULL CHECK (mode IN ('passive','active')),event_kinds_json TEXT,expires_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('following','unfollowed')),cursor TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    unfollowed_at TEXT,paused_at TEXT,missing_at TEXT,last_error TEXT,UNIQUE (project_path, conversation_id, source_kind, source_id));
  CREATE TABLE conversation_subscription_deliveries (id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,project_path TEXT NOT NULL,conversation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('notepad','ticket','spec','workflow','validation','git_job','conversation')),
    source_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,fact_json TEXT NOT NULL,recorded_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','queued','accepted','failed','uncertain','superseded')),attempt_id TEXT,
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),queued_at TEXT,accepted_at TEXT,finished_at TEXT,last_error TEXT,
    UNIQUE (project_path, conversation_id, source_kind, source_id, occurrence_id));
  INSERT INTO conversation_subscriptions VALUES ('existing','/project','owner','workflow','execution','Launched','passive',NULL,NULL,'following','5','${at}','${at}',NULL,NULL,NULL,NULL);
  INSERT INTO conversation_subscription_deliveries VALUES ('evidence','existing','/project','owner','workflow','execution','5','{}','${at}','accepted',NULL,1,NULL,'${at}','${at}',NULL);
`;

it("keeps every subscription and receipt and then accepts a waking run follow", async () => {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  db.exec(PRIOR_SHAPE);

  const migrate = () => runSubscriptionSource.up({ name: runSubscriptionSource.name, context: { db, configDir: null } });
  await migrate();
  await migrate();

  const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
  expect((await repo.list(recipient)).map((s) => [s.id, s.source.kind, s.wakes])).toEqual([
    ["existing", "workflow", false],
  ]);
  expect(db.prepare("SELECT state FROM conversation_subscription_deliveries WHERE id='evidence'").get()).toEqual({
    state: "accepted",
  });
  await repo.createIfAbsent(
    conversationSubscriptionSchema.parse({
      id: "run-follow",
      recipient,
      source: { kind: "run", id: "run-1" },
      reason: "Run launched by this conversation",
      mode: "passive",
      wakes: true,
      eventKinds: null,
      expiresAt: null,
      status: "following",
      cursor: "0",
      createdAt: at,
      updatedAt: at,
      unfollowedAt: null,
      pausedAt: null,
      missingAt: null,
      lastError: null,
    }),
  );
  expect((await repo.findBySource(recipient, { kind: "run", id: "run-1" }))?.wakes).toBe(true);
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 29 });
});
