/**
 * R3.3 — a pre-existing workflow still behaves the way it did, after the
 * cutover migrated it.
 *
 * No definition here is hand-authored in the post-cutover shape. The fixture is
 * a legacy `config.json` and a legacy definition document written to disk as an
 * operator's disk actually held them; the real migration rewrites them; and the
 * bytes the migration produced are the sole source of the working definition
 * every run below drives. They travel the whole production chain — raw config
 * parse, `materializeGlobalConfig`, the definition-record schema, the config
 * cascade, snapshot seeding against the real profile library — and end up on an
 * execution the real iteration orchestrator runs. A migration that produced
 * plausible but subtly different bytes therefore fails here rather than in
 * production. (The one post-cutover literal is the comparator in the first
 * test: what an operator authoring this reviewer today would write.)
 *
 * The three claims, and what each is measured against:
 *
 *  1. ONE reviewer invocation per round. The legacy singleton ran exactly once
 *     per round by construction, so the migrated cohort must dispatch exactly
 *     once and that dispatch must be the `general` seat.
 *  2. Accounting unchanged. The per-round deltas are pinned as
 *     {@link PRE_CUTOVER_ACCOUNTING} — a validation round charges one
 *     consecutive failure and consumes no iteration slot — and the breaker
 *     ceiling is read back out of the LEGACY fixture rather than re-declared,
 *     so a migration that dropped or defaulted the operator's threshold moves
 *     the round the breaker trips on.
 *  3. Continuity carried across rounds. Proven in the second describe below,
 *     against a real SQLite executions repository and the real lane-continuity
 *     door rather than against the assignment record: round two must dispatch
 *     into the conversation round one opened, and open no other. Reading the
 *     same `continuity` object twice out of one immutable definition would
 *     prove nothing, so nothing here does that.
 *
 * The pre-cutover engine itself is gone (hard cutover, no inbound compatibility
 * parser), so claim 2's per-round deltas cannot be produced by running it. They
 * are stated as constants for that reason, and the negative control for them is
 * `validation-cohort-engine.test.ts`'s cohort-vs-solo differential (R5.2), which
 * proves the same deltas are cohort-size invariant.
 */
import { WHOLE_TREE_CANDIDATE_SCOPE } from "@/lib/git/diff";

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type BetterSqlite3 from "better-sqlite3";

