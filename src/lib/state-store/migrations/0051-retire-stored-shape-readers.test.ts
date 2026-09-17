import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { retireStoredShapeReaders } from "./0051-retire-stored-shape-readers";

function openFixture(filename = ":memory:") {
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS conversation_machine_snapshots (
      owner TEXT, conversation_id TEXT, snapshot_json TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (session_name TEXT, workflow_envelopes TEXT);
  `);
  return db;
}

function migrate(db: InstanceType<typeof Database>) {
  return retireStoredShapeReaders.up({
    name: retireStoredShapeReaders.name,
    context: { db, configDir: null },
  });
}

function snapshot(db: InstanceType<typeof Database>, id: string) {
  const row = db
    .prepare(
      "SELECT snapshot_json FROM conversation_machine_snapshots WHERE conversation_id = ?",
    )
    .get(id) as { snapshot_json: string };
  return JSON.parse(row.snapshot_json);
}

function envelopes(db: InstanceType<typeof Database>) {
  const row = db.prepare("SELECT workflow_envelopes FROM sessions").get() as {
    workflow_envelopes: string;
  };
  return JSON.parse(row.workflow_envelopes);
}

const legacyMap = {
  claude: { model: "historical-claude", effort: "max" },
  codex: { model: "historical-codex", effort: "high" },
};

function legacyCollaboration(primaryAgentBackend: string) {
  return {
    workflowType: "collaboration",
    featureSnapshot: {
      primaryAgentBackend,
      agentModelSettings: legacyMap,
      codexFastMode: false,
      retained: { futureField: "untouched" },
    },
  };
}

describe("0051-retire-stored-shape-readers", () => {
  it("durably rewrites both snapshot owners and keeps the minted debug generation on replay", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-retired-snapshots-"));
    const filename = path.join(dir, "state.db");
    let db = openFixture(filename);
    try {
      for (const owner of ["session", "project"]) {
        db.prepare(
          "INSERT INTO conversation_machine_snapshots VALUES (?, ?, ?, 'original-time')",
        ).run(
          owner,
          owner,
          JSON.stringify({
            value: "debug",
            retained: [1, 2],
            context: {
              activeTurn: {
                promptText: "resume me",
                futureField: { retained: true },
              },
              debugMode: { active: true, debugSessionId: "", recording: true },
              backendRef: { backend: "claude", ref: "canonical" },
            },
          }),
        );
      }
      await migrate(db);
      const stored = snapshot(db, "session");
      expect(stored.context.activeTurn).toEqual({
        kind: "conversation_turn",
        promptText: "resume me",
        futureField: { retained: true },
      });
      expect(stored.context.debugMode.debugSessionId).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(stored.context.debugGenerationNeedsPersistence).toBe(true);
      expect(stored.retained).toEqual([1, 2]);
      expect(stored.context.backendRef).toEqual({
        backend: "claude",
        ref: "canonical",
      });
      expect(snapshot(db, "project").context.activeTurn.kind).toBe(
        "conversation_turn",
      );
      const first = db
        .prepare("SELECT * FROM conversation_machine_snapshots ORDER BY owner")
        .all();
      db.close();
      db = openFixture(filename);
      await migrate(db);
      expect(
        db
          .prepare(
            "SELECT * FROM conversation_machine_snapshots ORDER BY owner",
          )
          .all(),
      ).toEqual(first);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["claude", "codex"])(
    "freezes the historical %s-primary pairing without consulting current defaults",
    async (primary) => {
      const db = openFixture();
      try {
        db.prepare("INSERT INTO sessions VALUES ('session', ?)").run(
          JSON.stringify({ run: legacyCollaboration(primary) }),
        );
        await migrate(db);
        const result = envelopes(db).run.featureSnapshot;
        const claude = {
          backend: "claude",
          modelSelection: {
            modelId: "historical-claude",
            parameters: { effort: "max" },
          },
        };
        const codex = {
          backend: "codex",
          modelSelection: {
            modelId: "historical-codex",
            parameters: { reasoning: "high", fast: "false" },
          },
        };
        expect(result.agents).toEqual({
          agent_one: primary === "claude" ? claude : codex,
          agent_two: primary === "claude" ? codex : claude,
        });
        expect(result.origin).toBe("user");
        expect(result.retained).toEqual({ futureField: "untouched" });
        expect(result).not.toHaveProperty("agentModelSettings");
        expect(result).not.toHaveProperty("codexFastMode");
        const first = db
          .prepare("SELECT workflow_envelopes FROM sessions")
          .get();
        await migrate(db);
        expect(
          db.prepare("SELECT workflow_envelopes FROM sessions").get(),
        ).toEqual(first);
      } finally {
        db.close();
      }
    },
  );

  it("preserves current selections, discriminators, inactive debug state and unrelated envelopes", async () => {
    const db = openFixture();
    try {
      const agents = {
        agent_one: {
          backend: "claude",
          modelSelection: { modelId: "current", parameters: { effort: "low" } },
          futureField: true,
        },
        agent_two: {
          backend: "claude",
          modelSelection: { modelId: "current-two", parameters: {} },
        },
      };
      const other = {
        workflowType: "other",
        featureSnapshot: { agentModelSettings: legacyMap },
      };
      const workflow = {
        workflowType: "collaboration",
        featureSnapshot: {
          origin: "workflow",
          resolvedConfig: { retained: true },
        },
      };
      db.prepare("INSERT INTO sessions VALUES ('session', ?)").run(
        JSON.stringify({
          current: {
            ...legacyCollaboration("claude"),
            featureSnapshot: {
              ...legacyCollaboration("claude").featureSnapshot,
              agents,
              origin: "user",
            },
          },
          other,
          workflow,
        }),
      );
      const current = {
        context: {
          activeTurn: { kind: "task_run", retained: true },
          debugMode: { active: true, debugSessionId: "already-minted" },
          debugGenerationNeedsPersistence: false,
        },
      };
      const inactive = {
        context: { activeTurn: null, debugMode: { active: false } },
      };
      for (const [id, value] of [
        ["current", current],
        ["inactive", inactive],
      ] as const) {
        db.prepare(
          "INSERT INTO conversation_machine_snapshots VALUES ('session', ?, ?, 'original-time')",
        ).run(id, JSON.stringify(value));
      }
      await migrate(db);
      expect(envelopes(db).current.featureSnapshot.agents).toEqual(agents);
      expect(envelopes(db).other).toEqual(other);
      expect(envelopes(db).workflow).toEqual(workflow);
      expect(snapshot(db, "current")).toEqual(current);
      expect(snapshot(db, "inactive")).toEqual(inactive);
    } finally {
      db.close();
    }
  });

  it("refuses an unresolvable legacy pairing and rolls back earlier snapshot rewrites", async () => {
    const db = openFixture();
    try {
      const original = JSON.stringify({
        context: { activeTurn: { promptText: "unchanged" } },
      });
      db.prepare(
        "INSERT INTO conversation_machine_snapshots VALUES ('session', 'first', ?, 'original-time')",
      ).run(original);
      db.prepare("INSERT INTO sessions VALUES ('session', ?)").run(
        JSON.stringify({ run: legacyCollaboration("unknown") }),
      );
      await expect(migrate(db)).rejects.toThrow(/collaboration.*primary/i);
      expect(
        db
          .prepare("SELECT snapshot_json FROM conversation_machine_snapshots")
          .get(),
      ).toEqual({ snapshot_json: original });
    } finally {
      db.close();
    }
  });
});
