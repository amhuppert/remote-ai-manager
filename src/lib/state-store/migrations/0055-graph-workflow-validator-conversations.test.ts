import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowExecutionsRepo } from "../graph-workflow-executions-repo";
import { _createTestDbAtPath, KNOWN_SCHEMA_VERSION } from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
  readSchemaCompatibilityBarrierVersion,
} from "../schema-compatibility";
import {
  graphWorkflowValidatorConversations,
  GRAPH_WORKFLOW_VALIDATOR_CONVERSATIONS_SCHEMA_VERSION,
} from "./0055-graph-workflow-validator-conversations";

function world() {
  const configDir = mkdtempSync(path.join(tmpdir(), "cc-validator-lanes-"));
  const db = _createTestDbAtPath(path.join(configDir, "command-center.db"));
  const fixture = createPersistenceFixture({ db });
  fixture.seedProject("/project");
  fixture.seedSession("/project", "session");
  createGraphWorkflowExecutionsRepo(db).setActive(
    "/project",
    "session",
    createWorkflowExecution(),
    "2026-09-18T00:00:00Z",
  );
  return {
    db,
    configDir,
    run: () =>
      graphWorkflowValidatorConversations.up({
        name: graphWorkflowValidatorConversations.name,
        context: { db, configDir },
      }),
    close() {
      fixture.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

describe("0055 validator conversation compatibility fence", () => {
  it("refuses older readers without changing execution rows, and replays idempotently", async () => {
    const { db, configDir, run, close } = world();
    try {
      const before = db
        .prepare("SELECT * FROM graph_workflow_executions")
        .all();
      const barriersAtStamp: number[] = [];
      db.function("observe_validator_barrier", () => {
        barriersAtStamp.push(readSchemaCompatibilityBarrierVersion(configDir));
        return 1;
      });
      db.exec(`CREATE TRIGGER observe_validator_stamp BEFORE INSERT ON schema_migrations
        WHEN NEW.version = 22 BEGIN SELECT observe_validator_barrier(); END;`);
      await run();
      await run();
      expect(barriersAtStamp.length).toBeGreaterThan(0);
      expect(barriersAtStamp.every((version) => version === 22)).toBe(true);
      expect(
        db
          .prepare("SELECT version FROM schema_migrations WHERE version = 22")
          .all(),
      ).toEqual([{ version: 22 }]);
      expect(() => enforceCurrentSchemaCompatibility(db, db.name, 21)).toThrow(
        /greater than known build version/,
      );
      expect(() =>
        enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION),
      ).not.toThrow();
      expect(
        db.prepare("SELECT * FROM graph_workflow_executions").all(),
      ).toEqual(before);
    } finally {
      close();
    }
  });

  it.each(["ledger", "barrier"] as const)(
    "refuses a future %s before stamping an already-open connection",
    async (witness) => {
      const { db, configDir, run, close } = world();
      try {
        const futureVersion = KNOWN_SCHEMA_VERSION + 1;
        if (witness === "ledger") {
          db.prepare(
            "INSERT INTO schema_migrations (version, description) VALUES (?, 'future')",
          ).run(futureVersion);
        } else {
          await publishSchemaCompatibilityBarrier(configDir, futureVersion);
        }
        await expect(run()).rejects.toThrow(/greater than known build version/);
        expect(
          db
            .prepare("SELECT version FROM schema_migrations WHERE version = ?")
            .all(GRAPH_WORKFLOW_VALIDATOR_CONVERSATIONS_SCHEMA_VERSION),
        ).toEqual([]);
      } finally {
        close();
      }
    },
  );
});