import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { materializeGlobalConfig } from "@/lib/config/loader";
import { rawGlobalConfigSchema } from "@/lib/config/schemas";
import {
  createGraphWorkflowExecutionsRepo,
  type GraphWorkflowExecutionsRepo,
} from "@/lib/state-store/graph-workflow-executions-repo";
import { workflowAgentAssignments } from "@/lib/state-store/migrations/0011-workflow-agent-assignments";
import { runMigrations } from "@/lib/state-store/migrator";
import { _createTestDbAtPath } from "@/lib/state-store/state-db";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { TaskRunResult } from "@/lib/workflows/conversation/execute-workflow-task-run";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createGraphWorkflowValidationService } from "@/lib/workflow-graph/execution-validation";
import { createGraphLaneStore } from "@/lib/workflow-graph/graph-lane-store";
import { createGraphLaneContinuity } from "@/lib/workflow-graph/lane-continuity";
import { createValidatorRunner } from "@/lib/workflow-graph/validator-runner";
import { resolveConsecutiveFailureThreshold } from "@/lib/workflow-graph/constants";
import type {
  SeededValidatorAssignment,
  ValidatorAssignment,
} from "@/lib/workflow-graph/config-schemas";
import {
  workflowDefinitionRecordSchema,
  type ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  assignmentFingerprint,
  laneStateKey,
} from "@/lib/workflow-graph/lane-identity";
import {
  buildInitialContextStates,
  buildInitialTaskStates,
} from "@/lib/workflow-graph/execution-state";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import { validateResolvedWorkflow } from "@/lib/workflow-graph/validation";
import { seedAssignmentSnapshots } from "@/lib/workflow-graph/seed-assignment-snapshots";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
  makeValidatorAssignment,
} from "@/lib/workflow-graph/test-fixtures";
import {
  createHarness,
  failResult,
  metadata,
  passResult,
  type Harness,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";

const PROJECT_PATH = "/repos/legacy-workflows";
const SCOPE_KEY = Buffer.from(PROJECT_PATH).toString("base64url");
const WORKFLOW_ID = "wf-legacy";
const CONTEXT_ID = "context-plan";
const TASK_ID = "task-plan-1";

/**
 * The exact runtime the legacy reviewer declared. Deliberately NOT the seeded
 * default (`sonnet`/`medium`): a migration that re-derived the runtime instead
 * of copying it verbatim would land on the default and pass a weaker fixture.
 */
const LEGACY_VALIDATOR_AGENT = {
  backend: "claude",
  model: "sonnet",
  reasoningEffort: "high",
} as const;

/** Likewise non-default, so an invented continuity policy is visible. */
const LEGACY_VALIDATOR_CONTINUITY = {
  enabled: true,
  contextLimitTokens: 90_000,
} as const;

/**
 * The operator's own breaker ceiling, distinct from
 * `DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD` (3) so a migration that dropped the
 * field would trip the breaker a round early rather than silently agreeing
 * with the default.
 */
const LEGACY_FAILURE_THRESHOLD = 4;

/**
 * What one semantic validation round cost before the cutover, and must still
 * cost after it. A rejection charges the streak; the validation-only re-entry
 * seeds no implementer turn, so it consumes no iteration slot.
 */
const PRE_CUTOVER_ACCOUNTING = {
  consecutiveFailureDeltaPerRejectedRound: 1,
  iterationDeltaPerValidationRound: 0,
  reviewerInvocationsPerRound: 1,
} as const;

const openDbs: InstanceType<typeof BetterSqlite3>[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  The pre-cutover disk                                               */
/* ------------------------------------------------------------------ */

function legacyConfigJson(): Record<string, unknown> {
  return {
    baseDir: "/repos",
    agentBackends: {
      claude: { model: "opus", reasoningEffort: "high", timeoutMs: 3_600_000 },
      codex: { fastMode: false, timeoutMs: null },
    },
    defaultAgentBackend: "claude",
    workflowDefaults: {
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
      contextValidator: {
        type: "claude",
        enabled: true,
        continuity: { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      scriptValidator: { commands: [] },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      iterationPolicy: { maxIterations: 12, continuity: { enabled: true } },
      circuitBreaker: { consecutiveFailureThreshold: 3 },
      mutability: { allowAgentTaskAdd: false },
    },
  };
}

/**
 * A real definition record with its two agent-config fields rewritten back to
 * the singleton forms — the same construction the migration's own fixtures use,
 * so everything the cutover does NOT touch stays schema-valid and the legacy
 * shapes are the only difference.
 */
function legacyDefinitionRecord(): Record<string, unknown> {
  const record = JSON.parse(
    JSON.stringify(
      createWorkflowDefinitionRecord({ id: WORKFLOW_ID, name: "Legacy" }),
    ),
  ) as Record<string, unknown>;

  const definition = record.definition as Record<string, unknown>;
  definition.executionContexts = (
    definition.executionContexts as Record<string, unknown>[]
  ).map((context) => {
    const legacy: Record<string, unknown> = {
      ...context,
      // Pre-`backend` implementer triples, as the field existed pre-cutover.
      implementer: { backend: "claude", model: "opus", reasoningEffort: "max" },
      contextValidator: {
        kind: "use",
        value: {
          type: "claude",
          enabled: true,
          continuity: { ...LEGACY_VALIDATOR_CONTINUITY },
          agent: { ...LEGACY_VALIDATOR_AGENT },
        },
      },
    };
    if (context.id === CONTEXT_ID) {
      legacy.circuitBreaker = {
        consecutiveFailureThreshold: LEGACY_FAILURE_THRESHOLD,
      };
    }
    return legacy;
  });

  return record;
}

interface LegacyDisk {
  configDir: string;
  db: InstanceType<typeof BetterSqlite3>;
}

function seedLegacyDisk(): LegacyDisk {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "cc-r33-"));
  tempDirs.push(configDir);

  // The DB opens first: the one-time legacy-workflow purge in `openStateDb`
  // quarantines a pre-existing `workflows/` directory on a database's first
  // open, and a real operator's disk recorded that marker long ago.
  const db = _createTestDbAtPath(path.join(configDir, "command-center.db"));
  openDbs.push(db);

  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(legacyConfigJson(), null, 2),
    "utf-8",
  );

  const scopeDir = path.join(configDir, "workflows", SCOPE_KEY);
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(
    path.join(scopeDir, `${WORKFLOW_ID}.json`),
    JSON.stringify(legacyDefinitionRecord(), null, 2),
    "utf-8",
  );

  return { configDir, db };
}

/* ------------------------------------------------------------------ */
/*  Cutover, then the production load chain over what it produced      */
/* ------------------------------------------------------------------ */

/**
 * Run the real migration and resolve what it wrote, exactly as a start would:
 * raw config parse -> materialize -> definition-record schema -> config
 * cascade -> snapshot seeding against the real library.
 *
 * The profile storage is pinned to the temp config dir. Built-ins resolve from
 * code, so this fixture never needs a stored profile — the pin is there so a
 * reference that WASN'T built-in would fail closed instead of reaching the
 * operator's live library.
 */
async function migrateAndResolve(
  disk: LegacyDisk,
): Promise<ResolvedWorkflowSemanticDefinition> {
  const applied = await runMigrations(
    { db: disk.db, configDir: disk.configDir },
    [workflowAgentAssignments],
  );
  expect(applied).toContain("0011-workflow-agent-assignments");

  const rawConfig = rawGlobalConfigSchema.parse(
    JSON.parse(
      readFileSync(path.join(disk.configDir, "config.json"), "utf-8"),
    ) as unknown,
  );
  const globalConfig = materializeGlobalConfig(rawConfig);

  // Parsing the migrated document against the post-cutover schema is itself
  // part of the proof: legacy shapes are refused there, so a document that
  // still held one could not reach the cascade.
  const record = workflowDefinitionRecordSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(
          disk.configDir,
          "workflows",
          SCOPE_KEY,
          `${WORKFLOW_ID}.json`,
        ),
        "utf-8",
      ),
    ) as unknown,
  );

  const resolved = await seedAssignmentSnapshots(
    resolveWorkflowDefinition(globalConfig, record.definition),
    {
      library: createAgentProfileLibraryService({
        storage: createAgentProfileStorage({
          resolveConfigDir: () => disk.configDir,
        }),
      }),
      projectPath: PROJECT_PATH,
    },
  );

  // The gate execution start puts between seeding and the first context state
  // (`execution-repository.ts`). A migrated definition that failed it could not
  // be launched at all, so clearing it is part of "still behaves the way it
  // did" rather than a detail of this fixture.
  const gate = validateResolvedWorkflow(resolved);
  expect(gate.ok, JSON.stringify(gate.ok ? [] : gate.errors)).toBe(true);

  return resolved;
}

