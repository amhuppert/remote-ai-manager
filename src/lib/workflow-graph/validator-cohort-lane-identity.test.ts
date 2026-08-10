/**
 * R8.1: two assignments of the SAME profile reviewing one context are two
 * lanes.
 *
 * Before per-assignment identity, lane state was keyed by lane KIND, so a
 * cohort's second specialist inherited (and then clobbered) the first's
 * continuity handle, conversation anchor, artifacts, and event identity. Every
 * assertion here fails under that keying.
 *
 * The stack is real end to end — the durable `GraphLaneStore` over a real
 * SQLite executions repository, the real lane service, the real lane
 * continuity door, the real validator runner, and the real execution logger
 * writing to a temp config dir. The only fakes are the two things a unit test
 * cannot run: the agent turn and CC conversation creation.
 */
import { WHOLE_TREE_CANDIDATE_SCOPE } from "@/lib/git/diff";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createGraphWorkflowExecutionsRepo,
  type GraphWorkflowExecutionsRepo,
} from "@/lib/state-store/graph-workflow-executions-repo";
import type { Db } from "@/lib/state-store/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { SeededValidatorAssignment } from "@/lib/workflow-graph/config-schemas";
import type { TaskRunResult } from "@/lib/workflows/conversation/execute-workflow-task-run";
import {
  createExecutionLogger,
  registerExecutionLogger,
  unregisterExecutionLogger,
} from "./execution-logger";
import { createGraphLaneContinuity } from "./lane-continuity";
import { createGraphLaneStore } from "./graph-lane-store";
import { assignmentFingerprint, laneStateKey } from "./lane-identity";
import { createValidatorRunner } from "./validator-runner";
import { createGraphWorkflowValidationService } from "./execution-validation";
import {
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "./test-fixtures";

const PROJECT_PATH = "/projects/demo";
const SESSION_NAME = "session-1";
const EXECUTION_ID = "execution-1";
const CONTEXT_ID = "context-plan";
const NOW = "2026-04-01T10:00:00.000Z";

const LANE_A = laneStateKey("context_validator", "reviewer-a");
const LANE_B = laneStateKey("context_validator", "reviewer-b");

let fixture: PersistenceFixture;
let db: Db;
let repo: GraphWorkflowExecutionsRepo;
let logDirRoot: string;
// A real directory: the runner composes each lane's write envelope before
// dispatch, and that composition canonicalizes the candidate worktree and fails
// closed when it cannot resolve.
const worktreeDir = mkdtempSync(path.join(tmpdir(), "cc-cohort-wt-"));

/**
 * Both assignments name the SAME library profile — only the use site differs.
 * Both are blocking, which is what makes `passTurn`'s issues-bearing verdict the
 * shape their lanes are held to.
 */
function cohortOfTwo(): SeededValidatorAssignment[] {
  return ["reviewer-a", "reviewer-b"].map((id) =>
    makeSeededValidatorAssignment({ id, authority: "blocking" }),
  );
}

function seedExecution(): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    id: EXECUTION_ID,
    status: "running",
    activeContextIds: [CONTEXT_ID],
  });
  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === CONTEXT_ID,
  );
  if (!context) throw new Error("fixture context missing");
  context.contextValidator = { enabled: true, assignments: cohortOfTwo() };
  repo.setActive(PROJECT_PATH, SESSION_NAME, execution, NOW);
  return execution;
}

function readExecution(): GraphWorkflowExecution {
  const current = repo.getActive(PROJECT_PATH, SESSION_NAME);
  if (!current) throw new Error("no active execution");
  return current;
}

// Serialized read-modify-write, matching what production guarantees: the real
// `mutateActiveGraphWorkflowExecution` runs its mutate callback inside the write
// queue's critical section, so no two mutations can interleave a read with
// another's write. The cohort dispatches its specialists concurrently and each
// one writes its own lane, so a fixture that let those interleave would lose
// whichever lane wrote first — a fixture artifact, not a behavior of the code
// under test.
let mutationQueue: Promise<void> = Promise.resolve();

const executionRepository = {
  async mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution> {
    const previous = mutationQueue;
    let release!: () => void;
    mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const current = repo.getActive(projectPath, sessionName);
      if (!current) throw new Error("no active execution");
      const next = await fn(current);
      repo.setActive(projectPath, sessionName, next, NOW);
      return next;
    } finally {
      release();
    }
  },
};

