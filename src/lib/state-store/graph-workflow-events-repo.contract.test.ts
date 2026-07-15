import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  createGraphWorkflowEventsRepo,
  type GraphWorkflowEventsRepo,
} from "./graph-workflow-events-repo";
import { createSessionsRepo } from "./sessions-repo";
import {
  graphWorkflowExecutionEventSchema,
  type GraphWorkflowExecutionEvent,
} from "@/lib/workflow-graph/event-schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: GraphWorkflowEventsRepo;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";
const EXECUTION_ID = "wf-1";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return sessionStateSchema.parse({
    sessionName: SESSION_NAME,
    worktreePath: "/wt/s1",
    branchName: "csm/s1",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  createSessionsRepo(db).upsert(PROJECT_PATH, makeSession());
  repo = createGraphWorkflowEventsRepo(db);
});

afterEach(() => {
  db.close();
});

function statusEvent(
  occurredAt: string,
  preReset = false,
): GraphWorkflowExecutionEvent {
  return graphWorkflowExecutionEventSchema.parse({
    occurredAt,
    event: {
      type: "graph-workflow-status",
      projectName: "p1",
      sessionName: SESSION_NAME,
      executionId: EXECUTION_ID,
      workflowStatus: "running",
      activeContextIds: ["ctx-1"],
    },
    preReset,
  });
}

function contextStatusEvent(
  occurredAt: string,
  contextId: string,
): GraphWorkflowExecutionEvent {
  return graphWorkflowExecutionEventSchema.parse({
    occurredAt,
    event: {
      type: "graph-workflow-context-status",
      projectName: "p1",
      sessionName: SESSION_NAME,
      executionId: EXECUTION_ID,
      contextId,
      status: "running",
      remainingTaskCount: 2,
      iterationCount: 1,
    },
    preReset: false,
  });
}

function validationResultEvent(
  occurredAt: string,
  contextId: string,
  pass: boolean,
): GraphWorkflowExecutionEvent {
  return graphWorkflowExecutionEventSchema.parse({
    occurredAt,
    event: {
      type: "graph-workflow-validation-result",
      projectName: "p1",
      sessionName: SESSION_NAME,
      executionId: EXECUTION_ID,
      contextId,
      validatorType: "context",
      pass,
      summary: pass ? "all good" : "failed",
      reopenTaskIds: pass ? [] : ["task-1"],
    },
    preReset: false,
  });
}

describe("graph-workflow-events-repo append + read", () => {
  it("appendMany then findByExecution returns events in insertion order", () => {
    repo.appendMany(PROJECT_PATH, SESSION_NAME, EXECUTION_ID, "2026-01-01Z", [
      statusEvent("2026-01-01T00:00:01Z"),
      contextStatusEvent("2026-01-01T00:00:02Z", "ctx-1"),
      contextStatusEvent("2026-01-01T00:00:03Z", "ctx-2"),
    ]);

    const out = repo.findByExecution(EXECUTION_ID);
    expect(out.map((e) => e.occurredAt)).toEqual([
      "2026-01-01T00:00:01Z",
      "2026-01-01T00:00:02Z",
      "2026-01-01T00:00:03Z",
    ]);
    expect(out[0]?.event.type).toBe("graph-workflow-status");
  });

  it("appendMany with an empty array is a no-op", () => {
    repo.appendMany(
      PROJECT_PATH,
      SESSION_NAME,
      EXECUTION_ID,
      "2026-01-01Z",
      [],
    );
    expect(repo.findByExecution(EXECUTION_ID)).toEqual([]);
  });

  it("findByExecution isolates events by execution id", () => {
    repo.appendMany(PROJECT_PATH, SESSION_NAME, EXECUTION_ID, "2026-01-01Z", [
      statusEvent("2026-01-01T00:00:01Z"),
    ]);
    repo.appendMany(PROJECT_PATH, SESSION_NAME, "wf-2", "2026-01-01Z", [
      statusEvent("2026-01-01T00:00:02Z"),
    ]);

    expect(repo.findByExecution(EXECUTION_ID)).toHaveLength(1);
    expect(repo.findByExecution("wf-2")).toHaveLength(1);
  });

  it("findTail returns the last N events in chronological order", () => {
    repo.appendMany(PROJECT_PATH, SESSION_NAME, EXECUTION_ID, "2026-01-01Z", [
      contextStatusEvent("2026-01-01T00:00:01Z", "ctx-1"),
      contextStatusEvent("2026-01-01T00:00:02Z", "ctx-2"),
      contextStatusEvent("2026-01-01T00:00:03Z", "ctx-3"),
      contextStatusEvent("2026-01-01T00:00:04Z", "ctx-4"),
    ]);

    const tail = repo.findTail(EXECUTION_ID, 2);
    expect(tail.map((e) => e.occurredAt)).toEqual([
      "2026-01-01T00:00:03Z",
      "2026-01-01T00:00:04Z",
    ]);
  });
});

describe("graph-workflow-events-repo findLatestForContext", () => {
  it("returns the most recent matching (context, type) event", () => {
    repo.appendMany(PROJECT_PATH, SESSION_NAME, EXECUTION_ID, "2026-01-01Z", [
      validationResultEvent("2026-01-01T00:00:01Z", "ctx-1", false),
      validationResultEvent("2026-01-01T00:00:02Z", "ctx-2", false),
      validationResultEvent("2026-01-01T00:00:03Z", "ctx-1", true),
    ]);

    const latest = repo.findLatestForContext(
      EXECUTION_ID,
      "ctx-1",
      "graph-workflow-validation-result",
    );
    expect(latest?.occurredAt).toBe("2026-01-01T00:00:03Z");
    expect(
      latest?.event.type === "graph-workflow-validation-result" &&
        latest.event.pass,
    ).toBe(true);
  });

  it("returns null when no event matches", () => {
    repo.appendMany(PROJECT_PATH, SESSION_NAME, EXECUTION_ID, "2026-01-01Z", [
      statusEvent("2026-01-01T00:00:01Z"),
    ]);
    expect(
      repo.findLatestForContext(
        EXECUTION_ID,
        "ctx-1",
        "graph-workflow-validation-result",
      ),
    ).toBeNull();
  });
});