/**
 * An execution mid-run in `context-plan`: its single task is done, so the next
 * pass is the validation-only re-entry the round machinery owns.
 */
function executionOver(
  definition: ResolvedWorkflowSemanticDefinition,
  options: { consecutiveFailureCount?: number } = {},
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    status: "running",
    activeContextIds: [CONTEXT_ID],
    workingDefinition: definition,
    // Derived from the migrated definition by the same builders execution
    // start uses, so the runtime state under test belongs to the migrated
    // workflow rather than to the fixture's own defaults.
    contextStates: buildInitialContextStates(definition),
    taskStates: buildInitialTaskStates(definition),
  });
  execution.contextStates[CONTEXT_ID] = {
    ...execution.contextStates[CONTEXT_ID]!,
    status: "running",
    completedTaskCount: 1,
    iterationCount: 2,
    consecutiveFailureCount: options.consecutiveFailureCount ?? 0,
  };
  execution.taskStates[TASK_ID] = {
    ...execution.taskStates[TASK_ID]!,
    status: "completed",
    summary: "Documented the plan.",
    completedAt: "2026-08-04T11:00:00.000Z",
  };
  return execution;
}

/** The implementer's remediation, so the next round has a candidate to review. */
async function remediate(harness: Harness): Promise<void> {
  await harness.repository.mutateActive(PROJECT_PATH, "session-1", (latest) => {
    const next = structuredClone(latest);
    next.taskStates[TASK_ID] = {
      ...next.taskStates[TASK_ID]!,
      status: "completed",
      summary: "Addressed the review.",
      completedAt: "2026-08-04T11:30:00.000Z",
      failureMessage: null,
    };
    next.contextStates[CONTEXT_ID] = {
      ...next.contextStates[CONTEXT_ID]!,
      status: "running",
      completedTaskCount: 1,
    };
    return next;
  });
}

