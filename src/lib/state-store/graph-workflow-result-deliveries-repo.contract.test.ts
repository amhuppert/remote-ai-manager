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

function markDelivering(
  executionId: string,
  boundarySeq: number,
  attemptId: string,
): boolean {
  return repo.markDelivering(
    PROJECT_PATH,
    SESSION_NAME,
    executionId,
    boundarySeq,
    attemptId,
  );
}

function markDelivered(
  executionId: string,
  boundarySeq: number,
  attemptId: string,
  deliveredAt: string,
): boolean {
  return repo.markDelivered(
    PROJECT_PATH,
    SESSION_NAME,
    executionId,
    boundarySeq,
    attemptId,
    deliveredAt,
  );
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

describe("graph-workflow-result-deliveries-repo claim lifecycle", () => {
  it("moves a recorded boundary through pending -> delivering -> delivered", () => {
    repo.record(delivery({ boundarySeq: 1, state: "pending" }));

    expect(markDelivering("exec-1", 1, "attempt-1")).toBe(true);
    const claimed = createGraphWorkflowResultDeliveriesRepo(db).findByBoundary(
      PROJECT_PATH,
      SESSION_NAME,
      "exec-1",
      1,
    );
    expect(claimed?.state).toBe("delivering");
    expect(claimed?.attemptId).toBe("attempt-1");
    expect(claimed?.attemptCount).toBe(1);
    expect(claimed?.deliveredAt).toBeNull();

    expect(
      markDelivered("exec-1", 1, "attempt-1", "2026-08-13T01:00:00.000Z"),
    ).toBe(true);
    const settled = createGraphWorkflowResultDeliveriesRepo(db).findByBoundary(
      PROJECT_PATH,
      SESSION_NAME,
      "exec-1",
      1,
    );
    expect(settled?.state).toBe("delivered");
    expect(settled?.deliveredAt).toBe("2026-08-13T01:00:00.000Z");
    expect(settled?.attemptCount).toBe(1);
  });

  it("counts every claim attempt, so a re-claimed boundary is visible as retried", () => {
    repo.record(delivery({ boundarySeq: 1, state: "pending" }));

    markDelivering("exec-1", 1, "attempt-1");
    repo.resetDeliveringToPending(PROJECT_PATH, SESSION_NAME);
    markDelivering("exec-1", 1, "attempt-2");

    const reloaded = createGraphWorkflowResultDeliveriesRepo(db).findByBoundary(
      PROJECT_PATH,
      SESSION_NAME,
      "exec-1",
      1,
    );
    expect(reloaded?.attemptCount).toBe(2);
    expect(reloaded?.attemptId).toBe("attempt-2");
  });

  // Exactly-once is per ACKNOWLEDGED turn: a turn that died before
  // acknowledgment leaves its claim unsettled, and recovery must re-present the
  // same boundary rather than dropping it.
  it("returns an unacknowledged claim to pending on rehydration recovery", () => {
    repo.record(delivery({ boundarySeq: 1 }));
    repo.record(delivery({ boundarySeq: 2 }));
    markDelivering("exec-1", 1, "attempt-1");
    markDelivering("exec-1", 2, "attempt-1");
    markDelivered("exec-1", 2, "attempt-1", "2026-08-13T01:00:00.000Z");

    expect(repo.resetDeliveringToPending(PROJECT_PATH, SESSION_NAME)).toBe(1);

    const fresh = createGraphWorkflowResultDeliveriesRepo(db);
    expect(
      fresh.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-1", 1)?.state,
    ).toBe("pending");
    expect(
      fresh.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-1", 1)?.attemptId,
    ).toBeNull();
    // A settled delivery is never re-presented.
    expect(
      fresh.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-1", 2)?.state,
    ).toBe("delivered");
  });

  it("refuses to settle a boundary another attempt currently holds", () => {
    repo.record(delivery({ boundarySeq: 1 }));
    markDelivering("exec-1", 1, "attempt-1");

    expect(
      markDelivered("exec-1", 1, "attempt-2", "2026-08-13T01:00:00.000Z"),
    ).toBe(false);
    expect(
      repo.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-1", 1)?.state,
    ).toBe("delivering");
  });

  it("makes duplicate completion settlement idempotent", () => {
    repo.record(delivery({ boundarySeq: 1 }));
    markDelivering("exec-1", 1, "attempt-1");

    expect(
      markDelivered("exec-1", 1, "attempt-1", "2026-08-13T01:00:00Z"),
    ).toBe(true);
    expect(
      markDelivered("exec-1", 1, "attempt-1", "2099-01-01T00:00:00Z"),
    ).toBe(false);
    expect(
      repo.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-1", 1)?.deliveredAt,
    ).toBe("2026-08-13T01:00:00Z");
  });

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

  it("settles halt, resume, and completion boundaries once without re-presenting them", () => {
    repo.record(delivery({ boundarySeq: 1, payload: { status: "halted" } }));
    repo.record(delivery({ boundarySeq: 2, payload: { status: "running" } }));
    repo.record(delivery({ boundarySeq: 3, payload: { status: "completed" } }));

    for (const boundarySeq of [1, 2, 3]) {
      expect(markDelivering("exec-1", boundarySeq, "attempt-lifecycle")).toBe(
        true,
      );
      expect(
        markDelivered(
          "exec-1",
          boundarySeq,
          "attempt-lifecycle",
          "2026-08-13T01:00:00Z",
        ),
      ).toBe(true);
    }

    expect(
      repo.listUndeliveredForConversation(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
      ),
    ).toEqual([]);
    expect(repo.resetDeliveringToPending(PROJECT_PATH, SESSION_NAME)).toBe(0);
  });
});

describe("graph-workflow-result-deliveries-repo scoped reads", () => {
  it("lists a conversation's undelivered boundaries in boundary order", () => {
    repo.record(delivery({ boundarySeq: 3 }));
    repo.record(delivery({ boundarySeq: 1 }));
    repo.record(delivery({ boundarySeq: 2 }));
    markDelivering("exec-1", 2, "attempt-1");
    markDelivered("exec-1", 2, "attempt-1", "2026-08-13T01:00:00.000Z");

    expect(
      repo
        .listUndeliveredForConversation(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
        )
        .map((row) => row.boundarySeq),
    ).toEqual([1, 3]);
  });

  it("never leaks a same-id record from another session into a scoped read", () => {
    seedSession("s2");
    repo.record(delivery({ boundarySeq: 1 }));
    repo.record(delivery({ boundarySeq: 2, sessionName: "s2" }));

    expect(
      repo
        .listUndeliveredForConversation(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
        )
        .map((row) => row.boundarySeq),
    ).toEqual([1]);
    expect(repo.resetDeliveringToPending(PROJECT_PATH, "s2")).toBe(0);
  });

  it("never leaks another conversation's boundaries into a scoped read", () => {
    repo.record(delivery({ boundarySeq: 1 }));
    repo.record(
      delivery({ boundarySeq: 2, originConversationId: "conv-other" }),
    );

    expect(
      repo
        .listUndeliveredForConversation(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
        )
        .map((row) => row.boundarySeq),
    ).toEqual([1]);
  });

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

  it("claims in order and settles an acknowledged attempt idempotently", async () => {
    repo.record(delivery({ boundarySeq: 2 }));
    repo.record(delivery({ boundarySeq: 1 }));
    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    const claimed = await store.claimGraphWorkflowResultDeliveries(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
      "turn-1",
    );

    expect(claimed.map((row) => row.boundarySeq)).toEqual([1, 2]);
    expect(claimed.every((row) => row.state === "delivering")).toBe(true);
    expect(
      await store.settleGraphWorkflowResultDeliveries(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "turn-1",
      ),
    ).toBe(2);
    expect(
      await store.settleGraphWorkflowResultDeliveries(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "turn-1",
      ),
    ).toBe(0);
    expect(
      repo.listUndeliveredForConversation(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
      ),
    ).toEqual([]);
  });

  it("releases only the failed conversation attempt and leaves a peer claim held", async () => {
    repo.record(delivery({ executionId: "exec-origin", boundarySeq: 1 }));
    repo.record(
      delivery({
        executionId: "exec-peer",
        boundarySeq: 2,
        originConversationId: "conv-peer",
      }),
    );
    markDelivering("exec-origin", 1, "shared-attempt-label");
    markDelivering("exec-peer", 2, "shared-attempt-label");
    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    expect(
      await store.releaseGraphWorkflowResultDeliveries(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "shared-attempt-label",
      ),
    ).toBe(1);
    expect(
      repo.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-origin", 1),
    ).toMatchObject({ state: "pending", attemptId: null });
    expect(
      repo.findByBoundary(PROJECT_PATH, SESSION_NAME, "exec-peer", 2),
    ).toMatchObject({
      state: "delivering",
      attemptId: "shared-attempt-label",
    });
  });
});