describe("graph-workflow-events-repo markPreReset", () => {
  it("marks only events for the target context at or before the boundary id", () => {
    repo.appendMany(PROJECT_PATH, SESSION_NAME, EXECUTION_ID, "2026-01-01Z", [
      contextStatusEvent("2026-01-01T00:00:01Z", "ctx-1"),
      contextStatusEvent("2026-01-01T00:00:02Z", "ctx-2"),
      contextStatusEvent("2026-01-01T00:00:03Z", "ctx-1"),
    ]);

    const boundaryId = (
      db
        .prepare(
          "SELECT MAX(id) AS maxId FROM graph_workflow_events WHERE execution_id = ?",
        )
        .get(EXECUTION_ID) as { maxId: number }
    ).maxId;

    const changed = repo.markPreReset(EXECUTION_ID, "ctx-1", boundaryId);
    expect(changed).toBe(2);

    const out = repo.findByExecution(EXECUTION_ID);
    const ctx1 = out.filter(
      (e) =>
        e.event.type === "graph-workflow-context-status" &&
        e.event.contextId === "ctx-1",
    );
    const ctx2 = out.filter(
      (e) =>
        e.event.type === "graph-workflow-context-status" &&
        e.event.contextId === "ctx-2",
    );
    expect(ctx1.every((e) => e.preReset)).toBe(true);
    expect(ctx2.every((e) => !e.preReset)).toBe(true);
  });

  it("does not re-mark already-pre-reset events (idempotent)", () => {
    repo.appendMany(PROJECT_PATH, SESSION_NAME, EXECUTION_ID, "2026-01-01Z", [
      contextStatusEvent("2026-01-01T00:00:01Z", "ctx-1"),
    ]);
    const boundaryId = (
      db
        .prepare(
          "SELECT MAX(id) AS maxId FROM graph_workflow_events WHERE execution_id = ?",
        )
        .get(EXECUTION_ID) as { maxId: number }
    ).maxId;

    expect(repo.markPreReset(EXECUTION_ID, "ctx-1", boundaryId)).toBe(1);
    expect(repo.markPreReset(EXECUTION_ID, "ctx-1", boundaryId)).toBe(0);
  });
});

describe("graph-workflow-events-repo deleteByExecution", () => {
  it("removes only the targeted execution's events", () => {
    repo.appendMany(PROJECT_PATH, SESSION_NAME, EXECUTION_ID, "2026-01-01Z", [
      statusEvent("2026-01-01T00:00:01Z"),
    ]);
    repo.appendMany(PROJECT_PATH, SESSION_NAME, "wf-2", "2026-01-01Z", [
      statusEvent("2026-01-01T00:00:02Z"),
    ]);

    repo.deleteByExecution(EXECUTION_ID);
    expect(repo.findByExecution(EXECUTION_ID)).toEqual([]);
    expect(repo.findByExecution("wf-2")).toHaveLength(1);
  });
});

describe("graph-workflow-events-repo cascading-FK invariant", () => {
  it("deleting a session cascades to its workflow events", () => {
    const sessionsRepo = createSessionsRepo(db);
    repo.appendMany(PROJECT_PATH, SESSION_NAME, EXECUTION_ID, "2026-01-01Z", [
      statusEvent("2026-01-01T00:00:01Z"),
      contextStatusEvent("2026-01-01T00:00:02Z", "ctx-1"),
    ]);

    const before = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_workflow_events WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME) as { n: number }
    ).n;
    expect(before).toBe(2);

    sessionsRepo.delete(PROJECT_PATH, SESSION_NAME);

    const after = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_workflow_events WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME) as { n: number }
    ).n;
    expect(after).toBe(0);
  });
});

/**
 * A maximal {@link GraphWorkflowExecutionEvent}: every introspectable persisted
 * key path is populated to a distinctive non-default value. The wrapped SSE
 * payload is a `graph-workflow-status` event with every nullable/array field set
 * non-default, so the schema-driven durability harness proves no field is
 * dropped or reset to default at the events-table serialization boundary.
 */
function buildMaximalEvent(): GraphWorkflowExecutionEvent {
  return graphWorkflowExecutionEventSchema.parse({
    occurredAt: "2026-02-15T08:09:10Z",
    event: {
      type: "graph-workflow-status",
      projectName: "p1",
      sessionName: SESSION_NAME,
      executionId: EXECUTION_ID,
      workflowStatus: "halted",
      activeContextIds: ["ctx-1"],
      activeBatchIds: ["batch-1"],
      activeJoinIds: ["join-1"],
      haltReason: { type: "aborted" },
      pendingHaltReason: { type: "aborted" },
      secondaryHaltReasons: [{ type: "aborted" }],
    },
    preReset: true,
  });
}

describe("graph-workflow-events-repo durability contract", () => {
  it("round-trips every persisted event key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "graph-workflow-events",
      schema: graphWorkflowExecutionEventSchema,
      buildMaximalFixture: buildMaximalEvent,
      persist: (fixture) => {
        repo.appendMany(
          PROJECT_PATH,
          SESSION_NAME,
          EXECUTION_ID,
          fixture.occurredAt,
          [fixture],
        );
        return fixture;
      },
      reload: () => {
        const rows = repo.findByExecution(EXECUTION_ID);
        return rows[0] ?? null;
      },
    });
  });
});