function passTurn(): TaskRunResult {
  return {
    kind: "text",
    text: JSON.stringify({ summary: "All good", issues: [], advisories: [] }),
    error: null,
    backendRef: null,
    continuationDisposition: "keep",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costUsd: null,
    },
  } as unknown as TaskRunResult;
}

interface Harness {
  runRound(): Promise<void>;
  createdConversationIds: string[];
  dispatchedConversationIds: string[];
  laneConversationIdsAtDispatch: string[][];
}

function buildHarness(): Harness {
  let conversationCounter = 0;
  const createdConversationIds: string[] = [];
  const dispatchedConversationIds: string[] = [];
  const laneConversationIdsAtDispatch: string[][] = [];

  const continuityService = createGraphLaneContinuity({
    laneService: createLaneService({
      store: createGraphLaneStore({
        async listActiveExecutions() {
          return repo.listActive();
        },
        mutateActiveExecution: executionRepository.mutateActive,
      }),
      now: () => NOW,
    }),
    executionRepository,
    async createConversation() {
      const id = `conv-${++conversationCounter}`;
      createdConversationIds.push(id);
      return { id };
    },
    async getConversation(_projectPath, _sessionName, id) {
      return createdConversationIds.includes(id) ? { id } : null;
    },
    now: () => NOW,
  });

  const runner = createValidatorRunner({
    async resolveWorktreePath() {
      return worktreeDir;
    },
    async resolveTimeoutMs() {
      return 60_000;
    },
    continuityService,
    executionRepository,
    async executeWorkflowTaskRun(input) {
      dispatchedConversationIds.push(input.conversationId);
      // Snapshot the lane bindings a cancellation pass would discover while
      // this turn is in flight.
      laneConversationIdsAtDispatch.push(
        Object.values(readExecution().laneStates[CONTEXT_ID] ?? {})
          .map((lane) => lane.workflowConversationId)
          .filter((id): id is string => id !== undefined),
      );
      return passTurn();
    },
    getProjectDisplayName: () => "demo",
    async computeValidationDiffScope() {
      return {
        kind: "unavailable",
        candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
        reason: "not needed in this test",
      };
    },
    async readLaneConversation() {
      return null;
    },
    async readValidatorConversationTelemetry() {
      return null;
    },
  });

  const validation = createGraphWorkflowValidationService({
    runContextValidator: runner.runContextValidator,
  });

  return {
    createdConversationIds,
    dispatchedConversationIds,
    laneConversationIdsAtDispatch,
    async runRound() {
      const outcome = await validation.validateContextCompletion({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        execution: readExecution(),
        contextId: CONTEXT_ID,
      });
      expect(outcome.kind).toBe("pass");
    },
  };
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  db = fixture.db;
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  repo = createGraphWorkflowExecutionsRepo(db);
  logDirRoot = path.join(tmpdir(), `cc-cohort-lanes-${process.pid}`);
  registerExecutionLogger(
    createExecutionLogger(EXECUTION_ID, {
      configDir: logDirRoot,
      now: () => NOW,
    }),
  );
  seedExecution();
});

afterEach(() => {
  unregisterExecutionLogger(EXECUTION_ID);
  rmSync(logDirRoot, { recursive: true, force: true });
  fixture.close();
  vi.restoreAllMocks();
});

