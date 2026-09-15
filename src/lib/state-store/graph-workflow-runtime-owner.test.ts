import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { claimGraphWorkflowRuntimeOwner } from "./graph-workflow-runtime-owner";

function withDatabase(test: (db: InstanceType<typeof Database>) => void): void {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE graph_workflow_runtime_owner(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), pid INTEGER NOT NULL, token TEXT NOT NULL)",
  );
  try {
    test(db);
  } finally {
    db.close();
  }
}

describe("graph workflow runtime owner", () => {
  it("claims an empty store and lets the same runtime repeat initialization", () =>
    withDatabase((db) => {
      const deps = {
        identity: { pid: 100, token: "first" },
        isProcessAlive: () => true,
      };
      expect(claimGraphWorkflowRuntimeOwner(db, deps)).toEqual({
        kind: "acquired",
        owner: deps.identity,
      });
      expect(claimGraphWorkflowRuntimeOwner(db, deps)).toEqual({
        kind: "acquired",
        owner: deps.identity,
      });
      expect(
        db.prepare("SELECT pid, token FROM graph_workflow_runtime_owner").get(),
      ).toEqual(deps.identity);
    }));

  it("refuses another live owner and another runtime inside the same process", () =>
    withDatabase((db) => {
      const owner = { pid: 100, token: "first" };
      db.prepare(
        "INSERT INTO graph_workflow_runtime_owner VALUES (1, ?, ?)",
      ).run(owner.pid, owner.token);
      for (const pid of [100, 200]) {
        expect(
          claimGraphWorkflowRuntimeOwner(db, {
            identity: { pid, token: "second" },
            isProcessAlive: () => true,
          }),
        ).toEqual({ kind: "occupied", owner });
      }
      expect(
        db.prepare("SELECT pid, token FROM graph_workflow_runtime_owner").get(),
      ).toEqual(owner);
    }));

  it("replaces only a confirmed dead process and checks liveness outside the transaction", () =>
    withDatabase((db) => {
      db.prepare(
        "INSERT INTO graph_workflow_runtime_owner VALUES (1, 100, 'dead')",
      ).run();
      const identity = { pid: 200, token: "successor" };
      expect(
        claimGraphWorkflowRuntimeOwner(db, {
          identity,
          isProcessAlive(pid) {
            expect(db.inTransaction).toBe(false);
            expect(pid).toBe(100);
            return false;
          },
        }),
      ).toEqual({ kind: "acquired", owner: identity });
      expect(
        db.prepare("SELECT pid, token FROM graph_workflow_runtime_owner").get(),
      ).toEqual(identity);
    }));

  it("does not steal an owner installed after the dead-owner probe", () =>
    withDatabase((db) => {
      db.prepare(
        "INSERT INTO graph_workflow_runtime_owner VALUES (1, 100, 'dead')",
      ).run();
      const winner = { pid: 300, token: "winner" };
      expect(
        claimGraphWorkflowRuntimeOwner(db, {
          identity: { pid: 200, token: "late" },
          isProcessAlive(pid) {
            expect(db.inTransaction).toBe(false);
            if (pid === 100) {
              db.prepare(
                "UPDATE graph_workflow_runtime_owner SET pid = ?, token = ?",
              ).run(winner.pid, winner.token);
              return false;
            }
            return true;
          },
        }),
      ).toEqual({ kind: "occupied", owner: winner });
      expect(
        db.prepare("SELECT pid, token FROM graph_workflow_runtime_owner").get(),
      ).toEqual(winner);
    }));
});
