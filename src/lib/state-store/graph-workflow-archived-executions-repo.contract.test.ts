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
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createStateStore } from "./store";
import { createWriteQueue } from "./write-queue";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  buildMaximalGraphWorkflowExecution,
  buildMaximalLaunchDocument,
} from "@/lib/shared/testing/graph-workflow-execution-fixture";
import {
  canonicalValuesAtPath,
  collectValuesAtPath,
  isEmptyForFixture,
  D4_PERSISTED_FIELDS,
  stripD4PersistedFields,
} from "@/lib/shared/testing/d4-persisted-field-inventory";
import { projectExecutionTierFloor } from "@/lib/workflow-graph/compat/floor";
import {
  validateJsonSchemaSubset,
  validateOutputSchemaDeclaration,
} from "@/lib/workflows/primitives/output-schema-subset";

type Db = InstanceType<typeof Database>;

function makeMaximalCharter(): ReturnType<typeof makeTestCharter> {
  const charter = makeTestCharter();
  const [firstInvariant, ...remainingInvariants] = charter.invariants ?? [];
  if (firstInvariant === undefined) {
    throw new Error("Maximal charter fixture requires an invariant");
  }

  return {
    ...charter,
    invariants: [
      {
        ...firstInvariant,
        appliesTo: { contextIds: ["ctx-1"] },
      },
      ...remainingInvariants,
    ],
  };
}

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
    origin: {
      kind: "template",
      definitionId: "seed-1",
      definitionRevision: 1,
      tier: "project",
    },
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

  it("findByExecutionId reads an archived execution without session coordinates", () => {
    const execution = makeExecution({ id: "wf-global" });
    repo.insert(makeRow({ executionId: execution.id, execution }));

    expect(repo.findByExecutionId(execution.id)).toEqual(execution);
    expect(repo.findByExecutionId("missing")).toBeNull();
  });

  it("findStatusByExecutionId reads the archived status without session context", () => {
    repo.insert(
      makeRow({
        executionId: "wf-aborted",
        execution: makeExecution({
          id: "wf-aborted",
          status: "aborted",
          completedAt: null,
        }),
        status: "aborted",
        completedAt: null,
      }),
    );

    expect(repo.findStatusByExecutionId("wf-aborted")).toBe("aborted");
    expect(repo.findStatusByExecutionId("never-archived")).toBeNull();
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

describe("active-or-archived execution accessor", () => {
  it("finds a running physical active row and a terminal row still occupying Current", async () => {
    const store = createStateStore({ db, writeQueue: createWriteQueue() });
    const running = makeExecution({
      id: "wf-current",
      status: "running",
      completedAt: null,
    });
    await store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seed-current",
      () => ({ execution: running, events: [] }),
    );

    expect(
      await store.getGraphWorkflowExecutionById(
        PROJECT_PATH,
        SESSION_NAME,
        running.id,
      ),
    ).toEqual(running);

    const completed = makeExecution({ id: running.id, status: "completed" });
    await store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.complete-in-place",
      () => ({ execution: completed, events: [] }),
    );
    expect(
      await store.getGraphWorkflowExecutionById(
        PROJECT_PATH,
        SESSION_NAME,
        completed.id,
      ),
    ).toEqual(completed);
  });

  it("falls back to a fully scoped archived row and refuses scope mismatch", async () => {
    const store = createStateStore({ db, writeQueue: createWriteQueue() });
    const archived = makeExecution({ id: "wf-history" });
    repo.insert(makeRow({ executionId: archived.id, execution: archived }));

    expect(
      await store.getGraphWorkflowExecutionById(
        PROJECT_PATH,
        SESSION_NAME,
        archived.id,
      ),
    ).toEqual(archived);
    expect(
      await store.getGraphWorkflowExecutionById(
        PROJECT_PATH,
        "other-session",
        archived.id,
      ),
    ).toBeNull();
  });
});

