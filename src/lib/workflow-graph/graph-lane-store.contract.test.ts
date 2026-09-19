import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
/**
 * Durability contract for the graph-workflow lane store (plan §3.2.3, red
 * test for bug §1.9.4): lane continuity state written during a run must
 * survive a process restart. The store reads/writes `execution.laneStates`
 * in place through the real graph-workflow-executions repository over a real
 * SQLite database — a fresh repo + store instance pair over the same
 * database (the restart simulation) must observe exactly the lane state a
 * prior instance wrote. The restart-losing failure mode this pins against:
 * an in-memory projection (the validator's `backendRefCache`, the per-call
 * throwaway lane store) that silently resets on restart.
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
import {
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "./test-fixtures";
import {
  createGraphLaneStore,
  graphLaneId,
  type GraphLaneStoreDeps,
} from "./graph-lane-store";
import type { LaneState } from "@/lib/workflows/primitives/lane-vocabulary";
import type { LaneStore } from "@/lib/workflows/primitives/lane-store";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

const PROJECT_PATH = "/projects/demo";
const SESSION_NAME = "session-1";
const EXECUTION_ID = "execution-1";
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

function seedActiveExecution(
  repo: GraphWorkflowExecutionsRepo,
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    id: EXECUTION_ID,
    status: "running",
    ...overrides,
  });
  repo.setActive(PROJECT_PATH, SESSION_NAME, execution, NOW);
  return execution;
}

/**
 * Builds the store over REAL repo reads/writes — the same durable row the
 * production execution repository mutates. A new invocation of this builder
 * over the same database models a process restart: nothing survives except
 * what the repository persisted.
 */
let writeCounter = 0;

/**
 * Reads the persisted execution through a brand-new repo instance so the
 * assertion observes durable SQLite state, never a repo instance's
 * parsed-row cache.
 */
function readActiveFresh(database: Db): GraphWorkflowExecution | null {
  return createGraphWorkflowExecutionsRepo(database).getActive(
    PROJECT_PATH,
    SESSION_NAME,
  );
}

function buildStore(database: Db): LaneStore {
  const repo = createGraphWorkflowExecutionsRepo(database);
  const deps: GraphLaneStoreDeps = {
    async listActiveExecutions() {
      return repo.listActive();
    },
    async mutateActiveExecution(projectPath, sessionName, fn) {
      const current = repo.getActive(projectPath, sessionName);
      if (!current) {
        throw new Error(
          `no active execution for ${projectPath}/${sessionName}`,
        );
      }
      const outcome = applyFixtureMutation(current, fn, (next) => {
        writeCounter += 1;
        repo.setActive(
          projectPath,
          sessionName,
          next,
          `2026-07-12T10:00:${String(writeCounter).padStart(2, "0")}.000Z`,
        );
      });
      return outcome;
    },
  };
  return createGraphLaneStore(deps);
}

function implementerLane(overrides: Partial<LaneState> = {}): LaneState {
  return {
    workflowId: EXECUTION_ID,
    laneId: graphLaneId("implementer", "context-implement"),
    backend: "claude",
    ref: "conv-implementer-1",
    conversationId: "conv-implementer-1",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    metrics: {},
    lastUsedAt: NOW,
    ...overrides,
  };
}

