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
  createGraphWorkflowArchivedExecutionsRepo,
  type GraphWorkflowArchivedExecutionRow,
  type GraphWorkflowArchivedExecutionsRepo,
} from "./graph-workflow-archived-executions-repo";
import { createSessionsRepo } from "./sessions-repo";
import {
  graphWorkflowExecutionSchema,
  type GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: GraphWorkflowArchivedExecutionsRepo;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

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
  repo = createGraphWorkflowArchivedExecutionsRepo(db);
});

afterEach(() => {
  db.close();
});

function makeExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return graphWorkflowExecutionSchema.parse({
    id: "wf-1",
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 1,
    workingDefinition: {},
    charter: makeTestCharter(),
    status: "completed",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  });
}

function makeRow(
  overrides: Partial<GraphWorkflowArchivedExecutionRow> = {},
): GraphWorkflowArchivedExecutionRow {
  const execution = overrides.execution ?? makeExecution();
  return {
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    executionId: execution.id,
    archivedAt: "2026-01-02T01:00:00Z",
    status: "completed",
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    execution,
    ...overrides,
  };
}

describe("graph-workflow-archived-executions-repo insert + read", () => {
  it("insert then findByExecution round-trips the execution blob", () => {
    const execution = makeExecution({ id: "wf-a" });
    repo.insert(makeRow({ executionId: "wf-a", execution }));

    const out = repo.findByExecution(PROJECT_PATH, SESSION_NAME, "wf-a");
    expect(out).not.toBeNull();
    expect(out).toEqual(execution);
  });

  it("findByExecution returns null for an unknown execution id", () => {
    expect(
      repo.findByExecution(PROJECT_PATH, SESSION_NAME, "missing"),
    ).toBeNull();
  });

  it("listSummariesBySession returns metadata only, newest archived first", () => {
    repo.insert(
      makeRow({
        executionId: "wf-old",
        execution: makeExecution({ id: "wf-old" }),
        archivedAt: "2026-01-01T00:00:00Z",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T05:00:00Z",
      }),
    );
    repo.insert(
      makeRow({
        executionId: "wf-new",
        execution: makeExecution({ id: "wf-new", status: "halted" }),
        status: "halted",
        archivedAt: "2026-02-01T00:00:00Z",
        startedAt: "2026-01-31T00:00:00Z",
        completedAt: null,
      }),
    );

    const summaries = repo.listSummariesBySession(PROJECT_PATH, SESSION_NAME);
    expect(summaries.map((s) => s.executionId)).toEqual(["wf-new", "wf-old"]);
    expect(summaries[0]).toEqual({
      executionId: "wf-new",
      archivedAt: "2026-02-01T00:00:00Z",
      status: "halted",
      startedAt: "2026-01-31T00:00:00Z",
      completedAt: null,
    });
  });

  it("listSummariesBySession isolates by session", () => {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/p2");
    createSessionsRepo(db).upsert("/p2", makeSession({ sessionName: "other" }));

    repo.insert(makeRow({ executionId: "wf-1" }));
    repo.insert(
      makeRow({
        projectPath: "/p2",
        sessionName: "other",
        executionId: "wf-2",
        execution: makeExecution({ id: "wf-2" }),
      }),
    );

    expect(
      repo
        .listSummariesBySession(PROJECT_PATH, SESSION_NAME)
        .map((s) => s.executionId),
    ).toEqual(["wf-1"]);
    expect(
      repo.listSummariesBySession("/p2", "other").map((s) => s.executionId),
    ).toEqual(["wf-2"]);
  });

  it("re-inserting the same key updates the row in place", () => {
    repo.insert(makeRow({ executionId: "wf-1", status: "completed" }));
    repo.insert(
      makeRow({
        executionId: "wf-1",
        status: "halted",
        execution: makeExecution({ id: "wf-1", status: "halted" }),
      }),
    );

    const summaries = repo.listSummariesBySession(PROJECT_PATH, SESSION_NAME);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.status).toBe("halted");
  });
});

describe("graph-workflow-archived-executions-repo cascading-FK invariant", () => {
  it("deleting a session cascades to its archived executions", () => {
    const sessionsRepo = createSessionsRepo(db);
    repo.insert(makeRow({ executionId: "wf-1" }));

    const before = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_workflow_archived_executions WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME) as { n: number }
    ).n;
    expect(before).toBe(1);

    sessionsRepo.delete(PROJECT_PATH, SESSION_NAME);

    const after = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_workflow_archived_executions WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME) as { n: number }
    ).n;
    expect(after).toBe(0);
  });
});

/**
 * Reuses the maximal execution fixture pattern: every introspectable persisted
 * key path of `graphWorkflowExecutionSchema` set to a distinctive non-default
 * value, so the durability harness proves the control-state blob survives the
 * `execution_json` serialization boundary intact.
 */
