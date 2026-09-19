import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
/**
 * Full-composition durability contract for graph lane outcome recording
 * (Phase 3 finding 2). Wires the REAL production stack over a fresh SQLite
 * database:
 *  - the real graph-workflow-executions repository over `createPersistenceFixture`;
 *  - the real `GraphLaneStore` and the real `LaneService` layered on it, both
 *    routed through ONE `mutateActiveExecution` (as production wires them to
 *    `executionRepository.mutateActive`);
 *  - the real `createGraphLaneContinuity` whose `executionRepository` is that
 *    same single critical section.
 *
 * The unit harness (`lane-continuity.test.ts`) pairs an in-memory lane store
 * with an unrelated fake execution repository, so it cannot observe the
 * production two-write path. This contract does, and pins:
 *  (a) recording one outcome performs exactly ONE durable execution mutation;
 *  (b) a newer same-lane value that lands between reads cannot be clobbered by
 *      a stale snapshot mirrored back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGraphWorkflowExecutionsRepo,
  type GraphWorkflowExecutionsRepo,
} from "@/lib/state-store/graph-workflow-executions-repo";
import type { Db } from "@/lib/state-store/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphLaneStore } from "./graph-lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import {
  createGraphLaneContinuity,
  type GraphLaneContinuityDeps,
} from "./lane-continuity";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";

const PROJECT_PATH = "/projects/demo";
const SESSION_NAME = "session-1";
const EXECUTION_ID = "execution-1";
const CONTEXT_ID = "context-plan";
const NOW = "2026-07-12T10:00:00.000Z";

let fixture: PersistenceFixture;
let db: Db;

beforeEach(() => {
  fixture = createPersistenceFixture();
  db = fixture.db;
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

/** A conversation-anchored Claude implementer lane already seeded on the row. */
function seedImplementerLane(): GraphWorkflowAgentSessionState {
  return {
    backend: "claude",
    refKind: "conversation",
    lane: "implementer",
    contextId: CONTEXT_ID,
    workflowConversationId: "conv-implementer-1",
    sessionRef: { backend: "claude", ref: "conv-implementer-1" },
    metrics: {},
    lastUsedAt: NOW,
  };
}

function seedActiveExecution(
  repo: GraphWorkflowExecutionsRepo,
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    id: EXECUTION_ID,
    status: "running",
    laneStates: {
      [CONTEXT_ID]: { implementer: seedImplementerLane() },
    },
  });
  repo.setActive(PROJECT_PATH, SESSION_NAME, execution, NOW);
  return execution;
}

function readActiveFresh(database: Db): GraphWorkflowExecution | null {
  return createGraphWorkflowExecutionsRepo(database).getActive(
    PROJECT_PATH,
    SESSION_NAME,
  );
}

interface Composition {
  continuity: ReturnType<typeof createGraphLaneContinuity>;
  /** Number of durable execution mutations issued through the shared section. */
  writeCount(): number;
  /**
   * Fires `hook` exactly once, immediately after the next durable write
   * completes — modelling a competing same-lane mutation landing between the
   * outcome-recording reads and any second write.
   */
  onceAfterNextWrite(hook: () => Promise<void> | void): void;
}

function buildComposition(database: Db): Composition {
  const repo = createGraphWorkflowExecutionsRepo(database);
  let writes = 0;
  let afterNextWrite: (() => Promise<void> | void) | null = null;

  const mutateActiveExecution: GraphLaneContinuityDeps["executionRepository"]["mutateActive"] =
    async (projectPath, sessionName, fn) => {
      const current = repo.getActive(projectPath, sessionName);
      if (!current) {
        throw new Error(
          `no active execution for ${projectPath}/${sessionName}`,
        );
      }
      const outcome = applyFixtureMutation(current, fn, (next) => {
        writes += 1;
        repo.setActive(
          projectPath,
          sessionName,
          next,
          `2026-07-12T10:00:${String(writes).padStart(2, "0")}.000Z`,
        );
      });
      if (afterNextWrite) {
        const hook = afterNextWrite;
        afterNextWrite = null;
        await hook();
      }
      return outcome;
    };

  const laneService = createLaneService({
    store: createGraphLaneStore({
      listActiveExecutions: async () => repo.listActive(),
      mutateActiveExecution,
    }),
    now: () => NOW,
  });

  const continuity = createGraphLaneContinuity({
    laneService,
    executionRepository: { mutateActive: mutateActiveExecution },
    createConversation: async () => ({ id: "conv-unused" }),
    getConversation: async () => ({
      id: "conv-unused",
      promptCount: 0,
      backendRef: null,
    }),
    now: () => NOW,
  });

  return {
    continuity,
    writeCount: () => writes,
    onceAfterNextWrite(hook) {
      afterNextWrite = hook;
    },
  };
}