describe("graph lane store durability contract (§1.9.4)", () => {
  it("lane state written before a restart is read back identically by a fresh store instance over the same database", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);

    const storeBeforeRestart = buildStore(db);
    const written = implementerLane({
      metrics: {
        contextTokens: 42_000,
        contextWindowMax: 200_000,
      },
    });
    await storeBeforeRestart.write(written);

    // Restart: brand-new repo + store instances; only SQLite state survives.
    const storeAfterRestart = buildStore(db);
    const read = await storeAfterRestart.read({
      workflowId: EXECUTION_ID,
      laneId: graphLaneId("implementer", "context-implement"),
    });

    expect(read).not.toBeNull();
    expect(read?.backend).toBe("claude");
    expect(read?.ref).toBe("conv-implementer-1");
    expect(read?.metrics.contextTokens).toBe(42_000);
    expect(read?.metrics.contextWindowMax).toBe(200_000);
  });

  it("a validator lane's conversation anchor survives restart (the backendRefCache failure mode)", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);

    const storeBeforeRestart = buildStore(db);
    await storeBeforeRestart.write(
      implementerLane({
        laneId: graphLaneId("context_validator", "context-implement"),
        backend: "codex",
        ref: "conv-validator-7",
        conversationId: "conv-validator-7",
        writeCapability: "read_only",
        metrics: { lastTurnUsage: null },
      }),
    );

    const storeAfterRestart = buildStore(db);
    const read = await storeAfterRestart.read({
      workflowId: EXECUTION_ID,
      laneId: graphLaneId("context_validator", "context-implement"),
    });
    expect(read?.backend).toBe("codex");
    expect(read?.refKind).toBe("conversation");
    expect(read?.ref).toBe("conv-validator-7");
    expect(read?.conversationId).toBe("conv-validator-7");
  });

  it("scopes lanes per execution context so parallel contexts' implementer lanes do not collide", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);
    const store = buildStore(db);

    await store.write(
      implementerLane({
        laneId: graphLaneId("implementer", "context-plan"),
        ref: "conv-plan",
      }),
    );
    await store.write(
      implementerLane({
        laneId: graphLaneId("implementer", "context-implement"),
        ref: "conv-implement",
      }),
    );

    const planLane = await store.read({
      workflowId: EXECUTION_ID,
      laneId: graphLaneId("implementer", "context-plan"),
    });
    const implementLane = await store.read({
      workflowId: EXECUTION_ID,
      laneId: graphLaneId("implementer", "context-implement"),
    });
    expect(planLane?.ref).toBe("conv-plan");
    expect(implementLane?.ref).toBe("conv-implement");
  });

  it("writes lane state in place on the execution row (graph readers see it under laneStates)", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);
    const store = buildStore(db);

    await store.write(implementerLane());

    const execution = readActiveFresh(db);
    const graphLane = execution?.laneStates["context-implement"]?.implementer;
    expect(graphLane).toMatchObject({
      backend: "claude",
      workflowConversationId: "conv-implementer-1",
      metrics: {},
    });
    expect(graphLane).not.toHaveProperty("sessionRef");
    expect(graphLane).not.toHaveProperty("engine");
    expect(graphLane).not.toHaveProperty("lastContextTokens");
  });

  it("preserves graph-only lane fields (workflowConversationId) across a store write to an existing lane", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo, {
      laneStates: {
        "context-implement": {
          implementer: {
            backend: "claude",
            lane: "implementer",
            contextId: "context-implement",
            workflowConversationId: "cc-conv-distinct",
            metrics: {},
            lastUsedAt: NOW,
          },
        },
      },
    });
    const store = buildStore(db);

    // Same continuity handle: the graph-only field is preserved in place.
    await store.write(implementerLane({ ref: "conv-old" }));
    const preserved =
      readActiveFresh(db)?.laneStates["context-implement"]?.implementer;
    expect(preserved?.workflowConversationId).toBe("cc-conv-distinct");
  });

  it("returns null for a lane that was never written and after delete", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);
    const store = buildStore(db);

    expect(
      await store.read({
        workflowId: EXECUTION_ID,
        laneId: graphLaneId("implementer", "context-plan"),
      }),
    ).toBeNull();

    await store.write(implementerLane());
    await store.delete({
      workflowId: EXECUTION_ID,
      laneId: graphLaneId("implementer", "context-implement"),
    });
    expect(
      await store.read({
        workflowId: EXECUTION_ID,
        laneId: graphLaneId("implementer", "context-implement"),
      }),
    ).toBeNull();
  });

  it("throws on a write whose workflowId does not match any active execution", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);
    const store = buildStore(db);

    await expect(
      store.write(implementerLane({ workflowId: "some-other-execution" })),
    ).rejects.toThrow(/some-other-execution/);
  });

  it("lists all lanes belonging to the execution", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);
    const store = buildStore(db);

    await store.write(
      implementerLane({ laneId: graphLaneId("implementer", "context-plan") }),
    );
    await store.write(
      implementerLane({
        laneId: graphLaneId("context_validator", "context-plan"),
        backend: "codex",
        ref: "thr-1",
        writeCapability: "read_only",
        metrics: { lastTurnUsage: null },
      }),
    );

    const lanes = await store.listByWorkflow(EXECUTION_ID);
    expect(lanes.map((lane) => lane.laneId).sort()).toEqual(
      [
        graphLaneId("context_validator", "context-plan"),
        graphLaneId("implementer", "context-plan"),
      ].sort(),
    );
  });
});

/**
 * R8.1 at the durability layer: two assignments of the same profile reviewing
 * one context are two lanes, not one. The pre-cohort store keyed the inner
 * record by lane KIND, so a second reviewer would have overwritten the first's
 * continuity handle on every write.
 */