function buildMaximalExecution(): unknown {
  const execution = {
    id: "wf-maximal",
    seedDefinitionId: "seed-maximal",
    seedDefinitionRevision: 3,
    liveRevision: 4,
    loopEpoch: 2,
    boundInputs: {
      feature: "search box",
      notes: "first line\nsecond line",
    },
    launchedTier: "global",
    workingDefinition: {
      schemaVersion: 2,
      executionContexts: [
        {
          id: "ctx-1",
          title: "Implement the thing",
          description: "Detailed description of the context",
          acceptanceCriteria: "All tests pass and the build is green",
          implementer: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "high",
          },
          contextValidator: {
            type: "claude",
            enabled: true,
            continuity: { enabled: false, contextLimitTokens: 120_000 },
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          scriptValidator: { enabled: true },
          humanApprovalGate: { enabled: true },
          askUserQuestions: { enabled: true },
          mutability: { allowAgentTaskAdd: true },
          circuitBreaker: { consecutiveFailureThreshold: 5 },
          iterationPolicy: {
            maxIterations: 7,
            continuity: { enabled: false, contextLimitTokens: 90_000 },
          },
          collaboration: {
            secondAgent: {
              value: {
                backend: "codex",
                model: "gpt-5.4",
                reasoningEffort: "high",
              },
              source: "per-node",
            },
            negotiationRounds: { value: 5, source: "workflow" },
            autonomousResolutionThreshold: { value: "major", source: "global" },
          },
          charter: makeTestCharter(),
        },
      ],
      tasks: [
        {
          id: "task-1",
          contextId: "ctx-1",
          order: 1,
          title: "First task",
          instructions: "Do the first thing carefully",
          metadata: { area: "backend" },
          source: "agent",
        },
      ],
      edges: [
        { id: "edge-1", sourceContextId: "ctx-1", targetContextId: "ctx-2" },
      ],
    },
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: ["ctx-1"],
    contextStates: {
      "ctx-1": {
        contextId: "ctx-1",
        // Maximal durability entry: the harness only descends into the FIRST
        // context-state record entry, so this one co-populates BOTH parked
        // records (pendingApproval AND pendingUserInput) to prove every
        // persisted key path survives the round-trip — a schema-valid but not
        // runtime-reachable superimposition. `status` uses the user-input value
        // so the widened enum value is exercised on write.
        status: "awaiting_user_input",
        totalTaskCount: 4,
        completedTaskCount: 2,
        iterationCount: 3,
        consecutiveFailureCount: 1,
        worktreePath: "/wt/ctx-1",
        branchName: "csm/ctx-1",
        isolation: "worktree",
        batchId: "batch-1",
        laneId: "lane-1",
        joinId: "join-1",
        mergeStatus: "in-progress",
        cleanupStatus: "pending",
        lastMergeError: "merge conflict in foo.ts",
        pendingApproval: {
          conversationId: "conv-approval-1",
          requestedAt: "2026-01-01T00:00:30.000Z",
          decision: {
            type: "rejected",
            message: "needs more tests before merge",
            decidedAt: "2026-01-01T00:00:45.000Z",
          },
        },
        pendingUserInput: {
          conversationId: "conv-userinput-1",
          lane: "context_validator",
          questionBatchId: "qb-1",
          requestedAt: "2026-01-01T00:01:00.000Z",
          questions: [
            {
              id: "q-1",
              question: "Which storage backend should the cache use?",
              header: "Cache backend",
              context: "Redis adds a dependency; in-memory is simpler.",
              options: [
                {
                  label: "Redis",
                  description: "Shared, survives restarts",
                  recommended: true,
                  tradeoff: {
                    pro: "durable across restarts",
                    con: "adds an external service",
                  },
                },
              ],
              multiSelect: true,
              required: false,
              allowNote: false,
            },
          ],
          answers: {
            byQuestionId: {
              "q-1": {
                selected: ["Redis"],
                note: "use the existing cluster",
                skipped: false,
                question: "Which storage backend should the cache use?",
              },
            },
            answeredAt: "2026-01-01T00:02:00.000Z",
          },
        },
      },
    },
    taskStates: {
      "task-1": {
        taskId: "task-1",
        contextId: "ctx-1",
        order: 1,
        status: "running",
        summary: "implemented the first slice",
        startedAt: "2026-01-02T00:00:00Z",
        completedAt: "2026-01-02T01:00:00Z",
        lastConversationId: "conv-task-1",
        failureMessage: "transient flake on first attempt",
        failureHistory: [
          {
            message: "assertion failed in unit test",
            timestamp: "2026-01-02T00:30:00Z",
          },
        ],
      },
    },
    sharedDocuments: [
      {
        id: "doc-1",
        relativePath: "docs/plan.md",
        description: "the shared plan",
        readWhen: "before implementing",
        kind: "charter",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        lastUpdatedByConversationId: "conv-doc-1",
      },
    ],
    laneStates: {
      "ctx-1": {
        "lane-key-1": {
          lane: "implementer",
          contextId: "ctx-1",
          engine: "claude",
          workflowConversationId: "wf-conv-1",
          sessionRef: {
            engine: "claude",
            lane: "implementer",
            conversationId: "conv-lane-1",
          },
          lastContextTokens: 12_000,
          lastContextWindowMax: 200_000,
          rotateBeforeNextTurn: true,
          limitEvaluation: "supported",
          lastUsedAt: "2026-01-02T02:00:00Z",
        },
      },
    },
    executionLanes: {
      "lane-1": {
        laneId: "lane-1",
        kind: "worktree",
        status: "active",
        worktreePath: "/wt/lane-1",
        branchName: "csm/lane-1",
        includedContextIds: ["ctx-1"],
        lastCommittingContextId: "ctx-1",
        commitSnapshots: [
          {
            contextId: "ctx-1",
            sha: "abc123def456",
            committedAt: "2026-01-02T03:00:00Z",
          },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T03:00:00Z",
      },
    },
    joins: {
      "join-1": {
        joinId: "join-1",
        kind: "context_merge",
        contextId: "ctx-1",
        targetLaneId: "lane-1",
        sourceLaneIds: ["lane-2"],
        mergedSourceLaneIds: ["lane-2"],
        status: "running",
        errorMessage: "retrying merge",
        conflicts: {
          files: ["foo.ts"],
          message: "conflict in foo.ts",
          analysis: [
            {
              file: "foo.ts",
              description: "both sides edited the parser",
              resolution: "keep both hunks",
              rationale: "changes are logically independent",
            },
          ],
        },
        conflictGuidance: [
          { file: "foo.ts", decision: "rejected", feedback: "keep both hunks" },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T04:00:00Z",
        completedAt: "2026-01-02T05:00:00Z",
      },
    },
    lanePlan: {
      continuationMap: { "ctx-1": "ctx-2" },
      longestDownstreamPath: { "ctx-1": 3 },
    },
    machineSnapshot: { value: "running", context: { step: 2 } },
    history: [
      {
        occurredAt: "2026-01-02T06:00:00Z",
        event: {
          type: "graph-workflow-status",
          projectName: "p1",
          sessionName: "full-durable",
          executionId: "wf-maximal",
          workflowStatus: "running",
          activeContextIds: ["ctx-1"],
          activeBatchIds: ["batch-1"],
          activeJoinIds: ["join-1"],
          haltReason: { type: "aborted" },
          pendingHaltReason: { type: "aborted" },
          secondaryHaltReasons: [{ type: "aborted" }],
        },
        preReset: true,
      },
    ],
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-02T07:00:00Z",
    haltReason: {
      type: "max_iterations",
      contextId: "ctx-1",
      iterationCount: 7,
    },
    pendingHaltReason: {
      type: "recovery_error",
      message: "could not recover lane state",
    },
    secondaryHaltReasons: [
      { type: "aborted" },
      {
        type: "agent_turn_failed",
        contextId: "ctx-1",
        engine: "codex",
        cause: "stall",
        message: "Prompt execution stalled: no agent activity for 1200000ms",
      },
    ],
    pendingCollaborations: {
      "collab-1": {
        workflowId: "wf-maximal",
        contextId: "ctx-1",
        conversationId: "conv-collab-1",
        parentImplementerTurnId: "turn-1",
        brief: "resolve the design disagreement",
        startedAt: "2026-01-02T08:00:00Z",
      },
    },
    collaborationContinuations: {
      "ctx-1": [
        {
          workflowId: "wf-maximal",
          brief: "resolve the design disagreement",
          result: {
            status: "rounds_exhausted",
            finalAnswer: "leaning toward the queue-based approach",
            openConflicts: [
              {
                rejectingAgent: "agent_two",
                disputedPoint: "queue vs. polling for the merge step",
                severity: "major",
                category: "implementation",
              },
            ],
          },
          roundsConsumed: 2,
          completedAt: "2026-01-02T09:00:00Z",
          deliveredAt: "2026-01-02T09:05:00Z",
        },
      ],
    },
    pendingMergeRetry: ["ctx-1"],
  };
  return execution;
}

describe("graph-workflow-archived-executions-repo durability contract", () => {
  it("round-trips every persisted execution key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "graph-workflow-archived-executions",
      schema: graphWorkflowExecutionSchema,
      buildMaximalFixture: () =>
        graphWorkflowExecutionSchema.parse(buildMaximalExecution()),
      persist: (fixture) => {
        repo.insert(makeRow({ executionId: fixture.id, execution: fixture }));
        return fixture;
      },
      reload: (expected) =>
        repo.findByExecution(PROJECT_PATH, SESSION_NAME, expected.id),
    });
  });
});