describe("graph-workflow-archived-executions-repo pre-D4 floor", () => {
  /**
   * Write an archived row STRAIGHT to SQLite, bypassing `insert` (which parses
   * against the current schema and would reject the legacy shape before it ever
   * reached the column). This is the only way to model a row that a pre-D4
   * build wrote and a post-D4 build has to read.
   */
  function insertRawArchivedRow(executionId: string, execution: unknown): void {
    db.prepare(
      `INSERT INTO graph_workflow_archived_executions (
         project_path, session_name, execution_id, archived_at,
         status, started_at, completed_at, execution_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      SESSION_NAME,
      executionId,
      "2026-01-02T01:00:00Z",
      "completed",
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      JSON.stringify(execution),
    );
  }

  /**
   * An execution archived before D4 existed: the maximal fixture with EXACTLY
   * the D4 persisted-field inventory removed, so edges carry no `id` (the field
   * became required in D4 decision D2) and no D4 field is present anywhere.
   */
  function preD4ArchivedExecution(): Record<string, unknown> {
    return stripD4PersistedFields(buildMaximalGraphWorkflowExecution());
  }

  // R14.1/R14.2: an execution archived before D4 has to stay readable, and the
  // archive is the ONLY read path that never rewrites its row — so whatever
  // repairs the active tier on inflate has to reach this blob too, or D4 made
  // every pre-D4 archived execution permanently unreadable.
  it("reads a pre-D4 archived row, repairing its edge ids at the inflate boundary", () => {
    const preD4 = preD4ArchivedExecution();
    insertRawArchivedRow("wf-pre-d4", preD4);

    const loaded = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-pre-d4",
    );

    expect(loaded).not.toBeNull();
    // Deterministic minting from the endpoints: the same stored bytes yield the
    // same ids on every read, so an id-addressed reference taken from one read
    // still resolves on the next.
    expect(loaded?.workingDefinition.edges.map((edge) => edge.id)).toEqual([
      "ctx-1__ctx-2",
    ]);
  });

  it("exposes a legacy archive through the common by-id accessor", async () => {
    const legacy = preD4ArchivedExecution();
    legacy.id = "wf-pre-d4-by-id";
    insertRawArchivedRow("wf-pre-d4-by-id", legacy);
    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    const loaded = await store.getGraphWorkflowExecutionById(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-pre-d4-by-id",
    );

    expect(loaded?.id).toBe("wf-pre-d4-by-id");
    expect(loaded?.workingDefinition.edges[0]?.id).toBe("ctx-1__ctx-2");
  });

  // The dormant floor R14.1 promises, proven on the archive tier: absent D4
  // fields parse to unconditional edges, no loops, and no recorded routing.
  it("parses a pre-D4 archived row to the dormant D4 floor", () => {
    insertRawArchivedRow("wf-pre-d4", preD4ArchivedExecution());

    const loaded = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-pre-d4",
    );
    if (loaded === null) throw new Error("pre-D4 archived row must load");

    expect(
      loaded.workingDefinition.edges.every((edge) => edge.when === undefined),
      "an absent guard must stay absent, not materialize as an always-true one",
    ).toBe(true);
    expect(
      loaded.workingDefinition.executionContexts.every(
        (context) => context.routing === undefined,
      ),
    ).toBe(true);
    expect(loaded.workingDefinition.loopGroups).toBeUndefined();
    expect(loaded.contextStates["ctx-1"]?.skipReason).toBeNull();
    expect(loaded.contextStates["ctx-1"]?.landingIntent).toBeNull();
    expect(loaded.routeSettlements).toEqual({});
    expect(loaded.routeControlRevisions).toEqual({});
    expect(loaded.loopStates).toEqual({});
    expect(loaded.expansionReceipts).toEqual({ accepted: [], refusals: [] });

    // The same reading the compat floor probes take, so "dormant" here means
    // what R14.1's observational-equivalence harness means by it.
    expect(projectExecutionTierFloor(loaded)).toEqual({
      edgeActivation: "all-unconditional",
      loops: "none-declared",
      expansionAuthority: "disabled-on-every-context",
      routing: "no-recorded-decisions",
      skips: "none",
    });
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
 * The one fully-populated resolved execution context the harness descends
 * into. Shared by the scheduled graph and by the loop body template, so a
 * field added to a resolved context is proven durable on both paths from a
 * single literal.
 */
function maximalResolvedContext(): Record<string, unknown> {
  return {
    id: "ctx-1",
    title: "Implement the thing",
    description: "Detailed description of the context",
    acceptanceCriteria: "All tests pass and the build is green",
    // The owning grade, because it is the only one that carries a payload:
    // a placement round-trip that only ever saw `{ lane, mode }` would not
    // prove the owned-prefix set survives a real save and reload.
    placement: {
      lane: "delivery",
      mode: "owned",
      ownedPaths: ["src/feature", "docs/feature.md"],
    },
    origin: {
      sourceUri: "spec://native-sdd/contexts/ctx-1",
      label: "Implementation context",
    },
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      focus: "the persistence layer",
      agent: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
      profileSnapshot: {
        tier: "builtin",
        id: "general-implementer",
        name: "General Implementer",
        revision: 4,
        sourceContentHash: `sha256:${"1".repeat(64)}`,
        instructions: "Maximal implementer instructions.",
        renderedInstructionBlock:
          "MAXIMAL IMPLEMENTER RENDERED BLOCK\nwith the use-site focus inside it",
        resolvedInstructionHash: `sha256:${"2".repeat(64)}`,
      },
    },
    contextValidator: {
      enabled: false,
      assignments: [
        {
          id: "security",
          profile: { tier: "project", id: "security-reviewer" },
          focus: "auth boundaries",
          strategy: "conversation",
          authority: "blocking",
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          continuity: { enabled: false, contextLimitTokens: 120_000 },
          profileSnapshot: {
            tier: "project",
            id: "security-reviewer",
            name: "Security Reviewer",
            revision: 9,
            sourceContentHash: `sha256:${"3".repeat(64)}`,
            instructions: "Maximal validator instructions.",
            renderedInstructionBlock:
              "MAXIMAL VALIDATOR RENDERED BLOCK\nwith the use-site focus inside it",
            resolvedInstructionHash: `sha256:${"4".repeat(64)}`,
          },
        },
      ],
    },
    scriptValidator: { commands: ["typecheck", "test"] },
    scriptValidatorSource: "workflow",
    humanApprovalGate: { enabled: true },
    askUserQuestions: { enabled: true },
    mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
    circuitBreaker: { consecutiveFailureThreshold: 5 },
    iterationPolicy: {
      maxIterations: 7,
      continuity: { enabled: false, contextLimitTokens: 90_000 },
    },
    planRepair: {
      enabled: false,
      maxAttemptsPerContext: 3,
      agent: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
    },
    // Source of the guarded edge below, so its cardinality policy is the
    // one D4 routing actually evaluates.
    routing: { cardinality: "exactlyOne" },
    // `taskValidation` is a removed CC config field name reused here as an
    // ordinary output property: the cutover guard scans by field name, so
    // this pins the outputSchema subtree as opaque to it across archival.
    // Also the contract the archived contextOutputs entry below satisfies:
    // D5 admits only accepted candidates, so an archived output its own
    // context's schema would reject models an impossible state.
    outputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail"] },
        taskValidation: { type: "string" },
        score: { type: "number", minimum: 0, maximum: 1 },
        followUp: { type: ["string", "null"] },
        findings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              severity: { type: "string", enum: ["low", "high"] },
              file: { type: "string" },
              line: { type: "integer" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["id", "severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["verdict"],
      additionalProperties: false,
    },
    collaboration: {
      enabled: { value: true, source: "per-node" },
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
    agentValidation: {
      implementer: {
        value: { mode: "all", except: ["format"] },
        source: "workflow",
        commands: ["typecheck", "test"],
      },
      contextValidator: {
        value: { mode: "only", commands: ["test"] },
        source: "per-node",
        commands: ["test"],
      },
    },
    charter: makeMaximalCharter(),
  };
}

/**
 * Reuses the maximal execution fixture pattern: every introspectable persisted
 * key path of `graphWorkflowExecutionSchema` set to a distinctive non-default
 * value, so the durability harness proves the control-state blob survives the
 * `execution_json` serialization boundary intact.
 */
function buildMaximalExecution(): unknown {
  const execution = {
    id: "wf-maximal",
    origin: {
      kind: "template",
      definitionId: "seed-maximal",
      definitionRevision: 3,
      tier: "project",
    },
    seedDefinitionId: "seed-maximal",
    seedDefinitionRevision: 3,
    // The authored source snapshot, shared with the active-execution fixture so
    // the two maximal records cannot drift on the one field History renders a
    // template-free run from.
    launchDocument: buildMaximalLaunchDocument(),
    liveSessionReadOnlyPinned: true,
    abandonment: {
      abandonedAt: "2026-01-02T10:00:00.000Z",
      actor: { kind: "human" },
      reason: "superseded by a replan",
    },
    liveRevision: 4,
    executionStateRevision: 17,
    structuralRevision: 9,
    charterAmendments: [
      {
        seq: 1,
        amendedAt: "2026-01-02T03:00:00.000Z",
        source: "cli",
        rationale:
          "Invariant inv-2 was impossible to satisfy against the shipped API",
        fieldsChanged: ["invariants", "mission"],
        charterHash: "hash-after-amendment-1",
      },
    ],
    planRepairRounds: [
      // The LOOP repair round leads: the durability guard inspects element [0],
      // and `loopGroupId` is only non-null on a loop round (D4 R12).
      {
        seq: 1,
        contextId: "loop-refine__p2__ctx-1",
        haltType: "loop_limit_reached",
        loopGroupId: "loop-refine",
        startedAt: "2026-01-02T02:40:00.000Z",
        settledAt: "2026-01-02T02:55:00.000Z",
        outcome: "repaired",
        planningDefect: true,
        diagnosis: "the exit predicate demanded a field the judge cannot emit",
        operationCount: 2,
        resumed: true,
        conversationId: "conv-plan-repair-2",
      },
      {
        seq: 2,
        contextId: "ctx-1",
        haltType: "circuit_breaker",
        loopGroupId: null,
        startedAt: "2026-01-02T03:10:00.000Z",
        settledAt: "2026-01-02T03:20:00.000Z",
        outcome: "repaired",
        planningDefect: true,
        diagnosis: "AC referenced an endpoint removed in revision 2",
        operationCount: 3,
        resumed: true,
        conversationId: "conv-plan-repair-1",
      },
    ],
    loopControlAmendments: [
      {
        seq: 1,
        loopGroupId: "loop-refine",
        kind: "amend-predicate",
        rationale:
          "the judge cannot emit `approved` without a spec change; recorded\nnotes are the real exit condition",
        loopControlRevision: 1,
        templateVersion: 1,
        maxPasses: 4,
        source: "plan-repair",
        amendedAt: "2026-01-02T02:45:00.000Z",
      },
      {
        seq: 2,
        loopGroupId: "loop-refine",
        kind: "raise-max-passes",
        rationale: null,
        loopControlRevision: 2,
        templateVersion: 2,
        maxPasses: 4,
        source: "cli",
        amendedAt: "2026-01-02T02:50:00.000Z",
      },
    ],
    loopEpoch: 2,
    boundInputs: {
      feature: "search box",
      notes: "first line\nsecond line",
    },
    launchedTier: "global",
    // The archive keeps the whole execution blob, so the seed-time owner has to
    // survive archival too: an archived run is still the audit record of who
    // launched it.
    ownerConversationId: "conv-owner-archived",
    definitionApproval: {
      requestedAt: "2026-01-01T00:00:05Z",
      approvedAt: "2026-01-01T00:00:10Z",
    },
    // Populated for the durability probe only: a finalized approval has
    // consumed its reservation, so a live record never carries both.
    definitionApprovalClaim: {
      claimId: "claim-archived-definition-approval",
      claimedAt: "2026-01-01T00:00:08Z",
    },
    workingDefinition: {
      schemaVersion: 2,
      approvalRequired: true,
      origin: {
        sourceUri: "spec://native-sdd/workflow-definitions/wf-maximal",
        label: "Native SDD spec",
      },
      lockedRegions: [
        {
          paths: ["/tasks/*/instructions"],
          sourceUri: "spec://native-sdd/workflow-definitions/wf-maximal",
          reason: "Task instructions must be amended at the source spec",
          instruction:
            "Amend spec://native-sdd/workflow-definitions/wf-maximal and recompile the definition.",
        },
      ],
      // Workflow-scope lane-merge selection snapshot — non-default on every
      // leaf so archival proves both fields persist.
      laneMergeValidation: {
        strategy: "every-merge",
        commands: { mode: "only", commands: ["typecheck"] },
      },
      executionContexts: [
        {
          id: "ctx-1",
          title: "Implement the thing",
          description: "Detailed description of the context",
          acceptanceCriteria: "All tests pass and the build is green",
          // The owning grade, because it is the only one that carries a payload:
          // a placement round-trip that only ever saw `{ lane, mode }` would not
          // prove the owned-prefix set survives a real save and reload.
          placement: {
            lane: "delivery",
            mode: "owned",
            ownedPaths: ["src/feature", "docs/feature.md"],
          },
          origin: {
            sourceUri: "spec://native-sdd/contexts/ctx-1",
            label: "Implementation context",
          },
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            focus: "the persistence layer",
            agent: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "high",
            },
            profileSnapshot: {
              tier: "builtin",
              id: "general-implementer",
              name: "General Implementer",
              revision: 4,
              sourceContentHash: `sha256:${"1".repeat(64)}`,
              instructions: "Maximal implementer instructions.",
              renderedInstructionBlock:
                "MAXIMAL IMPLEMENTER RENDERED BLOCK\nwith the use-site focus inside it",
              resolvedInstructionHash: `sha256:${"2".repeat(64)}`,
            },
          },
          contextValidator: {
            enabled: false,
            assignments: [
              {
                id: "security",
                profile: { tier: "project", id: "security-reviewer" },
                focus: "auth boundaries",
                strategy: "conversation",
                // Non-default authority: an authored blocking specialist must
                // reload as blocking rather than decaying to the advisory
                // default.
                authority: "blocking",
                agent: {
                  backend: "claude",
                  model: "sonnet",
                  reasoningEffort: "medium",
                },
                continuity: { enabled: false, contextLimitTokens: 120_000 },
                profileSnapshot: {
                  tier: "project",
                  id: "security-reviewer",
                  name: "Security Reviewer",
                  revision: 9,
                  sourceContentHash: `sha256:${"3".repeat(64)}`,
                  instructions: "Maximal validator instructions.",
                  renderedInstructionBlock:
                    "MAXIMAL VALIDATOR RENDERED BLOCK\nwith the use-site focus inside it",
                  resolvedInstructionHash: `sha256:${"4".repeat(64)}`,
                },
              },
            ],
          },
          scriptValidator: { commands: ["typecheck", "test"] },
          scriptValidatorSource: "workflow",
          humanApprovalGate: { enabled: true },
          askUserQuestions: { enabled: true },
          mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
          circuitBreaker: { consecutiveFailureThreshold: 5 },
          iterationPolicy: {
            maxIterations: 7,
            continuity: { enabled: false, contextLimitTokens: 90_000 },
          },
          planRepair: {
            enabled: false,
            maxAttemptsPerContext: 3,
            agent: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "high",
            },
          },
          // `taskValidation` is a removed CC config field name reused here as an
          // ordinary output property: the cutover guard scans by field name, so
          // this pins the outputSchema subtree as opaque to it across archival.
          // Also the contract the archived contextOutputs entry below satisfies:
          // D5 admits only accepted candidates, so an archived output its own
          // context's schema would reject models an impossible state.
          routing: { cardinality: "exactlyOne" },
          outputSchema: {
            type: "object",
            properties: {
              verdict: { type: "string", enum: ["pass", "fail"] },
              taskValidation: { type: "string" },
              score: { type: "number", minimum: 0, maximum: 1 },
              followUp: { type: ["string", "null"] },
              findings: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    severity: { type: "string", enum: ["low", "high"] },
                    file: { type: "string" },
                    line: { type: "integer" },
                    tags: { type: "array", items: { type: "string" } },
                  },
                  required: ["id", "severity"],
                  additionalProperties: false,
                },
              },
            },
            required: ["verdict"],
            additionalProperties: false,
          },
          collaboration: {
            enabled: { value: true, source: "per-node" },
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
          agentValidation: {
            implementer: {
              value: { mode: "all", except: ["format"] },
              source: "workflow",
              // The seed-time expansion frozen against the registry (design §6).
              commands: ["typecheck", "test"],
            },
            contextValidator: {
              value: { mode: "only", commands: ["test"] },
              source: "per-node",
              commands: ["test"],
            },
          },
          charter: makeMaximalCharter(),
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
        {
          id: "edge-1",
          sourceContextId: "ctx-1",
          targetContextId: "ctx-2",
          // A D4 activation guard over ctx-1's declared output above: subset-
          // valid and statically compatible with it.
          when: {
            schema: {
              type: "object",
              properties: { verdict: { const: "pass" } },
              required: ["verdict"],
            },
          },
        },
      ],
      // A resolved loop group: its body has already been lifted out of
      // `executionContexts` into the versioned template, which is why the
      // template's contexts, tasks, and edges appear nowhere above.
      loopGroups: [
        {
          id: "loop-1",
          title: "Refine until the judge passes",
          entryContextId: "ctx-loop-worker",
          exitContextId: "ctx-loop-judge",
          until: {
            schema: {
              type: "object",
              properties: { verdict: { const: "pass" } },
              required: ["verdict"],
            },
          },
          maxPasses: 4,
          template: {
            contexts: [
              { ...maximalResolvedContext(), id: "ctx-loop-judge" },
              { ...maximalResolvedContext(), id: "ctx-loop-worker" },
            ],
            tasks: [
              {
                id: "loop-task-1",
                contextId: "ctx-loop-judge",
                order: 1,
                title: "Judge the revision",
                instructions: "Record a verdict for this pass",
                metadata: { area: "review" },
                source: "agent",
              },
            ],
            edges: [
              {
                id: "loop-edge-1",
                sourceContextId: "ctx-loop-worker",
                targetContextId: "ctx-loop-judge",
                when: {
                  schema: {
                    type: "object",
                    properties: { verdict: { const: "fail" } },
                    required: ["verdict"],
                  },
                },
              },
            ],
          },
          templateVersion: 3,
          planRepair: {
            enabled: false,
            maxAttemptsPerContext: 5,
            agent: {
              backend: "codex",
              model: "gpt-5.4",
              reasoningEffort: "low",
            },
          },
        },
      ],
    },
    charter: makeMaximalCharter(),
    status: "running",
    activeContextIds: ["ctx-1"],
    contextStates: {
      "ctx-1": {
        contextId: "ctx-1",
        // Maximal durability entry: the harness only descends into the FIRST
        // context-state record entry, so this one co-populates BOTH parked
        // records (pendingApproval AND pendingUserInputs) to prove every
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
        // Owner-discriminated scheduler reservation (Design 3.1): a persisted key
        // path, so the maximal fixture carries a non-null value to prove it
        // survives the archived-execution round-trip.
        reservedByBatchId: "batch-1",
        // The frozen write envelope the scheduler admitted this context under
        // (decision D4) — persisted, so the archive has to carry it too.
        reservedOwnership: {
          mode: "owned",
          canonicalPrefixes: ["/wt/lane-1/src/api", "/wt/lane-1/docs"],
        },
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
          // The scope this gate froze under; the approval surface reads its
          // bytes back through this identity rather than the live placement.
          approvalScope: {
            kind: "scoped",
            ownedPaths: ["src/api", "docs/api.md"],
            treeHash: "owned-subset-digest-1",
            headSha: "abc1234",
          },
        },
        pendingUserInputs: {
          // Keyed by lane key: a cohort's validators park independently, so the
          // durability claim has to cover an assignment-scoped key.
          "context_validator:security-reviewer": {
            conversationId: "conv-userinput-1",
            lane: "context_validator",
            questionBatchId: "qb-1",
            requestedAt: "2026-01-01T00:01:00.000Z",
            roundSeq: 4,
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
        // An open validation round. Archived under the same superimposition
        // rule as the parked records above: the harness descends into the FIRST
        // specialist entry only, so that one carries a settled verdict AND a
        // question token — every persisted key path, not a reachable state.
        validationRound: {
          seq: 4,
          candidate: {
            // The non-default scope, so a round-trip that dropped the field
            // would read back as the whole-tree candidate this is not.
            identityScope: "owned",
            headSha: "a".repeat(40),
            candidateTreeHash: "b".repeat(40),
            taskStateHash: "c".repeat(64),
          },
          roster: [
            {
              assignmentId: "general",
              profileRef: { tier: "builtin", id: "general-reviewer" },
              revision: 3,
              resolvedInstructionHash: `sha256:${"d".repeat(64)}`,
              strategy: "conversation",
            },
          ],
          specialists: {
            general: {
              state: "verdict_fail",
              attempts: 2,
              summary: "Rollback notes are still missing.",
              issues: [
                {
                  taskId: "task-1",
                  title: "Missing rollback notes",
                  description: "Document how to revert the migration.",
                },
              ],
              advisories: [
                {
                  kind: "plan",
                  title: "The rollback step belongs in its own task",
                  description:
                    "Reverting the migration is work in its own right.",
                  identity: {
                    roundSeq: 4,
                    assignmentId: "general",
                    ordinal: 1,
                  },
                  deliveredAt: "2026-01-01T00:04:00.000Z",
                  disposition: {
                    outcome: "deferred",
                    reason: "Worth doing, but not inside this context.",
                    recordedAt: "2026-01-01T00:05:00.000Z",
                  },
                },
              ],
              questionToken: "qb-general-1",
              sessionRef: {
                backend: "claude",
                ref: "conv-general-validator",
                lane: "context_validator",
                assignmentId: "general",
                refKind: "conversation",
                workflowConversationId: "conv-general-validator",
              },
              reviewArtifact: {
                backend: "claude",
                kind: "conversation",
                ref: "conv-general-validator",
                usage: { costUsd: 0.42, apiTurns: 4 },
              },
              lastInfraFailure: {
                reason: "unparseable",
                message: "the reviewer returned prose, not a verdict",
                engine: "claude",
              },
            },
          },
          phase: "concluded",
          outcome: "failed",
          startedAt: "2026-01-01T00:03:00.000Z",
        },
        // The D4 skip record, superimposed on the same maximal entry: the whole
        // incoming-edge verdict set, not only the edges that vetoed the context.
        skipReason: {
          edgeEvaluations: [
            { edgeId: "edge-1", verdict: "inactive" },
            { edgeId: "edge-2", verdict: "active" },
            { edgeId: "edge-3", verdict: "omitted" },
          ],
          at: "2026-01-02T06:00:00.000Z",
        },
        // The D4 landing intent in its adopted-commit shape, which carries both
        // ends of the recorded SHA range.
        landingIntent: {
          mode: "lane_commit",
          attempt: 2,
          token: "cc-landing:execution-1:ctx-1:2",
          laneId: "lane-1",
          worktreePath: "/tmp/lane-1",
          baselineSha: "1111111111111111111111111111111111111111",
          headSha: "2222222222222222222222222222222222222222",
          joinId: "join-1",
          state: "landed",
          evidence: "adopted-head",
          recordedAt: "2026-01-02T05:00:00.000Z",
          settledAt: "2026-01-02T05:30:00.000Z",
        },
        // The advisory-response phase, archived under the same superimposition
        // rule as the records above: every persisted key path, not a reachable
        // combination of them.
        advisoryResponse: {
          roundSeq: 4,
          phase: "recertifying",
          enteredAt: "2026-01-01T00:06:00.000Z",
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
    routeControlRevisions: { "ctx-1": 3 },
    routeSettlements: {
      "ctx-1": {
        sourceContextId: "ctx-1",
        captureIteration: 2,
        routeControlRevision: 3,
        activatedEdgeIds: ["edge-2"],
        inactiveEdgeIds: ["edge-1"],
        omittedEdgeIds: ["edge-3"],
        settledAt: "2026-01-02T06:00:00.000Z",
      },
    },
    // Both D4 expansion ledgers carrying content, so an archive that dropped
    // either half is visible: an archived execution is the only remaining
    // record of what a lane grew at runtime and why.
    expansionReceipts: {
      accepted: [
        {
          requestId: "expansion-req-1",
          payloadHash:
            "3f2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
          invokerContextId: "ctx-1",
          initiatorConversationId: "conv-lane-1",
          rationale: "fan out one candidate per approach",
          addedContextIds: ["ctx-1-xdeadbeef-candidate-a"],
          addedTaskIds: ["ctx-1-xdeadbeef-candidate-a-t1"],
          rejoinContextIds: ["ctx-2"],
          liveRevision: 4,
          acceptedAt: "2026-01-02T06:30:00.000Z",
        },
      ],
      refusals: [
        {
          requestId: "expansion-req-2",
          payloadHash:
            "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          invokerContextId: "ctx-1",
          refusalCode: "expansion-cap-contexts-per-request",
          refusedAt: "2026-01-02T06:45:00.000Z",
        },
      ],
    },
    // A loop mid-flight, so an archive that dropped the ledger, flattened the
    // slot states or lost the pinned boundary snapshot fails here (R9/R16.1).
    loopStates: {
      "loop-refine": {
        loopGroupId: "loop-refine",
        activation: "concluded",
        loopControlRevision: 1,
        passCount: 2,
        slotLedger: [
          {
            pass: 1,
            state: "counted",
            grantOrder: 1,
            grantedAt: "2026-01-02T05:00:00.000Z",
          },
          {
            pass: 2,
            state: "counted",
            grantOrder: 2,
            grantedAt: "2026-01-02T06:30:00.000Z",
          },
        ],
        boundaryInputs: [
          {
            contextId: "ctx-1",
            title: "First context",
            declared: true,
            schemaFields: [
              {
                name: "verdict",
                type: "string",
                required: true,
                description: "the classifier verdict",
              },
            ],
            output: { verdict: "pass", findings: [{ id: "f-1" }] },
            skipped: false,
          },
        ],
        decisions: {
          "1": {
            loopGroupId: "loop-refine",
            pass: 1,
            loopControlRevision: 1,
            templateVersion: 1,
            exitContextId: "loop-refine__p1__ctx-1",
            exitCaptureIteration: 2,
            verdict: "unsatisfied",
            outcome: "materialized",
            nextPass: 2,
            decidedAt: "2026-01-02T06:30:00.000Z",
          },
          "2": {
            loopGroupId: "loop-refine",
            pass: 2,
            loopControlRevision: 1,
            templateVersion: 1,
            exitContextId: "loop-refine__p2__ctx-1",
            exitCaptureIteration: 1,
            verdict: "satisfied",
            outcome: "concluded",
            nextPass: null,
            decidedAt: "2026-01-02T07:30:00.000Z",
          },
        },
        // Two passes that cloned DIFFERENT template versions (R11.2), so a
        // round trip that collapsed the record loses the provenance that makes
        // a template amendment provably non-retroactive.
        passTemplateVersions: { "1": 1, "2": 2 },
        concludingExitContextId: "loop-refine__p2__ctx-1",
        activatedAt: "2026-01-02T05:00:00.000Z",
        settledAt: "2026-01-02T07:30:00.000Z",
      },
    },
    contextOutputs: {
      "ctx-1": {
        // Accepted under ctx-1's authored outputSchema above (D5).
        value: {
          verdict: "pass",
          taskValidation: "reviewed",
          score: 0.94,
          findings: [
            {
              id: "f-1",
              severity: "high",
              file: "src/lib/foo.ts",
              line: 42,
              tags: ["perf", "api"],
            },
          ],
          followUp: null,
        },
        capturedAt: "2026-01-02T05:00:00.000Z",
        iteration: 3,
        parse: { source: "fenced", repaired: true, repairAttempts: 2 },
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
    // Projected from the round record above: an archived run is the only copy
    // its audience has left, so the long-lived advisories have to survive the
    // move out of the active slot along with the rounds that raised them.
    advisoryIndex: [
      {
        identity: { roundSeq: 4, assignmentId: "general", ordinal: 1 },
        kind: "plan",
        title: "The rollback step belongs in its own task",
        contextId: "ctx-1",
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
        "context_validator:general": {
          backend: "claude",
          refKind: "conversation",
          lane: "context_validator",
          contextId: "ctx-1",
          assignmentId: "general",
          assignmentFingerprint: `sha256:${"d".repeat(64)}|conversation|true||claude|sonnet|medium`,
          workflowConversationId: "conv-general-validator",
          sessionRef: {
            backend: "claude",
            ref: "conv-general-validator",
          },
          metrics: {
            contextTokens: 42_000,
            contextWindowMax: 200_000,
            rotateBeforeNextTurn: false,
          },
          limitEvaluation: "supported",
          lastUsedAt: "2026-01-02T02:30:00Z",
        },
        "context_validator:security-reviewer": {
          backend: "codex",
          refKind: "backend",
          lane: "context_validator",
          contextId: "ctx-1",
          assignmentId: "security-reviewer",
          assignmentFingerprint: `sha256:${"e".repeat(64)}|task|true|60000|codex|gpt-5.4|high`,
          workflowConversationId: "conv-security-validator",
          sessionRef: {
            backend: "codex",
            ref: "thread-security-validator",
          },
          metrics: {
            lastTurnUsage: {
              inputTokens: 1200,
              cachedInputTokens: 400,
              outputTokens: 300,
            },
            rotateBeforeNextTurn: false,
          },
          limitEvaluation: "supported",
          lastUsedAt: "2026-01-02T02:45:00Z",
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
        ignoredBaseline: [
          {
            path: "node_modules",
            digest: "digest-node-modules",
            excluded: ["node_modules/.cache/generated"],
          },
          {
            path: "dist/bundle.js",
            digest: "digest-dist-bundle",
            excluded: [],
          },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T03:00:00Z",
      },
    },
    laneReservations: {
      "lane-2": {
        laneId: "lane-2",
        batchId: "batch-2",
        provisioning: true,
        members: [
          {
            contextId: "ctx-2",
            ownership: {
              mode: "owned",
              canonicalPrefixes: ["/wt/lane-2/src/ui"],
            },
          },
          {
            contextId: "ctx-3",
            ownership: { mode: "readOnly", canonicalPrefixes: [] },
          },
        ],
        createdAt: "2026-01-02T04:00:00Z",
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
        validationDebtSourceLaneIds: ["lane-2"],
        sourceLaneContextIds: {
          "lane-2": ["ctx-2", "ctx-3"],
        },
        validationEvidence: [
          {
            sourceLaneIds: ["lane-2"],
            contextIds: ["ctx-2", "ctx-3"],
            commandIdentity: "typecheck+test",
            recordedAt: "2026-01-02T04:30:00Z",
          },
        ],
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
        resolvedConflicts: [
          {
            sourceLaneId: "lane-2",
            files: ["schemas.ts"],
            resolution: "sub_turn",
            analysis: [
              {
                file: "schemas.ts",
                description: "both sides added the file",
                resolution: "merged complementary schemas",
                rationale: "additions are disjoint",
              },
            ],
          },
        ],
        conflictGuidance: [
          { file: "foo.ts", decision: "rejected", feedback: "keep both hunks" },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T04:00:00Z",
        completedAt: "2026-01-02T05:00:00Z",
      },
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
          secondaryHaltReasons: [
            { type: "aborted" },
            // Maximal delivery-gate halt inside an archived history event:
            // the optional approval-presentation extension (refusalCode +
            // strict spec deep-link block) must survive the archive round
            // trip too, not only the active-execution row.
            {
              type: "delivery_gate_failed",
              unmet: [
                {
                  criterionId: "spec-execution-1:gate:1",
                  criterionHandle: "audit-log",
                  outcome: "gate_blocked",
                  reason: "The delivery gate requires human approval.",
                },
              ],
              instruction:
                "Approve delivery in Spec Studio, then resume the merge.",
              refusalCode: "approval_required",
              spec: {
                specSlug: "audit-log",
                specName: "Audit Log",
                projectName: "command-center",
              },
            },
          ],
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
      // Maximal delivery-gate halt: refusalCode + the complete strict spec
      // block must round-trip through this independent archived fixture.
      {
        type: "delivery_gate_failed",
        unmet: [
          {
            criterionId: "spec-execution-1:gate:1",
            criterionHandle: "audit-log",
            outcome: "gate_blocked",
            reason: "The delivery gate requires human approval.",
          },
        ],
        instruction: "Approve delivery in Spec Studio, then resume the merge.",
        refusalCode: "approval_required",
        spec: {
          specSlug: "audit-log",
          specName: "Audit Log",
          projectName: "command-center",
        },
      },
      // Maximal cohort infrastructure halt: which specialist ran out of
      // attempts, how many it spent, and the round it spent them in. A resume
      // reads these back to explain a halt nobody's review caused, so they have
      // to survive archival.
      {
        type: "validator_infra_error",
        contextId: "ctx-1",
        engine: "claude",
        infraReason: "never_admitted",
        message: "The query semaphore never admitted security-reviewer.",
        summary: "security-reviewer was never heard in round 4.",
        assignmentId: "security-reviewer",
        attempts: 3,
        roundSeq: 4,
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
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);

      await assertRoundTripDurability({
        label: "graph-workflow-archived-executions",
        schema: graphWorkflowExecutionSchema,
        buildMaximalFixture: () =>
          graphWorkflowExecutionSchema.parse(buildMaximalExecution()),
        persist: (execution) => {
          fixture.graphWorkflowArchivedExecutions.insert(
            makeRow({ executionId: execution.id, execution }),
          );
          return execution;
        },
        // A repo instance that never saw the write proves the execution was
        // reloaded from SQLite rather than retained by the writer instance.
        reload: (expected) =>
          createGraphWorkflowArchivedExecutionsRepo(fixture.db).findByExecution(
            PROJECT_PATH,
            SESSION_NAME,
            expected.id,
          ),
      });
    } finally {
      fixture.close();
    }
  });

  it("carries assignment-scoped validator lanes and fingerprints in the maximal SQLite fixture", () => {
    const execution = graphWorkflowExecutionSchema.parse(
      buildMaximalExecution(),
    );
    repo.insert(makeRow({ executionId: execution.id, execution }));

    const reloaded = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      execution.id,
    );
    expect(
      reloaded?.laneStates["ctx-1"]?.["context_validator:security-reviewer"],
    ).toMatchObject({
      lane: "context_validator",
      contextId: "ctx-1",
      assignmentId: "security-reviewer",
      assignmentFingerprint: `sha256:${"e".repeat(64)}|task|true|60000|codex|gpt-5.4|high`,
      sessionRef: { backend: "codex", ref: "thread-security-validator" },
    });
  });

  // R14.2's archive half. The active tier proves the same inventory against
  // graph_workflow_executions; this proves it against the archive's OWN maximal
  // fixture, which is a separate literal in this file — so a D4 field added to
  // one fixture and forgotten in the other is a failure rather than a silent
  // asymmetry. Archival is where an execution's routing and loop evidence has to
  // survive longest: the row is written once and never rewritten, so anything
  // this boundary drops is gone for good.
  it("exercises every D4 inventory path in the archived maximal fixture", () => {
    const fixture = graphWorkflowExecutionSchema.parse(buildMaximalExecution());
    const unexercised = D4_PERSISTED_FIELDS.filter((field) =>
      collectValuesAtPath(fixture, field.path).every(isEmptyForFixture),
    ).map((field) => field.path);
    expect(
      unexercised,
      "an inventory field the archive fixture leaves empty is a field the archive round-trip proves nothing about",
    ).toEqual([]);
  });

  it("round-trips every D4 inventory path through insert -> findByExecution", () => {
    const execution = graphWorkflowExecutionSchema.parse(
      buildMaximalExecution(),
    );
    repo.insert(makeRow({ executionId: execution.id, execution }));

    // A fresh repo instance, so the reload is decoded from the stored bytes
    // rather than answered from anything the writing instance kept.
    const reloaded = createGraphWorkflowArchivedExecutionsRepo(
      db,
    ).findByExecution(PROJECT_PATH, SESSION_NAME, execution.id);
    if (reloaded === null) throw new Error("archived execution must reload");

    for (const field of D4_PERSISTED_FIELDS) {
      expect(
        canonicalValuesAtPath(reloaded, field.path),
        `${field.path} (${field.tier} tier) did not survive the archive round trip`,
      ).toEqual(canonicalValuesAtPath(execution, field.path));
    }
  });

  // This file keeps its own copy of the maximal execution, so it needs the same
  // D5 guard the active-executions contract test applies: an archived output
  // its own context's authored schema would reject is not a state the engine
  // can reach, and evidence drawn from it proves nothing.
  it("only carries context outputs their own context's authored outputSchema accepts", () => {
    const execution = graphWorkflowExecutionSchema.parse(
      buildMaximalExecution(),
    );
    const entries = Object.entries(execution.contextOutputs);
    expect(entries.length).toBeGreaterThan(0);

    for (const [contextId, output] of entries) {
      const authored = execution.workingDefinition.executionContexts.find(
        (context) => context.id === contextId,
      )?.outputSchema;
      expect(
        authored,
        `${contextId} must declare an outputSchema`,
      ).toBeDefined();
      if (authored === undefined) continue;
      expect(
        validateOutputSchemaDeclaration(authored),
        `${contextId} outputSchema must be a legal declaration`,
      ).toEqual([]);
      expect(
        validateJsonSchemaSubset(authored, output.value),
        `${contextId} archived output must be accepted by its authored schema`,
      ).toEqual({ valid: true });
    }
  });
});
