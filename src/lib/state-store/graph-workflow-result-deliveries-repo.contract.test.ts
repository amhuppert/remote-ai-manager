import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  createGraphWorkflowResultDeliveriesRepo,
  type GraphWorkflowResultDeliveriesRepo,
} from "./graph-workflow-result-deliveries-repo";
import { graphWorkflowResultDeliverySchema } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowResultDelivery } from "@/lib/workflow-graph/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { buildMaximalResultDelivery } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { createStateStore } from "./store";
import { createWriteQueue } from "./write-queue";
import { createNotificationsRepo } from "@/lib/notifications/repo";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";
const CONVERSATION_ID = "conv-origin-1";

let db: Db;
let repo: GraphWorkflowResultDeliveriesRepo;

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

function maximalDelivery(): GraphWorkflowResultDelivery {
  return graphWorkflowResultDeliverySchema.parse(buildMaximalResultDelivery());
}

/**
 * A freshly recorded boundary — the state the recording transaction actually
 * writes. The maximal fixture is deliberately a mid-flight claim (attempt 3),
 * which is what the durability harness needs and what a lifecycle assertion
 * must not start from.
 */
function delivery(
  overrides: Partial<GraphWorkflowResultDelivery> = {},
): GraphWorkflowResultDelivery {
  return graphWorkflowResultDeliverySchema.parse({
    ...maximalDelivery(),
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    originConversationId: CONVERSATION_ID,
    state: "pending",
    attemptId: null,
    attemptCount: 0,
    deliveredAt: null,
    effectsDeliveredAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedSession();
  repo = createGraphWorkflowResultDeliveriesRepo(db);
});

afterEach(() => {
  db.close();
});

describe("graph-workflow-result-deliveries-repo durability contract", () => {
  it("round-trips a frozen ownerless boundary and its settled origin-effect receipt", async () => {
    const record = graphWorkflowResultDeliverySchema.parse({
      ...maximalDelivery(),
      originConversationId: null,
      effectsDeliveredAt: "2026-10-01T04:00:00.000Z",
    });
    repo.record(record);
    expect(
      createGraphWorkflowResultDeliveriesRepo(db).findByBoundary(
        record.projectPath,
        record.sessionName,
        record.executionId,
        record.boundarySeq,
      ),
    ).toEqual(record);
  });
  it("round-trips every persisted delivery key path through record -> findByBoundary", async () => {
    await assertRoundTripDurability({
      label: "graph-workflow-result-deliveries",
      schema: graphWorkflowResultDeliverySchema,
      buildMaximalFixture: maximalDelivery,
      persist: (record) => {
        repo.record(record);
        return record;
      },
      // A repo instance that never saw the write has no cache to answer from —
      // this is the post-restart read.
      reload: (expected) =>
        createGraphWorkflowResultDeliveriesRepo(db).findByBoundary(
          expected.projectPath,
          expected.sessionName,
          expected.executionId,
          expected.boundarySeq,
        ),
    });
  });

  it("returns null for a boundary that was never recorded", () => {
    expect(
      repo.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-unknown", 1),
    ).toBeNull();
  });
});

describe("graph-workflow-result-deliveries-repo boundary keying", () => {
  // R7.4: recording is atomic with the boundary, so a crash between recording
  // and attachment replays the recording. The boundary key is what makes that
  // replay a no-op instead of a second delivery of the same result.
  it("refuses a repeated recording of the same boundary without disturbing the row", () => {
    const first = delivery({ boundarySeq: 7 });
    expect(repo.record(first)).toBe(true);

    const replay = delivery({
      boundarySeq: 7,
      recordedAt: "2099-01-01T00:00:00.000Z",
      payload: { state: "rewritten" },
    });
    expect(repo.record(replay)).toBe(false);

    expect(
      createGraphWorkflowResultDeliveriesRepo(db).findByBoundary(
        PROJECT_PATH,
        SESSION_NAME,
        "exec-1",
        7,
      ),
    ).toEqual(first);
  });

  it("keeps boundaries of the same execution as separate deliveries", () => {
    repo.record(delivery({ boundarySeq: 1 }));
    repo.record(delivery({ boundarySeq: 2 }));

    expect(
      repo.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-1", 1)?.boundarySeq,
    ).toBe(1);
    expect(
      repo.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-1", 2)?.boundarySeq,
    ).toBe(2);
  });
});

describe("graph-workflow-result-deliveries-repo effect receipts", () => {
  it("persists a separate post-commit effect receipt across repository restart", () => {
    repo.record(delivery({ boundarySeq: 1 }));

    expect(
      repo
        .listPendingEffects(PROJECT_PATH, SESSION_NAME)
        .map((row) => row.boundarySeq),
    ).toEqual([1]);
    expect(
      repo.markEffectsDelivered(
        PROJECT_PATH,
        SESSION_NAME,
        "exec-1",
        1,
        "2026-08-13T01:00:00Z",
      ),
    ).toBe(true);

    const restarted = createGraphWorkflowResultDeliveriesRepo(db);
    expect(restarted.listPendingEffects(PROJECT_PATH, SESSION_NAME)).toEqual(
      [],
    );
    expect(
      restarted.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-1", 1),
    ).toMatchObject({
      state: "pending",
      effectsDeliveredAt: "2026-08-13T01:00:00Z",
    });
  });
});

describe("graph-workflow-result-deliveries-repo scoped reads", () => {
  it("reads an execution's whole ledger in boundary order", () => {
    repo.record(delivery({ boundarySeq: 2 }));
    repo.record(delivery({ boundarySeq: 1 }));

    expect(
      repo
        .listByExecution(PROJECT_PATH, SESSION_NAME, "exec-1")
        .map((row) => row.boundarySeq),
    ).toEqual([1, 2]);
    expect(
      repo.listByExecution(PROJECT_PATH, SESSION_NAME, "exec-other"),
    ).toEqual([]);
  });
});

describe("graph-workflow result delivery serialized lifecycle", () => {
  it("settles every earlier pending boundary when a noncompletion boundary finds a deleted origin", async () => {
    repo.record(
      delivery({
        boundarySeq: 1,
        payload: { boundaryKind: "pause", status: "paused" },
      }),
    );
    repo.markEffectsDelivered(
      PROJECT_PATH,
      SESSION_NAME,
      "exec-1",
      1,
      "2026-08-13T01:00:00Z",
    );
    repo.record(
      delivery({
        boundarySeq: 2,
        payload: { boundaryKind: "halt", status: "halted" },
      }),
    );
    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    expect(
      await store.settleGraphWorkflowResultDeliveryFallback(
        PROJECT_PATH,
        SESSION_NAME,
        "exec-1",
        2,
      ),
    ).toBe(true);
    expect(
      repo
        .listByExecution(PROJECT_PATH, SESSION_NAME, "exec-1")
        .map(({ boundarySeq, state }) => ({ boundarySeq, state })),
    ).toEqual([
      { boundarySeq: 1, state: "delivered" },
      { boundarySeq: 2, state: "delivered" },
    ]);
  });

  it("settles every earlier pending boundary when completion finds a deleted origin", async () => {
    repo.record(
      delivery({
        boundarySeq: 1,
        payload: { boundaryKind: "halt", status: "halted" },
      }),
    );
    repo.markEffectsDelivered(
      PROJECT_PATH,
      SESSION_NAME,
      "exec-1",
      1,
      "2026-08-13T01:00:00Z",
    );
    repo.record(
      delivery({
        boundarySeq: 2,
        payload: { boundaryKind: "completion", status: "completed" },
      }),
    );
    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    await store.commitGraphWorkflowMissingOriginFallback(
      PROJECT_PATH,
      SESSION_NAME,
      "exec-1",
      2,
      {
        type: "workflow-result-ready",
        title: "Workflow result ready",
        message: "Execution completed after its origin was deleted.",
        projectName: "p1",
        sessionName: SESSION_NAME,
        executionId: "exec-1",
        originConversationId: CONVERSATION_ID,
        deepLink: "/projects/p1/s1/workflow?execution=exec-1",
        dedupeKey: "graph-workflow-origin-missing:exec-1",
      },
    );

    expect(
      repo
        .listByExecution(PROJECT_PATH, SESSION_NAME, "exec-1")
        .map(({ boundarySeq, state }) => ({ boundarySeq, state })),
    ).toEqual([
      { boundarySeq: 1, state: "delivered" },
      { boundarySeq: 2, state: "delivered" },
    ]);
    expect(createNotificationsRepo(db).getNotifications().total).toBe(1);
  });
});