describe("two assignments of one profile in one context (R8.1)", () => {
  it("keeps lane state, continuity, artifacts, and events distinct across two semantic rounds", async () => {
    const harness = buildHarness();

    await harness.runRound();

    // Round 1 — one lane per assignment, each on its own conversation.
    const afterRound1 = readExecution().laneStates[CONTEXT_ID] ?? {};
    expect(Object.keys(afterRound1).sort()).toEqual([LANE_A, LANE_B]);
    expect(afterRound1[LANE_A]?.assignmentId).toBe("reviewer-a");
    expect(afterRound1[LANE_B]?.assignmentId).toBe("reviewer-b");
    // Both lanes are durably stamped with what they baked in, so a later round
    // can tell "same assignment, resume" from "this assignment was edited".
    const [assignmentA, assignmentB] = cohortOfTwo();
    expect(afterRound1[LANE_A]?.assignmentFingerprint).toBe(
      assignmentFingerprint(assignmentA!),
    );
    expect(afterRound1[LANE_B]?.assignmentFingerprint).toBe(
      assignmentFingerprint(assignmentB!),
    );
    const conversationA = afterRound1[LANE_A]?.workflowConversationId;
    const conversationB = afterRound1[LANE_B]?.workflowConversationId;
    expect(conversationA).toBeDefined();
    expect(conversationB).toBeDefined();
    expect(conversationA).not.toBe(conversationB);
    expect(harness.createdConversationIds).toHaveLength(2);

    await harness.runRound();

    // Round 2 — continuity: each assignment resumes ITS OWN conversation, and
    // no third conversation is created.
    const afterRound2 = readExecution().laneStates[CONTEXT_ID] ?? {};
    expect(afterRound2[LANE_A]?.workflowConversationId).toBe(conversationA);
    expect(afterRound2[LANE_B]?.workflowConversationId).toBe(conversationB);
    expect(harness.createdConversationIds).toHaveLength(2);
    expect(harness.dispatchedConversationIds).toEqual([
      conversationA,
      conversationB,
      conversationA,
      conversationB,
    ]);

    // Artifacts — one reviewable trail per specialist, not one overwritten pair.
    const validatorDir = (assignmentId: string) =>
      path.join(
        logDirRoot,
        "workflow-logs",
        EXECUTION_ID,
        "contexts",
        CONTEXT_ID,
        "validators",
        assignmentId,
      );
    for (const assignmentId of ["reviewer-a", "reviewer-b"]) {
      expect(
        existsSync(
          path.join(validatorDir(assignmentId), "context-validator.md"),
        ),
        `${assignmentId} prompt`,
      ).toBe(true);
      expect(
        existsSync(
          path.join(validatorDir(assignmentId), "context-validator.json"),
        ),
        `${assignmentId} response`,
      ).toBe(true);
    }

    // Events — every verdict names the specialist that rendered it.
    const validationEvents = readFileSync(
      path.join(
        logDirRoot,
        "workflow-logs",
        EXECUTION_ID,
        "contexts",
        CONTEXT_ID,
        "validation.jsonl",
      ),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === "validator.result_parsed");
    expect(validationEvents.map((entry) => entry.assignmentId)).toEqual([
      "reviewer-a",
      "reviewer-b",
      "reviewer-a",
      "reviewer-b",
    ]);
  });

  it("exposes both assignments' lane conversations to cancellation while a turn is in flight", async () => {
    const harness = buildHarness();
    await harness.runRound();

    // The second dispatch happens with BOTH lanes bound, so an abort pass
    // sweeping laneStates finds every specialist's conversation — the widened
    // key space is iterated, not just the first entry.
    const [, boundDuringSecondDispatch] = harness.laneConversationIdsAtDispatch;
    const lanes = readExecution().laneStates[CONTEXT_ID] ?? {};
    expect(boundDuringSecondDispatch).toEqual(
      expect.arrayContaining([
        lanes[LANE_A]?.workflowConversationId,
        lanes[LANE_B]?.workflowConversationId,
      ]),
    );
    expect(new Set(boundDuringSecondDispatch).size).toBe(2);
  });

  it("cancelling one assignment's lane leaves its sibling's lane and continuity untouched", async () => {
    const harness = buildHarness();
    await harness.runRound();

    const before = readExecution().laneStates[CONTEXT_ID] ?? {};
    expect(Object.keys(before).sort()).toEqual([LANE_A, LANE_B]);
    const survivingLane = before[LANE_B];
    expect(survivingLane).toBeDefined();

    // Retire exactly one assignment's lane, as a per-assignment cancel does.
    await executionRepository.mutateActive(
      PROJECT_PATH,
      SESSION_NAME,
      (execution) => {
        const contextLanes = { ...execution.laneStates[CONTEXT_ID] };
        delete contextLanes[LANE_A];
        return {
          ...execution,
          laneStates: { ...execution.laneStates, [CONTEXT_ID]: contextLanes },
        };
      },
    );

    const after = readExecution().laneStates[CONTEXT_ID] ?? {};
    expect(after[LANE_A]).toBeUndefined();
    expect(after[LANE_B]).toEqual(survivingLane);

    // The sibling still resumes its own conversation on the next round, while
    // the retired assignment starts a fresh one.
    await harness.runRound();
    const resumed = readExecution().laneStates[CONTEXT_ID] ?? {};
    expect(resumed[LANE_B]?.workflowConversationId).toBe(
      survivingLane?.workflowConversationId,
    );
    expect(resumed[LANE_A]?.workflowConversationId).not.toBe(
      before[LANE_A]?.workflowConversationId,
    );
    expect(harness.createdConversationIds).toHaveLength(3);
  });
});
