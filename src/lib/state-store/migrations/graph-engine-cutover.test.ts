import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../migrator";
import { _createTestDb, _createTestDbAtPath } from "../state-db";
import { createStateStore } from "../store";
import { createSpecEventsRepo } from "../spec-events-repo";
import {
  createDeploy15Database,
  DEPLOY_1_5_PROJECT_PATH,
  DEPLOY_1_5_SESSION_NAME,
  DEPLOY_1_5_CONVERSATION_ID,
} from "./testing/deploy-1-5-database";
import { transformCutoverConfig } from "./0069-graph-engine-cutover";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-engine-cutover-"));
  dirs.push(dir);
  return dir;
}
function schema(db: Database.Database): unknown {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return tables.map(({ name }) => ({
    name,
    columns: db.pragma(`table_info(${name})`),
    foreignKeys: db.pragma(`foreign_key_list(${name})`),
    indexes: db.pragma(`index_list(${name})`),
  }));
}

describe("offline graph-engine retirement", () => {
  it("withdraws legacy plan drafts and retires their open approval requests", async () => {
    const dir = directory();
    createDeploy15Database(dir);
    const db = _createTestDbAtPath(path.join(dir, "command-center.db"));
    try {
      db.prepare(
        "INSERT INTO specs(id,project_path,slug,name,gate_policy_json) VALUES(?,?,?,?,?)",
      ).run(
        "legacy-spec",
        DEPLOY_1_5_PROJECT_PATH,
        "legacy",
        "Legacy",
        '{"preset":"contract-bearing"}',
      );
      db.exec(
        "INSERT INTO spec_revisions(id,spec_id,number,state,authoring_stage) VALUES('plan-draft','legacy-spec',1,'draft','plan')",
      );
      db.prepare(
        "INSERT INTO spec_events(spec_id,occurred_at,event_type,actor_json,payload_json) VALUES(?,?,?,?,?)",
      ).run(
        "legacy-spec",
        "2026-10-13T00:00:00.000Z",
        "spec-attention-changed",
        '{"kind":"system"}',
        JSON.stringify({
          kind: "approval-requested",
          attentionId: "plan-attention",
          revisionId: "plan-draft",
          gate: "plan",
          scope: "gate",
          subject: "plan",
        }),
      );
      const events = createSpecEventsRepo(db);
      expect(events.listOpenApprovalRequests("legacy-spec")).toHaveLength(1);
      await runMigrations({ db, configDir: dir });
      expect(events.listOpenApprovalRequests("legacy-spec")).toEqual([]);
      expect(
        db
          .prepare("SELECT state FROM spec_revisions WHERE id='plan-draft'")
          .get(),
      ).toEqual({ state: "withdrawn" });
      expect(events.findBySpecId("legacy-spec")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("migrates a persisted 1.5 database, preserves conversations and converges with the fresh floor", async () => {
    const dir = directory();
    createDeploy15Database(dir);
    let db = _createTestDbAtPath(path.join(dir, "command-center.db"));
    db.prepare(
      "UPDATE conversations SET role='iteration', status='running', pending_prompt_text='unfinished', pending_queue='[]' WHERE id=?",
    ).run(DEPLOY_1_5_CONVERSATION_ID);
    const originalConfig = {
      workflowDefaults: { memory: { implementer: { read: "linked-only" } } },
    };
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify(originalConfig),
    );
    expect(await runMigrations({ db, configDir: dir })).toEqual([
      "0069-graph-engine-cutover",
      "0070-retire-graph-engine-storage",
    ]);
    db.close();
    db = _createTestDbAtPath(path.join(dir, "command-center.db"));
    try {
      const store = createStateStore({ db });
      const conversation = await store.getConversation(
        DEPLOY_1_5_PROJECT_PATH,
        DEPLOY_1_5_SESSION_NAME,
        DEPLOY_1_5_CONVERSATION_ID,
      );
      expect(conversation).toMatchObject({
        role: "iteration",
        status: "awaiting",
        pendingPromptText: null,
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(
        JSON.parse(
          readFileSync(path.join(dir, "config.json.pre-deploy-2"), "utf8"),
        ),
      ).toEqual(originalConfig);
      expect(await runMigrations({ db, configDir: dir })).toEqual([]);
      const fresh = _createTestDb({ inMemory: true });
      try {
        expect(schema(db)).toEqual(schema(fresh));
      } finally {
        fresh.close();
      }
      // Deletion must not fire a retired snapshot-sidecar trigger.
      expect(() =>
        db
          .prepare("DELETE FROM conversations WHERE id=?")
          .run(DEPLOY_1_5_CONVERSATION_ID),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("moves sparse role policies and preserves a completed config transformation on replay", () => {
    const once = transformCutoverConfig({
      workflowDefaults: { memory: { implementer: { read: "linked-only" } } },
    });
    expect(once.memory).toEqual({
      roles: {
        implementer: { read: "linked-only", contribute: "on" },
        validator: { read: "off", contribute: "off" },
      },
    });
    expect(transformCutoverConfig(once)).toEqual(once);
  });

  it("runs on a fresh directory without inventing a config file", async () => {
    const dir = directory();
    const db = _createTestDbAtPath(path.join(dir, "command-center.db"));
    try {
      await runMigrations({ db, configDir: dir });
      expect(() => readFileSync(path.join(dir, "config.json"))).toThrow();
      expect(
        db
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 30 });
    } finally {
      db.close();
    }
  });
});
