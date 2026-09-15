import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  createGraphWorkflowPendingArtifactsRepo,
  type GraphWorkflowPendingArtifactsRepo,
} from "./graph-workflow-pending-artifacts-repo";
import {
  graphWorkflowExecutionSchema,
  graphWorkflowPendingArtifactsSchema,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowPendingArtifacts } from "@/lib/workflow-graph/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  buildMaximalGraphWorkflowExecution,
  buildMaximalPendingArtifacts,
} from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { createGraphWorkflowExecutionsRepo } from "./graph-workflow-executions-repo";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";
const OWNER = { loopEpoch: 0, status: "running" as const };

let db: Db;
let repo: GraphWorkflowPendingArtifactsRepo;

function seedSession(sessionName: string = SESSION_NAME): void {
  db.prepare("INSERT OR IGNORE INTO projects (root_path) VALUES (?)").run(
    PROJECT_PATH,
  );
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    sessionName,
    `${PROJECT_PATH}/.worktrees/${sessionName}`,
    `csm/${sessionName}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

function maximalPending(): GraphWorkflowPendingArtifacts {
  return graphWorkflowPendingArtifactsSchema.parse(
    buildMaximalPendingArtifacts(),
  );
}

function pending(
  overrides: Partial<GraphWorkflowPendingArtifacts> = {},
): GraphWorkflowPendingArtifacts {
  return graphWorkflowPendingArtifactsSchema.parse({
    ...maximalPending(),
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    ...overrides,
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedSession();
  const execution = graphWorkflowExecutionSchema.parse(
    buildMaximalGraphWorkflowExecution(),
  );
  createGraphWorkflowExecutionsRepo(db).setActive(
    PROJECT_PATH,
    SESSION_NAME,
    { ...execution, id: "exec-1", ...OWNER },
    "2026-09-15",
  );
  repo = createGraphWorkflowPendingArtifactsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("graph-workflow-pending-artifacts-repo durability contract", () => {
  it("round-trips every persisted key path through record -> find", async () => {
    await assertRoundTripDurability({
      label: "graph-workflow-pending-artifacts",
      schema: graphWorkflowPendingArtifactsSchema,
      buildMaximalFixture: maximalPending,
      persist: (record) => {
        repo.record(record);
        return record;
      },
      // A repo instance that never saw the write has no cache to answer from —
      // this is the post-restart read a crash-time retry actually performs.
      reload: (expected) =>
        createGraphWorkflowPendingArtifactsRepo(db).find(
          expected.projectPath,
          expected.sessionName,
          expected.executionId,
        ),
    });
  });

  it("returns null for an execution that owes nothing", () => {
    expect(repo.find(PROJECT_PATH, SESSION_NAME, "exec-unknown")).toBeNull();
  });
});

describe("graph-workflow-pending-artifacts-repo settlement", () => {
  it("retains captured debt if its execution generation changes before settlement", () => {
    const captured = pending();
    repo.record(captured);
    const executions = createGraphWorkflowExecutionsRepo(db);
    const resumed = executions.getActive(PROJECT_PATH, SESSION_NAME)!;
    resumed.loopEpoch += 1;
    executions.setActive(PROJECT_PATH, SESSION_NAME, resumed, "2026-09-15");
    expect(repo.clear(captured, OWNER)).toBe(false);
    expect(
      createGraphWorkflowPendingArtifactsRepo(db).find(
        PROJECT_PATH,
        SESSION_NAME,
        captured.executionId,
      ),
    ).toEqual(captured);
  });
  it("stops reporting an execution once its record is cleared", () => {
    repo.record(pending());
    expect(repo.clear(pending(), OWNER)).toBe(true);

    // Absence IS the durable statement that materialization succeeded, so it
    // has to survive the process that wrote it.
    expect(
      createGraphWorkflowPendingArtifactsRepo(db).find(
        PROJECT_PATH,
        SESSION_NAME,
        "exec-1",
      ),
    ).toBeNull();
    expect(repo.clear(pending(), OWNER)).toBe(false);
  });

  it("replaces a re-recorded execution rather than duplicating it", () => {
    repo.record(pending());
    repo.record(
      pending({ documents: [], recordedAt: "2026-08-13T02:00:00.000Z" }),
    );

    const reloaded = createGraphWorkflowPendingArtifactsRepo(db).find(
      PROJECT_PATH,
      SESSION_NAME,
      "exec-1",
    );
    expect(reloaded?.documents).toEqual([]);
    expect(reloaded?.recordedAt).toBe("2026-08-13T02:00:00.000Z");
  });

  it.each(["contents", "recordedAt"])(
    "preserves replacement debt when the captured %s no longer matches",
    (field) => {
      const captured = pending();
      repo.record(captured);
      const replacement =
        field === "contents"
          ? pending({ documents: [] })
          : pending({ recordedAt: "2026-09-15T00:00:00.000Z" });
      repo.record(replacement);
      expect(repo.clear(captured, OWNER)).toBe(false);
      const reloaded = createGraphWorkflowPendingArtifactsRepo(db).find(
        PROJECT_PATH,
        SESSION_NAME,
        captured.executionId,
      );
      expect(reloaded).toEqual(replacement);
      expect(repo.clear(replacement, OWNER)).toBe(true);
    },
  );

  it("never leaks a same-id record from another session into a scoped read", () => {
    seedSession("s2");
    repo.record(pending());

    expect(repo.find(PROJECT_PATH, "s2", "exec-1")).toBeNull();
  });

  it("drops a session's records with the session", () => {
    repo.record(pending());
    db.prepare(
      "DELETE FROM sessions WHERE project_path = ? AND session_name = ?",
    ).run(PROJECT_PATH, SESSION_NAME);

    expect(repo.find(PROJECT_PATH, SESSION_NAME, "exec-1")).toBeNull();
  });
});