function migratedCohort(
  definition: ResolvedWorkflowSemanticDefinition,
): SeededValidatorAssignment[] {
  const context = definition.executionContexts.find(
    (entry) => entry.id === CONTEXT_ID,
  );
  if (context === undefined) throw new Error(`${CONTEXT_ID} did not survive`);
  return [...context.contextValidator.assignments];
}

/* ------------------------------------------------------------------ */
/*  The proof                                                          */
/* ------------------------------------------------------------------ */

describe("a migrated pre-existing workflow reviews the way it always did (R3.3)", () => {
  it("lands on exactly the cohort an operator would author today", async () => {
    const definition = await migrateAndResolve(seedLegacyDisk());
    const context = definition.executionContexts.find(
      (entry) => entry.id === CONTEXT_ID,
    );

    expect(context?.contextValidator.enabled).toBe(true);

    // Structural equivalence, not merely "a cohort of one": the migrated seat
    // must carry the operator's runtime and continuity verbatim onto the
    // built-in reviewer profile.
    const authoredToday: ValidatorAssignment = makeValidatorAssignment({
      strategy: "conversation",
      // Blocking, because the seat an operator gets today for acceptance-criteria
      // verification is the seeded blocking one — the migrated legacy validator
      // must land on it rather than on the advisory default.
      authority: "blocking",
      agent: { ...LEGACY_VALIDATOR_AGENT },
      continuity: { ...LEGACY_VALIDATOR_CONTINUITY },
    });
    const migrated = migratedCohort(definition);
    expect(migrated).toHaveLength(1);
    const { profileSnapshot, ...withoutSnapshot } = migrated[0]!;
    expect(withoutSnapshot).toEqual(authoredToday);
    expect(profileSnapshot.tier).toBe("builtin");
    expect(profileSnapshot.id).toBe("general-reviewer");
    // Resolved through the real composer, not stamped: the bytes the lane will
    // replay are present and the hash that covers them was computed here.
    expect(profileSnapshot.renderedInstructionBlock.length).toBeGreaterThan(0);
    expect(profileSnapshot.resolvedInstructionHash.length).toBeGreaterThan(0);
  });

  it("dispatches one reviewer per round, and it is the migrated general seat", async () => {
    const definition = await migrateAndResolve(seedLegacyDisk());
    const harness = createHarness({
      execution: executionOver(definition),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    expect(harness.runContextValidator).toHaveBeenCalledTimes(
      PRE_CUTOVER_ACCOUNTING.reviewerInvocationsPerRound,
    );
    const dispatched = harness.runContextValidator.mock.calls[0]![0].validator;
    expect(dispatched.id).toBe("general");
    expect(dispatched.profile).toEqual({
      tier: "builtin",
      id: "general-reviewer",
    });
    expect(dispatched.agent).toEqual(LEGACY_VALIDATOR_AGENT);
  });

  it("charges one consecutive failure and no iteration for a rejected round", async () => {
    const definition = await migrateAndResolve(seedLegacyDisk());
    const execution = executionOver(definition);
    const iterationsBefore =
      execution.contextStates[CONTEXT_ID]!.iterationCount;
    const failuresBefore =
      execution.contextStates[CONTEXT_ID]!.consecutiveFailureCount;

    const harness = createHarness({
      execution,
      runContextValidator: async (input) => ({
        result: failResult(input.validator.id, [TASK_ID]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const state = harness.contextState();
    expect(state?.consecutiveFailureCount).toBe(
      failuresBefore +
        PRE_CUTOVER_ACCOUNTING.consecutiveFailureDeltaPerRejectedRound,
    );
    expect(state?.iterationCount).toBe(
      iterationsBefore +
        PRE_CUTOVER_ACCOUNTING.iterationDeltaPerValidationRound,
    );
  });

  it("clears the streak on a passing round, as a single reviewer's pass did", async () => {
    const definition = await migrateAndResolve(seedLegacyDisk());
    const harness = createHarness({
      execution: executionOver(definition, { consecutiveFailureCount: 2 }),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    expect(harness.contextState()?.consecutiveFailureCount).toBe(0);
  });

  it("trips the breaker on the round the operator's own threshold names", async () => {
    const disk = seedLegacyDisk();
    const definition = await migrateAndResolve(disk);

    // Read back rather than re-declared: this is the pre-migration document's
    // ceiling, and the assertion is that the cutover carried it.
    const context = definition.executionContexts.find(
      (entry) => entry.id === CONTEXT_ID,
    );
    const threshold = resolveConsecutiveFailureThreshold(
      context?.circuitBreaker,
    );
    expect(threshold).toBe(LEGACY_FAILURE_THRESHOLD);

    const harness = createHarness({
      execution: executionOver(definition),
      runContextValidator: async (input) => ({
        result: failResult(input.validator.id, [TASK_ID]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    // One rejected round per iteration of this loop; the breaker must survive
    // exactly `threshold - 1` of them and halt on the threshold'th.
    for (let round = 1; round < threshold; round += 1) {
      await harness.run();
      expect(harness.repository.read().status).toBe("running");
      expect(harness.contextState()?.consecutiveFailureCount).toBe(round);
      await remediate(harness);
    }
    await harness.run();

    const halted = harness.repository.read();
    expect(halted.status).toBe("halted");
    expect(halted.haltReason).toMatchObject({
      type: "circuit_breaker",
      contextId: CONTEXT_ID,
      condition: "retry_exhaustion",
      failureCount: threshold,
    });
    expect(harness.runContextValidator).toHaveBeenCalledTimes(
      threshold * PRE_CUTOVER_ACCOUNTING.reviewerInvocationsPerRound,
    );
  });
});

/**
 * Continuity, proven where it actually lives.
 *
 * The accounting proofs above fake the whole validator dispatch, which is the
 * right boundary for counting invocations but stops short of the machinery that
 * decides whether round two RESUMES round one. Continuity is not a property of
 * the assignment record — reading the same `continuity` object out of the same
 * immutable definition twice proves nothing. It is a property of the lane the
 * continuity door opens and the executions repository persists.
 *
 * So this stack is real end to end: a real SQLite executions repository, the
 * real `GraphLaneStore`, the real lane service, the real lane-continuity door,
 * the real validator runner, and the real validation service. Only the two
 * things a test cannot run are faked — the agent turn and CC conversation
 * creation — and both are observed, so the assertions read what production
 * persisted rather than what the fixture handed in.
 *
 * `continuity.enabled` from the migrated bytes is what drives this:
 * `getLaneContinuityEnabled` reads it off the working definition's assignment,
 * and a `false` there makes every round create a fresh conversation.
 */
describe("a migrated reviewer resumes its own session across rounds (R3.3)", () => {
  const NOW = "2026-08-04T12:00:00.000Z";
  const SESSION_NAME = "session-1";
  const LANE_KEY = laneStateKey("context_validator", "general");

  let fixture: PersistenceFixture;
  let repo: GraphWorkflowExecutionsRepo;

  afterEach(() => {
    fixture?.close();
  });

  /**
   * Serialized read-modify-write, matching what production guarantees: the real
   * `mutateActiveGraphWorkflowExecution` runs its callback inside the write
   * queue's critical section.
   */
  function executionRepositoryOver(): {
    mutateActive(
      projectPath: string,
      sessionName: string,
      fn: (
        execution: GraphWorkflowExecution,
      ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
    ): Promise<GraphWorkflowExecution>;
  } {
    let queue: Promise<void> = Promise.resolve();
    return {
      async mutateActive(projectPath, sessionName, fn) {
        const previous = queue;
        let release!: () => void;
        queue = new Promise<void>((resolve) => {
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
  }

  function readExecution(): GraphWorkflowExecution {
    const current = repo.getActive(PROJECT_PATH, SESSION_NAME);
    if (!current) throw new Error("no active execution");
    return current;
  }

  /** The reviewer's turn: a well-formed verdict, and nothing else. */
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

  async function buildLiveStack(
    definition: ResolvedWorkflowSemanticDefinition,
  ) {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    repo = createGraphWorkflowExecutionsRepo(fixture.db);
    repo.setActive(PROJECT_PATH, SESSION_NAME, executionOver(definition), NOW);

    const executionRepository = executionRepositoryOver();
    let conversationCounter = 0;
    const createdConversationIds: string[] = [];
    const dispatchedConversationIds: string[] = [];

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
        const id = `conv-${(conversationCounter += 1)}`;
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
        return "/repo/worktree";
      },
      async resolveTimeoutMs() {
        return 60_000;
      },
      continuityService,
      executionRepository,
      // The external agent boundary — the ONE thing stubbed.
      async executeWorkflowTaskRun(input) {
        dispatchedConversationIds.push(input.conversationId);
        return passTurn();
      },
      getProjectDisplayName: () => "legacy-workflows",
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
      composeLaneWriteEnvelope: () => ({
        policy: {
          mode: "allowlist",
          allowWrite: ["/tmp/validator-lane", "/tmp/validator-lane/tmp"],
          denyWrite: ["/repo/worktree"],
        },
        laneScratchDir: "/tmp/validator-lane",
        laneTmpDir: "/tmp/validator-lane/tmp",
      }),
    });

    const validation = createGraphWorkflowValidationService({
      runContextValidator: runner.runContextValidator,
    });

    return {
      createdConversationIds,
      dispatchedConversationIds,
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

  it("reuses round one's conversation in round two instead of opening a new one", async () => {
    const definition = await migrateAndResolve(seedLegacyDisk());
    const stack = await buildLiveStack(definition);

    await stack.runRound();

    // Round 1 opened exactly one lane, under the migrated seat's key, and the
    // repository persisted it.
    const afterRound1 = readExecution().laneStates[CONTEXT_ID] ?? {};
    expect(Object.keys(afterRound1)).toEqual([LANE_KEY]);
    const conversationId = afterRound1[LANE_KEY]?.workflowConversationId;
    expect(conversationId).toBeDefined();
    expect(stack.createdConversationIds).toEqual([conversationId]);

    await stack.runRound();

    // Round 2 dispatched into the SAME conversation and opened no other. This
    // is the claim: the migrated reviewer resumed its own session.
    expect(stack.dispatchedConversationIds).toEqual([
      conversationId,
      conversationId,
    ]);
    expect(stack.createdConversationIds).toEqual([conversationId]);
    const afterRound2 = readExecution().laneStates[CONTEXT_ID] ?? {};
    expect(Object.keys(afterRound2)).toEqual([LANE_KEY]);
    expect(afterRound2[LANE_KEY]?.workflowConversationId).toBe(conversationId);
  });

  it("stamps the lane with the migrated assignment's own continuity policy", async () => {
    const definition = await migrateAndResolve(seedLegacyDisk());
    const stack = await buildLiveStack(definition);

    await stack.runRound();

    // The fingerprint folds in `continuity.contextLimitTokens` and the runtime
    // triple, so a lane read back OUT of SQLite carrying the migrated
    // assignment's fingerprint is durable evidence that the lane baked in the
    // legacy document's continuity policy — not two derivations of one object.
    const [migrated] = migratedCohort(definition);
    expect(migrated?.continuity).toEqual(LEGACY_VALIDATOR_CONTINUITY);
    const lane = readExecution().laneStates[CONTEXT_ID]?.[LANE_KEY];
    expect(lane?.assignmentId).toBe("general");
    expect(lane?.assignmentFingerprint).toBe(assignmentFingerprint(migrated!));
  });
});