describe("per-assignment validator lanes", () => {
  function validatorLane(assignmentId: string, ref: string): LaneState {
    return implementerLane({
      laneId: graphLaneId(
        "context_validator",
        "context-implement",
        assignmentId,
      ),
      backend: "codex",
      ref,
      conversationId: `conv-${assignmentId}`,
      writeCapability: "read_only",
      metrics: { lastTurnUsage: null },
    });
  }

  it("keeps two assignments' continuity handles distinct across a restart", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);

    const store = buildStore(db);
    await store.write(validatorLane("reviewer-a", "conv-reviewer-a"));
    await store.write(validatorLane("reviewer-b", "conv-reviewer-b"));

    const afterRestart = buildStore(db);
    expect(
      (
        await afterRestart.read({
          workflowId: EXECUTION_ID,
          laneId: graphLaneId(
            "context_validator",
            "context-implement",
            "reviewer-a",
          ),
        })
      )?.ref,
    ).toBe("conv-reviewer-a");
    expect(
      (
        await afterRestart.read({
          workflowId: EXECUTION_ID,
          laneId: graphLaneId(
            "context_validator",
            "context-implement",
            "reviewer-b",
          ),
        })
      )?.ref,
    ).toBe("conv-reviewer-b");
  });

  it("persists each assignment under its own laneStates key, carrying its assignment identity", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);
    const store = buildStore(db);

    await store.write(validatorLane("reviewer-a", "conv-reviewer-a"));
    await store.write(validatorLane("reviewer-b", "conv-reviewer-b"));

    const lanes = readActiveFresh(db)?.laneStates["context-implement"];
    expect(Object.keys(lanes ?? {}).sort()).toEqual([
      "context_validator:reviewer-a",
      "context_validator:reviewer-b",
    ]);
    expect(lanes?.["context_validator:reviewer-a"]?.assignmentId).toBe(
      "reviewer-a",
    );
    expect(lanes?.["context_validator:reviewer-b"]?.assignmentId).toBe(
      "reviewer-b",
    );
  });

  it("deletes one assignment's lane without disturbing its sibling", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    seedActiveExecution(repo);
    const store = buildStore(db);

    await store.write(validatorLane("reviewer-a", "conv-reviewer-a"));
    await store.write(validatorLane("reviewer-b", "conv-reviewer-b"));

    await store.delete({
      workflowId: EXECUTION_ID,
      laneId: graphLaneId(
        "context_validator",
        "context-implement",
        "reviewer-a",
      ),
    });

    expect(
      await store.read({
        workflowId: EXECUTION_ID,
        laneId: graphLaneId(
          "context_validator",
          "context-implement",
          "reviewer-a",
        ),
      }),
    ).toBeNull();
    expect(
      (
        await store.read({
          workflowId: EXECUTION_ID,
          laneId: graphLaneId(
            "context_validator",
            "context-implement",
            "reviewer-b",
          ),
        })
      )?.ref,
    ).toBe("conv-reviewer-b");
  });

  it("lists every assignment lane with continuous conversations", async () => {
    const repo = createGraphWorkflowExecutionsRepo(db);
    const execution = createWorkflowExecution({
      id: EXECUTION_ID,
      status: "running",
    });
    const context = execution.workingDefinition.executionContexts.find(
      (candidate) => candidate.id === "context-implement",
    );
    if (!context) throw new Error("fixture context missing");
    context.contextValidator = {
      enabled: true,
      assignments: [
        {
          ...makeSeededValidatorAssignment({ id: "reviewer-a" }),
        },
        {
          ...makeSeededValidatorAssignment({ id: "reviewer-b" }),
        },
      ],
    };
    repo.setActive(PROJECT_PATH, SESSION_NAME, execution, NOW);

    const store = buildStore(db);
    await store.write(validatorLane("reviewer-a", "conv-reviewer-a"));
    await store.write(validatorLane("reviewer-b", "conv-reviewer-b"));

    const lanes = await store.listByWorkflow(EXECUTION_ID);
    const byAssignment = new Map(
      lanes.map((lane) => [lane.laneId, lane.policy]),
    );
    expect(
      byAssignment.get(
        graphLaneId("context_validator", "context-implement", "reviewer-a"),
      ),
    ).toEqual({ continuityEnabled: true });
    expect(
      byAssignment.get(
        graphLaneId("context_validator", "context-implement", "reviewer-b"),
      ),
    ).toEqual({ continuityEnabled: true });
  });
});
