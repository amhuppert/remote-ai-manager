import { SUBSCRIPTIONS_DDL_BEFORE_RUN_SOURCE } from "../testing/prior-subscription-shape";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "../conversation-subscriptions-repo";
import { createWriteQueue } from "../write-queue";
import { CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_DDL } from "../state-db";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";
import { conversationNoticeInbox } from "./0061-conversation-notice-inbox";
import { createSubscriptionService } from "@/lib/subscriptions/service";

let raw: InstanceType<typeof Database> | undefined;
let fixture: PersistenceFixture | undefined;
afterEach(() => {
  raw?.close();
  fixture?.close();
});
const migrate = (db: InstanceType<typeof Database>) =>
  conversationNoticeInbox.up({
    name: conversationNoticeInbox.name,
    context: { db, configDir: null },
  });
function legacyDb() {
  const db = new Database(":memory:");
  raw = db;
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,project_path TEXT,session_name TEXT,pending_agent_notices TEXT);
    CREATE TABLE project_conversations(id TEXT PRIMARY KEY,project_path TEXT,pending_agent_notices TEXT);
  `);
  db.exec(
    SUBSCRIPTIONS_DDL_BEFORE_RUN_SOURCE.replaceAll(",'conversation'", ""),
  );
  db.exec(CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_DDL);
  return db;
}

it("imports both conversation scopes atomically, preserves opaque strings, clears old arrays and replays once", async () => {
  const db = legacyDb();
  const opaque = "<feedback>\n" + "whole original evidence ".repeat(200);
  db.prepare(
    "INSERT INTO conversations VALUES ('session-c','/project','session name',?)",
  ).run(JSON.stringify(["same prose", "same prose", opaque]));
  db.prepare(
    "INSERT INTO project_conversations VALUES ('project-c','/project',?)",
  ).run(JSON.stringify(["project feedback"]));
  await migrate(db);
  await migrate(db);
  const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
  const session = await repo.readInbox(
    { projectPath: "/project", conversationId: "session-c" },
    {},
  );
  const project = await repo.readInbox(
    { projectPath: "/project", conversationId: "project-c" },
    {},
  );
  expect(session.total).toBe(3);
  expect(project.total).toBe(1);
  expect(new Set(session.items.map((row) => row.fact.occurrenceId)).size).toBe(
    3,
  );
  expect(
    session.items.find((row) => row.fact.sourceText === opaque)?.fact.summary
      .length,
  ).toBeLessThanOrEqual(200);
  expect(
    session.items.find((row) => row.fact.sourceText === opaque)?.fact.summary,
  ).toContain("Source text shortened");
  expect(session.items.every((row) => !/\s/.test(row.id))).toBe(true);
  expect(session.items[0]?.fact.retrievalHandle).toContain(
    "--session='session name'",
  );
  expect(project.items[0]).toMatchObject({
    source: { kind: "conversation", id: "project-c" },
    fact: { sourceText: "project feedback" },
    state: "pending",
  });
  expect(
    db.prepare("SELECT pending_agent_notices FROM conversations").all(),
  ).toEqual([{ pending_agent_notices: "[]" }]);
  expect(
    db.prepare("SELECT pending_agent_notices FROM project_conversations").all(),
  ).toEqual([{ pending_agent_notices: "[]" }]);
  expect(() => enforceCurrentSchemaCompatibility(db, ":memory:", 25)).toThrow(
    /greater than known build version/,
  );
});

it("rolls back every import and old-array clear when a later legacy row cannot be decoded", async () => {
  const db = legacyDb();
  db.prepare(
    "INSERT INTO conversations VALUES ('valid','/project','session',?)",
  ).run(JSON.stringify(["feedback"]));
  db.prepare(
    "INSERT INTO project_conversations VALUES ('invalid','/project',?)",
  ).run(JSON.stringify([42]));
  await expect(migrate(db)).rejects.toThrow();
  expect(
    db.prepare("SELECT pending_agent_notices FROM conversations").all(),
  ).toEqual([{ pending_agent_notices: '["feedback"]' }]);
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS total FROM conversation_subscription_deliveries",
      )
      .get(),
  ).toEqual({ total: 0 });
});

it("rebuilds source constraints without changing existing controls, delivery receipts, or identity indexes", async () => {
  const db = legacyDb();
  db.exec(`INSERT INTO conversation_subscriptions VALUES ('sub','/project','existing','spec','spec','Purpose','passive','["spec-review-commented"]',NULL,'following','9','created','updated',NULL,'paused',NULL,NULL);
    INSERT INTO conversation_subscription_deliveries VALUES ('delivery','sub','/project','existing','spec','spec','10','{}','recorded','uncertain','attempt',2,'queued',NULL,'finished','Unknown');`);
  await migrate(db);
  expect(
    db
      .prepare(
        "SELECT cursor,paused_at,event_kinds_json FROM conversation_subscriptions",
      )
      .all(),
  ).toEqual([
    {
      cursor: "9",
      paused_at: "paused",
      event_kinds_json: '["spec-review-commented"]',
    },
  ]);
  expect(
    db
      .prepare(
        "SELECT state,attempt_id,attempt_count,last_error FROM conversation_subscription_deliveries",
      )
      .all(),
  ).toEqual([
    {
      state: "uncertain",
      attempt_id: "attempt",
      attempt_count: 2,
      last_error: "Unknown",
    },
  ]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='idx_subscription_deliveries_inbox'",
      )
      .all(),
  ).toHaveLength(1);
  expect(() =>
    db.exec("UPDATE conversation_subscriptions SET source_kind='arbitrary'"),
  ).toThrow(/CHECK/);
});

it("accepts internal sources through the synchronous floor and migrates an empty fresh database", async () => {
  fixture = createPersistenceFixture();
  await migrate(fixture.db);
  expect(
    fixture.db
      .prepare("SELECT version FROM schema_migrations WHERE version=26")
      .all(),
  ).toEqual([{ version: 26 }]);
});

it("delivers a delimiter-heavy legacy preview within the next-user briefing budget while retaining full evidence", async () => {
  const db = legacyDb();
  const original = '<>"'.repeat(2000);
  db.prepare(
    "INSERT INTO project_conversations VALUES ('project-c','/project',?)",
  ).run(JSON.stringify([original]));
  await migrate(db);
  const recipient = { projectPath: "/project", conversationId: "project-c" };
  const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
  const service = createSubscriptionService({
    repo,
    isRecipientEligible: async () => true,
    readSource: async (_recipient, _source, cursor) => ({
      cursor,
      facts: [],
      missing: false,
    }),
  });
  const briefing = await service.prepareBriefing({
    recipient,
    attemptId: "input",
  });
  expect(briefing.block).toContain("Source text shortened");
  expect(briefing.block?.length).toBeLessThanOrEqual(2400);
  await briefing.onInputAccepted();
  const row = (
    await createConversationSubscriptionsRepo(db, createWriteQueue()).readInbox(
      recipient,
      { includeSettled: true },
    )
  ).items[0];
  expect(row).toMatchObject({
    state: "accepted",
    fact: { sourceText: original },
  });
});

const legacyLossText =
  "Your previous agent session ended (runtime_closed) while 1 background task(s) were still running: watcher (Watch validation). Those processes were terminated with the session — their completion notifications will never arrive. Do not wait for them; check any output files on disk and re-run whatever is still needed.";
it.each(["ordinary-generated", "iteration", "validator"] as const)(
  "preserves operational recovery of imported task loss for %s",
  async (recipientKind) => {
    const db = legacyDb();
    db.prepare(
      "INSERT INTO conversations VALUES ('legacy-c','/project','session',?)",
    ).run(
      JSON.stringify([
        legacyLossText,
        "Ordinary feedback mentioning background tasks",
      ]),
    );
    await migrate(db);
    const recipient = { projectPath: "/project", conversationId: "legacy-c" };
    const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
    const before = (await repo.listDeliveriesForOverview(recipient)).find(
      (delivery) => delivery.fact.sourceText === legacyLossText,
    );
    if (!before) throw Error("Expected imported task loss evidence");
    const service = createSubscriptionService({
      repo,
      isRecipientEligible: async () => false,
      readSource: async (_recipient, _source, cursor) => ({
        cursor,
        facts: [],
        missing: false,
      }),
    });
    const recovery = await service.prepareRuntimeLossNotice({
      recipient,
      attemptId: recipientKind,
    });
    expect(recovery.block).toContain("watcher");
    expect(
      (
        await service.prepareBriefing({
          recipient,
          attemptId: "generated-turn",
        })
      ).block,
    ).toBeNull();
    await recovery.onInputAccepted();
    await recovery.finish();
    await migrate(db);
    const reloaded = await createConversationSubscriptionsRepo(
      db,
      createWriteQueue(),
    ).listDeliveriesForOverview(recipient);
    expect(
      reloaded.find((delivery) => delivery.id === before.id),
    ).toMatchObject({
      id: before.id,
      fact: {
        occurrenceId: before.fact.occurrenceId,
        eventKind: "background-tasks-lost",
        category: "outcome",
        outcome: "terminated",
        sourceText: legacyLossText,
      },
      state: "accepted",
      attemptCount: 1,
    });
    expect(before.id).toMatch(/^legacy-pending-agent-notice:/);
    expect(
      reloaded.find((delivery) => delivery.fact.sourceText !== legacyLossText),
    ).toMatchObject({
      fact: {
        eventKind: "legacy-pending-agent-notice",
        category: "activity",
        outcome: null,
      },
      state: "pending",
    });
  },
);

it.each([
  `Reviewer quoted: ${legacyLossText}`,
  legacyLossText.slice(0, -30),
  "A user says the background task was terminated; please check it",
])(
  "keeps non-producer legacy feedback passive without guessing operational provenance",
  async (text) => {
    const db = legacyDb();
    db.prepare(
      "INSERT INTO conversations VALUES ('legacy-feedback','/project','session',?)",
    ).run(JSON.stringify([text]));
    await migrate(db);
    const recipient = {
      projectPath: "/project",
      conversationId: "legacy-feedback",
    };
    const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
    expect((await repo.listDeliveriesForOverview(recipient))[0]).toMatchObject({
      fact: {
        sourceText: text,
        eventKind: "legacy-pending-agent-notice",
        category: "activity",
        outcome: null,
      },
      state: "pending",
    });
    const service = createSubscriptionService({
      repo,
      isRecipientEligible: async () => false,
      readSource: async (_recipient, _source, cursor) => ({
        cursor,
        facts: [],
        missing: false,
      }),
    });
    expect(
      (
        await service.prepareRuntimeLossNotice({
          recipient,
          attemptId: "runtime",
        })
      ).block,
    ).toBeNull();
  },
);