describe("graph lane outcome recording — full-composition contract (finding 2)", () => {
  it("persists an unusable continuation and refuses replacement after restart", async () => {
    const execution = seedActiveExecution(
      createGraphWorkflowExecutionsRepo(db),
    );
    await buildComposition(db).continuity.recordLaneTurnOutcome({
      execution,
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
      lane: "implementer",
      outcome: { backend: "claude", continuationDisposition: "clear" },
    });
    const restored = readActiveFresh(db);
    if (!restored) throw new Error("missing execution");
    expect(restored.laneStates[CONTEXT_ID]?.implementer?.staleSession).toBe(
      true,
    );
    expect(
      restored.laneStates[CONTEXT_ID]?.implementer?.workflowConversationId,
    ).toBe("conv-implementer-1");
    await expect(
      buildComposition(db).continuity.resolveImplementerCall({
        execution: restored,
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        contextId: CONTEXT_ID,
        backend: "claude",
      }),
    ).rejects.toThrow(/cannot continue/i);
    expect(
      readActiveFresh(db)?.laneStates[CONTEXT_ID]?.implementer
        ?.workflowConversationId,
    ).toBe("conv-implementer-1");
  });

  it("retains Cursor conversation continuity and unknown occupancy through SQLite reload", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    const lane: GraphWorkflowAgentSessionState = {
      ...seedImplementerLane(),
      backend: "cursor",
      sessionRef: { backend: "cursor", ref: "conv-cursor-1" },
      workflowConversationId: "conv-cursor-1",
    };
    const execution = createWorkflowExecution({
      id: EXECUTION_ID,
      status: "running",
      laneStates: { [CONTEXT_ID]: { implementer: lane } },
    });
    repo.setActive(PROJECT_PATH, SESSION_NAME, execution, NOW);
    await buildComposition(db).continuity.recordLaneTurnOutcome({
      execution,
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
      lane: "implementer",
      outcome: {
        backend: "cursor",
        ref: "opaque-provider-ref",
      },
    });
    const persisted = readActiveFresh(db)?.laneStates[CONTEXT_ID]?.implementer;
    expect(persisted?.backend).toBe("cursor");
    expect(persisted?.sessionRef).toEqual({
      backend: "cursor",
      ref: "conv-cursor-1",
    });
    expect(persisted?.metrics.contextTokens).toBeUndefined();
    expect(persisted?.metrics.contextWindowMax).toBeUndefined();
  });

  it("records one outcome with exactly one durable execution mutation", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    const execution = seedActiveExecution(repo);
    const comp = buildComposition(db);

    const before = comp.writeCount();
    await comp.continuity.recordLaneTurnOutcome({
      execution,
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
      lane: "implementer",
      outcome: {
        backend: "claude",
        contextTokens: 42_000,
        contextWindowMax: 200_000,
      },
    });

    expect(comp.writeCount() - before).toBe(1);

    const persisted = readActiveFresh(db)?.laneStates[CONTEXT_ID]?.implementer;
    expect(persisted?.backend).toBe("claude");
    expect(persisted?.metrics.contextTokens).toBe(42_000);
    expect(persisted?.metrics.contextWindowMax).toBe(200_000);
  });

  it("cannot overwrite a newer same-lane value with a stale mirrored snapshot", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    const execution = seedActiveExecution(repo);
    const comp = buildComposition(db);

    // A competing writer advances the same lane's observed occupancy the instant the
    // outcome's durable write lands. If the recording path issues a second
    // write that mirrors an earlier snapshot back, it clobbers this value.
    comp.onceAfterNextWrite(() => {
      const latest = repo.getActive(PROJECT_PATH, SESSION_NAME);
      if (!latest) throw new Error("missing execution");
      const lane = latest.laneStates[CONTEXT_ID]?.implementer;
      if (!lane || lane.backend !== "claude") {
        throw new Error("missing claude lane");
      }
      repo.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        {
          ...latest,
          laneStates: {
            ...latest.laneStates,
            [CONTEXT_ID]: {
              ...latest.laneStates[CONTEXT_ID],
              implementer: {
                ...lane,
                metrics: { ...lane.metrics, contextTokens: 99_000 },
              },
            },
          },
        },
        "2026-07-12T10:00:59.000Z",
      );
    });

    await comp.continuity.recordLaneTurnOutcome({
      execution,
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
      lane: "implementer",
      outcome: {
        backend: "claude",
        contextTokens: 10_000,
        contextWindowMax: 200_000,
      },
    });

    const persisted = readActiveFresh(db)?.laneStates[CONTEXT_ID]?.implementer;
    expect(persisted?.metrics.contextTokens).toBe(99_000);
  });
});
