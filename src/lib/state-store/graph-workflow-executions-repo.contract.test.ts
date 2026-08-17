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
import { z } from "zod";
import { _createTestDb } from "./state-db";
import {
  createGraphWorkflowExecutionsRepo,
  splitExecution,
  DEFINITION_TIER_KEYS,
  RUNTIME_TIER_KEYS,
  type GraphWorkflowExecutionsRepo,
} from "./graph-workflow-executions-repo";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowLandingIntent,
} from "@/lib/workflow-graph/schemas";
import { laneStateKey } from "@/lib/workflow-graph/lane-identity";
import {
  buildOneOffSeedCompatibilityFields,
  buildSpecDeliverySeedCompatibilityFields,
  ONE_OFF_SEED_DEFINITION_ID_PREFIX,
  SPEC_DELIVERY_SEED_DEFINITION_ID_PREFIX,
} from "@/lib/workflow-graph/execution-origin";
import { executionLeaseAndResultDeliveries } from "./migrations/0024-execution-lease-and-result-deliveries";
import { resolveExpansionProvenance } from "@/lib/workflow-graph/expansion-receipts";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import {
  canonicalValuesAtPath,
  collectValuesAtPath,
  isEmptyForFixture,
  resolveExecutionSchemaAtPath,
  stripD4PersistedFields,
  D4_PERSISTED_FIELDS,
  D4_SUPERSEDED_FIELD_NAMES,
} from "@/lib/shared/testing/d4-persisted-field-inventory";
import { projectExecutionTierFloor } from "@/lib/workflow-graph/compat/floor";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import {
  validateJsonSchemaSubset,
  validateOutputSchemaDeclaration,
} from "@/lib/workflows/primitives/output-schema-subset";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

let db: Db;
let repo: GraphWorkflowExecutionsRepo;

function seedSession(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    `csm/${SESSION_NAME}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

function maximalExecution(): GraphWorkflowExecution {
  const base = graphWorkflowExecutionSchema.parse(
    buildMaximalGraphWorkflowExecution(),
  );
  // Alongside the "supported" implementer lane, carry TWO validator lanes for
  // one context — a cohort of two assignments of the same profile. They pin the
  // widened `laneStates` inner key (`context_validator:<assignmentId>`) and the
  // per-lane assignment identity through the real SQLite/Zod round-trip; the
  // first also carries "metrics_unavailable", the honest label for a turn with
  // no occupancy metrics under a configured limit.
  const validatorLane = (
    assignmentId: string,
    conversationId: string,
    limitEvaluation: GraphWorkflowAgentSessionState["limitEvaluation"],
  ): GraphWorkflowAgentSessionState => ({
    backend: "claude",
    refKind: "conversation",
    lane: "context_validator",
    contextId: "ctx-1",
    assignmentId,
    assignmentFingerprint: `sha256:${"b".repeat(64)}|conversation|true||claude|sonnet|medium`,
    workflowConversationId: conversationId,
    sessionRef: { backend: "claude", ref: conversationId },
    metrics: { rotateBeforeNextTurn: false },
    limitEvaluation,
    lastUsedAt: "2026-01-02T02:30:00Z",
  });
  // The first specialist of the round additionally carries a plan defect: the
  // blocking seat's third response, which no other fixture field reaches. It is
  // superimposed on a seat that also holds issues and advisories for the same
  // reason the round fixture superimposes a verdict and a question token — the
  // durability harness descends into the FIRST entry of a record, so every
  // persisted key path has to be reachable there rather than spread across
  // states a real round would keep apart.
  const round = base.contextStates["ctx-1"]?.validationRound;
  if (!round) throw new Error("the maximal fixture has no validation round");
  const generalSpecialist = round.specialists["general"];
  if (!generalSpecialist) {
    throw new Error("the maximal fixture's round has no `general` seat");
  }
  const planDefect = {
    title: "The rollback criterion names a downstream context",
    description:
      "Criterion 3 requires the publisher to change, which nothing in this context owns.",
    whyNotLocallyRemediable:
      "Every task here is scoped to the migration; the publisher lands in ctx-2.",
    conflictingContract: "Acceptance criterion 3",
  };
  return graphWorkflowExecutionSchema.parse({
    ...base,
    // The halt that same defect produces, carried beside the round that raised
    // it. The halt is the WHOLE reaction to a refused contract — nothing is
    // reopened and nothing is charged — so its aggregated, seat-attributed
    // findings need a persisted path of their own: the round record attributes
    // a defect by the seat's key, and a flattened halt payload cannot.
    secondaryHaltReasons: [
      ...base.secondaryHaltReasons,
      {
        type: "plan_defect",
        contextId: "ctx-1",
        planDefects: [{ ...planDefect, assignmentId: "general" }],
        roundSeq: 4,
        // Maximal: the plan-repair supervisor has already spoken on this halt,
        // so the field the halt UI explains a decline with is proven durable.
        summary: "Plan repair declined: the criterion is assigned correctly.",
      },
    ],
    contextStates: {
      ...base.contextStates,
      "ctx-1": {
        ...base.contextStates["ctx-1"],
        validationRound: {
          ...round,
          specialists: {
            ...round.specialists,
            general: { ...generalSpecialist, planDefects: [planDefect] },
          },
        },
      },
    },
    laneStates: {
      ...base.laneStates,
      "ctx-1": {
        ...base.laneStates["ctx-1"],
        [laneStateKey("context_validator", "general")]: validatorLane(
          "general",
          "conv-lane-2",
          "metrics_unavailable",
        ),
        [laneStateKey("context_validator", "security-reviewer")]: validatorLane(
          "security-reviewer",
          "conv-lane-3",
          "supported",
        ),
      },
    },
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedSession();
  repo = createGraphWorkflowExecutionsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("graph-workflow-executions split symmetry", () => {
  it("assigns every top-level execution key to exactly one tier", () => {
    const allKeys = Object.keys(graphWorkflowExecutionSchema.shape).sort();
    const definitionKeys: string[] = [...DEFINITION_TIER_KEYS];
    const runtimeKeys: string[] = [...RUNTIME_TIER_KEYS];

    const overlap = definitionKeys.filter((k) => runtimeKeys.includes(k));
    expect(overlap, "a key must not appear in both tiers").toEqual([]);

    const union = [...definitionKeys, ...runtimeKeys].sort();
    expect(
      union,
      "union of definition+runtime tier keys must exactly equal the schema keys (no field unassigned, none duplicated)",
    ).toEqual(allKeys);
  });

  it("round-trips a maximal execution through splitExecution + JSON merge losslessly", () => {
    const execution = maximalExecution();
    const split = splitExecution(execution);
    const merged = {
      ...(JSON.parse(split.definitionJson) as Record<string, unknown>),
      ...(JSON.parse(split.runtimeJson) as Record<string, unknown>),
    };
    expect(graphWorkflowExecutionSchema.parse(merged)).toEqual(execution);
  });
});

describe("graph-workflow-executions-repo durability contract", () => {
  it("findByExecutionId reads an active execution without session coordinates", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    expect(repo.findByExecutionId(execution.id)).toEqual(execution);
    expect(repo.findByExecutionId("missing")).toBeNull();
  });

  it("round-trips every persisted execution key path through setActive -> getActive", async () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);

      await assertRoundTripDurability({
        label: "graph-workflow-executions",
        schema: graphWorkflowExecutionSchema,
        buildMaximalFixture: maximalExecution,
        persist: (execution) => {
          fixture.graphWorkflowExecutions.setActive(
            PROJECT_PATH,
            SESSION_NAME,
            execution,
            "2026-03-01T00:00:00Z",
          );
          return execution;
        },
        reload: () =>
          createGraphWorkflowExecutionsRepo(fixture.db).getActive(
            PROJECT_PATH,
            SESSION_NAME,
          ),
      });
    } finally {
      fixture.close();
    }
  });

  it("persists lane validation debt across a restarted repository", () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      fixture.graphWorkflowExecutions.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        maximalExecution(),
        "2026-03-01T00:00:00Z",
      );

      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(reloaded?.joins["join-1"]?.validationDebtSourceLaneIds).toEqual([
        "lane-2",
      ]);
    } finally {
      fixture.close();
    }
  });

  it("carries the attributed validator infrastructure halt in the maximal SQLite fixture", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(
      reloaded?.secondaryHaltReasons.find(
        (reason) => reason.type === "validator_infra_error",
      ),
    ).toEqual({
      type: "validator_infra_error",
      contextId: "ctx-1",
      engine: "claude",
      infraReason: "never_admitted",
      message: "The query semaphore never admitted security-reviewer.",
      summary: "security-reviewer was never heard in round 4.",
      assignmentId: "security-reviewer",
      attempts: 3,
      roundSeq: 4,
    });
  });

  // The resume gate reads `resolutionFailure.retryable` off a reloaded
  // execution to decide whether a join may be rescheduled automatically, so a
  // classification the repository drops silently re-enables the retries that
  // walked the incident back into a quota wall.
  it("carries the join resolution failure classification in the maximal SQLite fixture", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(
      reloaded?.secondaryHaltReasons.find(
        (reason) => reason.type === "join_failure",
      ),
    ).toEqual({
      type: "join_failure",
      joinId: "join-1",
      joinKind: "context_merge",
      contextId: "ctx-1",
      sourceLaneIds: ["lane-2"],
      targetLaneId: "lane-1",
      message:
        "Conflict resolution failed before reaching the conflict: " +
        "quota_exhausted — You've hit your usage limit.",
      conflictFiles: ["foo.ts"],
      resolutionFailure: {
        kind: "quota_exhausted",
        message: "You've hit your usage limit.",
        retryable: false,
        retryAfterHint: "Aug 19th, 2026 11:29 PM",
      },
    });
  });

  // R9: advisories and their dispositions are durable per specialist and per
  // round, and the long-lived kinds are additionally readable from the execution
  // without opening a round. The durability harness above proves every key path
  // survives; this pins the two shapes whole, because an advisory reloaded
  // without its identity, its delivery stamp, or its disposition is a record
  // nobody can act on afterwards.
  it("reloads each specialist's advisories with their identities, delivery, and dispositions", () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      const execution = maximalExecution();
      fixture.graphWorkflowExecutions.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        execution,
        "2026-03-01T00:00:00Z",
      );

      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const round = reloaded?.contextStates["ctx-1"]?.validationRound;
      expect(round?.specialists["general"]?.advisories).toEqual([
        {
          kind: "plan",
          title: "The rollback step belongs in its own task",
          description:
            "Reverting the migration is work in its own right, not a footnote on this one.",
          identity: { roundSeq: 4, assignmentId: "general", ordinal: 1 },
          deliveredAt: "2026-03-01T00:00:00.000Z",
          disposition: {
            outcome: "declined",
            reason: "The plan is already approved at this shape.",
            recordedAt: "2026-03-01T00:05:00.000Z",
          },
        },
      ]);
      // The state every advisory starts in survives too: an undelivered advisory
      // reloaded with a delivery stamp would be one the implementer never saw,
      // recorded as one it had.
      expect(round?.specialists["security-reviewer"]?.advisories).toEqual([
        {
          kind: "out_of_scope",
          title: "The auth middleware has no rate limit",
          description: "Nothing in this context owns it; worth filing.",
          identity: {
            roundSeq: 4,
            assignmentId: "security-reviewer",
            ordinal: 1,
          },
          deliveredAt: null,
          disposition: null,
        },
      ]);
    } finally {
      fixture.close();
    }
  });

  // A plan defect is what a blocking seat says about the CONTRACT, and the
  // reaction to it outlives the process that read it: the halt an operator
  // resumes and the plan-repair round that answers it both read the finding
  // itself. A round reloaded with the seat's rejection but not what it rejected
  // would leave that recovery with nothing to act on.
  it("reloads a defecting seat's plan defects, and leaves its siblings without any", () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      fixture.graphWorkflowExecutions.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        maximalExecution(),
        "2026-03-01T00:00:00Z",
      );

      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const round = reloaded?.contextStates["ctx-1"]?.validationRound;
      expect(round?.specialists["general"]?.planDefects).toEqual([
        {
          title: "The rollback criterion names a downstream context",
          description:
            "Criterion 3 requires the publisher to change, which nothing in this context owns.",
          whyNotLocallyRemediable:
            "Every task here is scoped to the migration; the publisher lands in ctx-2.",
          conflictingContract: "Acceptance criterion 3",
        },
      ]);
      // Absence is the answer for a seat that raised none — not an empty array
      // invented on read, which would be indistinguishable from a seat whose
      // defects the write dropped.
      expect(
        round?.specialists["security-reviewer"]?.planDefects,
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  // The halt a plan defect produces is the whole reaction to it: nothing is
  // reopened and nothing is charged, so a halt reloaded without its aggregated
  // findings — or without the seat that raised each one — leaves the operator
  // and the plan repair that answers it with a stopped run and no finding to
  // act on.
  it("carries the aggregated, seat-attributed plan-defect halt in the maximal SQLite fixture", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(
      reloaded?.secondaryHaltReasons.find(
        (reason) => reason.type === "plan_defect",
      ),
    ).toEqual({
      type: "plan_defect",
      contextId: "ctx-1",
      planDefects: [
        {
          assignmentId: "general",
          title: "The rollback criterion names a downstream context",
          description:
            "Criterion 3 requires the publisher to change, which nothing in this context owns.",
          whyNotLocallyRemediable:
            "Every task here is scoped to the migration; the publisher lands in ctx-2.",
          conflictingContract: "Acceptance criterion 3",
        },
      ],
      roundSeq: 4,
      summary: "Plan repair declined: the criterion is assigned correctly.",
    });
  });

  it("reloads the execution-level advisory index across both indexed kinds", () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      fixture.graphWorkflowExecutions.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        maximalExecution(),
        "2026-03-01T00:00:00Z",
      );

      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );

      expect(reloaded?.advisoryIndex).toEqual([
        {
          identity: { roundSeq: 4, assignmentId: "general", ordinal: 1 },
          kind: "plan",
          title: "The rollback step belongs in its own task",
          contextId: "ctx-1",
        },
        {
          identity: {
            roundSeq: 4,
            assignmentId: "security-reviewer",
            ordinal: 1,
          },
          kind: "out_of_scope",
          title: "The auth middleware has no rate limit",
          contextId: "ctx-1",
        },
      ]);
    } finally {
      fixture.close();
    }
  });
});

describe("D4 persisted-field inventory (decision D12)", () => {
  // The round-trip harness walks whatever the schema currently declares, so it
  // stays green when a field is REMOVED — the inventory is what makes removal
  // visible. Both halves are load-bearing: presence here, durability below.
  it("resolves every inventory path in the execution schema", () => {
    const missing = D4_PERSISTED_FIELDS.filter(
      (field) => resolveExecutionSchemaAtPath(field.path) === null,
    ).map((field) => field.path);
    expect(missing).toEqual([]);
  });

  it("exercises every inventory path in the maximal fixture", () => {
    const unexercised = D4_PERSISTED_FIELDS.filter((field) =>
      collectValuesAtPath(maximalExecution(), field.path).every(
        isEmptyForFixture,
      ),
    ).map((field) => field.path);
    expect(
      unexercised,
      "an inventory field the fixture leaves empty is a field the round-trip proves nothing about",
    ).toEqual([]);
  });

  // R14.2 against real SQLite through the production DDL. A fresh repo instance
  // has no parsed-row cache to answer from, so only the stored bytes can satisfy
  // this — which is the whole point for state that has to outlive a restart.
  it("round-trips every inventory path through setActive -> getActive", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (reloaded === null) throw new Error("maximal execution must reload");

    for (const field of D4_PERSISTED_FIELDS) {
      expect(
        canonicalValuesAtPath(reloaded, field.path),
        `${field.path} (${field.tier} tier) did not survive the round trip`,
      ).toEqual(canonicalValuesAtPath(execution, field.path));
    }
  });

  // R14.2 names "landingIntent with mode-specific receipts", and the maximal
  // fixture carries exactly one intent — so on its own it proves durability for
  // `lane_commit` and nothing else. Each mode records DIFFERENT evidence
  // (a lane's worktree and adopted head; a join id; a solo commit with neither),
  // and the landing gate treats an unreconciled intent as blocking, so an intent
  // that came back from SQLite missing its mode-specific half would strand its
  // dependents rather than fail loudly.
  it("round-trips a landing intent for every landing mode", () => {
    const base = maximalExecution();
    const intents: Record<string, GraphWorkflowLandingIntent> = {
      "ctx-1": {
        mode: "lane_commit",
        attempt: 2,
        token: "cc-landing:execution-1:ctx-1:2",
        laneId: "lane-1",
        worktreePath: "/tmp/lane-1",
        baselineSha: "1".repeat(40),
        headSha: "2".repeat(40),
        joinId: null,
        state: "landed",
        evidence: "adopted-head",
        recordedAt: "2026-01-02T05:00:00.000Z",
        settledAt: "2026-01-02T05:30:00.000Z",
      },
      "ctx-fan-in": {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:ctx-fan-in:1",
        laneId: "lane-2",
        worktreePath: null,
        baselineSha: "3".repeat(40),
        headSha: "4".repeat(40),
        joinId: "join-1",
        state: "landed",
        evidence: "join-merge",
        recordedAt: "2026-01-02T06:00:00.000Z",
        settledAt: "2026-01-02T06:30:00.000Z",
      },
      "ctx-solo": {
        mode: "solo_commit",
        attempt: 1,
        token: "cc-landing:execution-1:ctx-solo:1",
        laneId: null,
        worktreePath: null,
        baselineSha: "5".repeat(40),
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: "2026-01-02T07:00:00.000Z",
        settledAt: null,
      },
    };

    const execution = graphWorkflowExecutionSchema.parse({
      ...base,
      contextStates: {
        ...base.contextStates,
        "ctx-1": {
          ...base.contextStates["ctx-1"],
          landingIntent: intents["ctx-1"],
        },
        "ctx-fan-in": {
          contextId: "ctx-fan-in",
          status: "completed",
          totalTaskCount: 1,
          landingIntent: intents["ctx-fan-in"],
        },
        "ctx-solo": {
          contextId: "ctx-solo",
          status: "running",
          totalTaskCount: 1,
          landingIntent: intents["ctx-solo"],
        },
      },
    });
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (reloaded === null) throw new Error("maximal execution must reload");

    for (const [contextId, intent] of Object.entries(intents)) {
      expect(
        reloaded.contextStates[contextId]?.landingIntent,
        `${intent.mode} landing intent did not survive the round trip`,
      ).toEqual(intent);
    }
    // All three modes, not one mode three times.
    expect(
      new Set(Object.values(intents).map((intent) => intent.mode)).size,
    ).toBe(3);
  });

  // The superseded half of R14.2. Absence is a SCHEMA property, not a
  // code-search result: a re-added `commitStatus` would become a second,
  // contradictory answer to "did this context's work land" — the question
  // landingIntent now owns — and nothing else in the suite would notice.
  it("declares no superseded field anywhere in the execution schema", () => {
    const projection = JSON.stringify(
      z.toJSONSchema(graphWorkflowExecutionSchema, {
        io: "output",
        unrepresentable: "any",
        cycles: "ref",
      }),
    );
    for (const name of D4_SUPERSEDED_FIELD_NAMES) {
      expect(
        projection.includes(`"${name}"`),
        `${name} was superseded by the D4 inventory and must not be persisted`,
      ).toBe(false);
    }
  });

  // The other superseded shape: an append-only decision ARRAY in the blob. The
  // events table holds the history; the blob holds latest markers only, keyed
  // so a re-decision replaces rather than appends. A record keyed by pass /
  // source is what makes that bound structural rather than a convention.
  it("keeps the decision ledgers as replace-in-place records, not in-blob arrays", () => {
    for (const path of [
      "loopStates.*.decisions",
      "routeSettlements",
      "routeControlRevisions",
    ]) {
      const node = resolveExecutionSchemaAtPath(path);
      expect(node, `${path} must resolve`).not.toBeNull();
      expect(
        node instanceof z.ZodRecord ||
          (node instanceof z.ZodDefault &&
            node.def.innerType instanceof z.ZodRecord),
        `${path} must be a keyed record so a re-decision replaces its entry`,
      ).toBe(true);
    }
  });
});

describe("graph-workflow-executions-repo pre-D4 floor", () => {
  /**
   * A row a pre-D4 build wrote: the maximal fixture with EXACTLY the D4
   * inventory removed, spliced back into the two stored tiers. Written straight
   * to SQLite because `setActive` parses first and would reject the legacy
   * shape (`edges[].id` is required) before it ever reached the column.
   */
  function seedPreD4Row(): void {
    // Establish the row (and its FK-valid identity) with a normal write, then
    // overwrite both tier blobs with the stripped bytes.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );

    const preD4 = stripD4PersistedFields(maximalExecution());
    const pick = (keys: readonly string[]): Record<string, unknown> =>
      Object.fromEntries(
        keys.filter((key) => key in preD4).map((key) => [key, preD4[key]]),
      );

    db.prepare(
      `UPDATE graph_workflow_executions
          SET definition_json = ?, runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(
      JSON.stringify(pick(DEFINITION_TIER_KEYS)),
      JSON.stringify(pick(RUNTIME_TIER_KEYS)),
      PROJECT_PATH,
      SESSION_NAME,
    );
  }

  // R14.1's dormant floor, proven at the persistence boundary rather than in a
  // schema unit test: the whole D4 inventory absent from the stored bytes has to
  // read back as unconditional edges, no loops, expansion disabled, and nothing
  // recorded — and the edge ids the post-D4 schema requires have to be repaired,
  // not refused.
  it("loads a stored row with the whole D4 inventory absent to the dormant floor", () => {
    seedPreD4Row();

    // A fresh repo instance bypasses the parsed-row cache, so this decodes the
    // edited bytes rather than returning the in-memory object.
    const loaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (loaded === null) throw new Error("pre-D4 row must load");

    expect(loaded.workingDefinition.edges.map((edge) => edge.id)).toEqual([
      "ctx-1__ctx-2",
    ]);
    expect(loaded.workingDefinition.loopGroups).toBeUndefined();
    expect(loaded.contextStates["ctx-1"]?.skipReason).toBeNull();
    expect(loaded.contextStates["ctx-1"]?.landingIntent).toBeNull();
    expect(loaded.routeSettlements).toEqual({});
    expect(loaded.routeControlRevisions).toEqual({});
    expect(loaded.loopStates).toEqual({});
    expect(loaded.expansionReceipts).toEqual({ accepted: [], refusals: [] });

    // Read the same way R14.1's observational-equivalence harness reads it, so
    // "dormant" here means what the compat floor means by it.
    expect(projectExecutionTierFloor(loaded)).toEqual({
      edgeActivation: "all-unconditional",
      loops: "none-declared",
      expansionAuthority: "disabled-on-every-context",
      routing: "no-recorded-decisions",
      skips: "none",
    });
  });

  // The floor is a READ-time repair plus schema defaults, which is what makes an
  // ordered data migration unnecessary — but only if the next write persists the
  // repaired shape. Otherwise every load re-derives ids that nothing ever
  // durably agrees on.
  it("persists the repaired edge ids on the next write, so the repair happens once", () => {
    seedPreD4Row();
    const repaired = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (repaired === null) throw new Error("pre-D4 row must load");

    createGraphWorkflowExecutionsRepo(db).setActive(
      PROJECT_PATH,
      SESSION_NAME,
      repaired,
      "2026-03-02T00:00:00Z",
    );

    const row = db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
    const stored = JSON.parse(row.definition_json) as {
      workingDefinition: { edges: { id?: string }[] };
    };
    expect(stored.workingDefinition.edges.map((edge) => edge.id)).toEqual([
      "ctx-1__ctx-2",
    ]);
  });
});

describe("graph-workflow-executions-repo captured context outputs", () => {
  // R4.1: the captured structured output is durable state, not an in-memory
  // convenience. The real persistence fixture supplies the production DDL and
  // the real FK-parent repositories, and the reload runs through a repo
  // instance that never saw the write, so nothing but the SQLite row can
  // satisfy the assertion.
  it("round-trips a non-trivial per-context structured output through setActive -> getActive", () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);

      // The maximal fixture's own captured output — one definition of the
      // payload, shared with the durability harness, so the two cannot drift.
      const execution = maximalExecution();
      const captured = execution.contextOutputs["ctx-1"];
      if (captured === undefined) throw new Error("fixture output missing");

      fixture.graphWorkflowExecutions.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        execution,
        "2026-03-01T00:00:00Z",
      );

      // A repo instance that never saw the write has no parsed-row cache to
      // answer from — this is the post-restart read.
      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );

      expect(reloaded?.contextOutputs["ctx-1"]).toEqual(captured);
      // Spot-check the nested payload survives whole: a dropped array element or
      // a null coerced to undefined would still satisfy a shallow key check.
      const value = reloaded?.contextOutputs["ctx-1"]?.value;
      expect(value).toMatchObject({
        verdict: "pass",
        taskValidation: "reviewed",
        score: 0.94,
        followUp: null,
      });
      expect(value?.["findings"]).toEqual([
        {
          id: "f-1",
          severity: "high",
          file: "src/lib/foo.ts",
          line: 42,
          tags: ["perf", "api"],
        },
      ]);

      // The reloaded payload is still an ACCEPTED output for its context — the
      // round-trip preserved conformance, not just bytes.
      const authored = execution.workingDefinition.executionContexts.find(
        (context) => context.id === "ctx-1",
      )?.outputSchema;
      if (authored === undefined) throw new Error("ctx-1 outputSchema missing");
      expect(validateJsonSchemaSubset(authored, value)).toEqual({
        valid: true,
      });
    } finally {
      fixture.close();
    }
  });

  // D5 admits only successfully validated candidates into contextOutputs —
  // rejected ones live in the validation-failure records. A durability fixture
  // is evidence about a real persisted state, so an entry its own context's
  // authored schema would reject proves nothing about a state the engine can
  // reach. Checked against the canonical validator rather than by eye, and over
  // EVERY entry, so it keeps holding as fixtures grow.
  it("only carries context outputs their own context's authored outputSchema accepts", () => {
    const execution = maximalExecution();
    const entries = Object.entries(execution.contextOutputs);
    expect(
      entries.length,
      "the maximal fixture must carry at least one captured output",
    ).toBeGreaterThan(0);

    for (const [contextId, output] of entries) {
      const authored = execution.workingDefinition.executionContexts.find(
        (context) => context.id === contextId,
      )?.outputSchema;
      expect(
        authored,
        `${contextId} has a captured output, so it must declare an outputSchema`,
      ).toBeDefined();
      if (authored === undefined) continue;
      // The declaration itself must be inside the supported subset, or the
      // acceptance below would be vacuous (unenforced keywords silently pass).
      expect(
        validateOutputSchemaDeclaration(authored),
        `${contextId} outputSchema must be a legal declaration`,
      ).toEqual([]);
      expect(
        validateJsonSchemaSubset(authored, output.value),
        `${contextId} captured output must be accepted by its authored schema`,
      ).toEqual({ valid: true });
    }
  });

  // R8.1: an expansion receipt is the durable audit of a structural mutation an
  // agent asked for. Proven against real SQLite through the production DDL,
  // because a JS-object fake cannot show that the permanent acceptance ledger
  // and the bounded refusal ring survive a restart — and the whole idempotency
  // contract (replay an acceptance, re-refuse a retained refusal) is a promise
  // about state that outlives the process that made it.
  it("round-trips accepted receipts and the refusal ring through real SQLite", () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);

      const execution = maximalExecution();
      const receipts = execution.expansionReceipts;
      expect(
        receipts.accepted.length,
        "the maximal fixture must carry an acceptance receipt",
      ).toBeGreaterThan(0);
      expect(
        receipts.refusals.length,
        "the maximal fixture must carry a refusal receipt",
      ).toBeGreaterThan(0);

      fixture.graphWorkflowExecutions.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        execution,
        "2026-03-01T00:00:00Z",
      );

      // A repo instance that never saw the write has no parsed-row cache to
      // answer from — this is the post-restart read.
      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );

      expect(reloaded?.expansionReceipts).toEqual(receipts);

      // Provenance resolves per NODE after the reload, which is the property
      // R8 names: any expansion-created id answers who added it and why.
      const accepted = receipts.accepted[0];
      if (accepted === undefined) throw new Error("fixture receipt missing");
      const addedContextId = accepted.addedContextIds[0];
      const addedTaskId = accepted.addedTaskIds[0];
      if (addedContextId === undefined || addedTaskId === undefined) {
        throw new Error("fixture receipt must name added ids");
      }
      const reloadedReceipts = reloaded?.expansionReceipts;
      if (reloadedReceipts === undefined) {
        throw new Error("reloaded receipts missing");
      }
      expect(
        resolveExpansionProvenance(reloadedReceipts, addedContextId),
      ).toEqual({ nodeKind: "context", receipt: accepted });
      expect(resolveExpansionProvenance(reloadedReceipts, addedTaskId)).toEqual(
        { nodeKind: "task", receipt: accepted },
      );
      expect(resolveExpansionProvenance(reloadedReceipts, "ctx-1")).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it("admits a pre-feature row with no expansionReceipts via the additive default", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT runtime_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { runtime_json: string };
    const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;
    expect(
      runtime.expansionReceipts,
      "fixture must persist a non-default expansionReceipts record",
    ).toBeDefined();
    delete runtime.expansionReceipts;
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(runtime), PROJECT_PATH, SESSION_NAME);

    const loaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(loaded?.expansionReceipts).toEqual({ accepted: [], refusals: [] });
  });

  it("admits a pre-feature row with no contextOutputs via the additive default of {}", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT runtime_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { runtime_json: string };
    const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;
    expect(
      Object.keys(runtime.contextOutputs as Record<string, unknown>).length > 0,
      "fixture must persist a non-default contextOutputs map",
    ).toBe(true);
    delete runtime.contextOutputs;
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(runtime), PROJECT_PATH, SESSION_NAME);

    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.contextOutputs).toEqual({});
  });
});

describe("graph-workflow-executions-repo behavior", () => {
  it("returns null when no active execution exists", () => {
    expect(repo.getActive(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("round-trips the awaiting_user_input status and a populated pendingUserInput record", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    // A fresh repo instance bypasses the parsed-row cache so the read decodes
    // the persisted blob rather than returning the in-memory object.
    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    const ctx = reloaded?.contextStates["ctx-1"];
    expect(ctx?.status).toBe("awaiting_user_input");
    expect(ctx?.pendingUserInputs).toEqual(
      execution.contextStates["ctx-1"]?.pendingUserInputs,
    );
    expect(
      ctx?.pendingUserInputs["context_validator:security-reviewer"]?.answers
        ?.byQuestionId["q-1"]?.selected,
    ).toEqual(["Redis"]);
  });

  it("deletes the active row on setActive(null)", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    expect(repo.getActive(PROJECT_PATH, SESSION_NAME)).not.toBeNull();

    const removed = repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      null,
      "2026-03-02T00:00:00Z",
    );
    expect(removed).toBe(true);
    expect(repo.getActive(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("rewrites runtime-only when the definition tier is unchanged but the runtime changes", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const definitionBefore = db
      .prepare(
        `SELECT definition_json, runtime_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as {
      definition_json: string;
      runtime_json: string;
    };

    // Mutate only a runtime-tier field; the definition tier is byte-identical.
    const next = graphWorkflowExecutionSchema.parse({
      ...execution,
      status: "completed",
      completedAt: "2026-03-05T00:00:00Z",
    });
    repo.setActive(PROJECT_PATH, SESSION_NAME, next, "2026-03-02T00:00:00Z");

    const after = db
      .prepare(
        `SELECT definition_json, runtime_json, status, completed_at
           FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as {
      definition_json: string;
      runtime_json: string;
      status: string;
      completed_at: string | null;
    };

    expect(after.definition_json).toBe(definitionBefore.definition_json);
    expect(after.runtime_json).not.toBe(definitionBefore.runtime_json);
    expect(after.status).toBe("completed");
    expect(after.completed_at).toBe("2026-03-05T00:00:00Z");

    const reloaded = repo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.completedAt).toBe("2026-03-05T00:00:00Z");
  });

  it("admits a pre-feature row with no bound-input snapshot via the additive default", () => {
    // Write a normal execution, then strip `boundInputs` from the stored
    // definition tier to simulate a row persisted before the field existed.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
    const definition = JSON.parse(row.definition_json) as Record<
      string,
      unknown
    >;
    expect(definition.boundInputs, "fixture must persist boundInputs").toEqual({
      feature: "search box",
      notes: "first line\nsecond line",
    });
    delete definition.boundInputs;
    db.prepare(
      `UPDATE graph_workflow_executions SET definition_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(definition), PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the parsed-row cache, decoding the edited
    // row; the schema's `.default({})` admits the legacy shape.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.boundInputs).toEqual({});
  });

  it("admits a pre-feature row with no launched-tier via the additive 'project' default", () => {
    // Write a normal execution, then strip `launchedTier` from the stored
    // definition tier to simulate a row persisted before the field existed.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
    const definition = JSON.parse(row.definition_json) as Record<
      string,
      unknown
    >;
    expect(
      definition.launchedTier,
      "fixture must persist a non-default launchedTier",
    ).toBe("global");
    delete definition.launchedTier;
    db.prepare(
      `UPDATE graph_workflow_executions SET definition_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(definition), PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the parsed-row cache, decoding the edited
    // row; the schema's `.default("project")` admits the legacy shape.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.launchedTier).toBe("project");
  });

  it("admits a pre-feature row with no liveRevision via the additive default of 1", () => {
    // Write a normal execution, then strip `liveRevision` from the stored
    // runtime tier to simulate a row persisted before the field existed.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT runtime_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { runtime_json: string };
    const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;
    expect(
      runtime.liveRevision,
      "fixture must persist a non-default liveRevision",
    ).toBe(4);
    delete runtime.liveRevision;
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(runtime), PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the parsed-row cache, decoding the edited
    // row; the schema's `.default(1)` admits the legacy shape.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.liveRevision).toBe(1);
  });

  it("admits a pre-feature row with no charterAmendments via the additive default of []", () => {
    // Write a normal execution, then strip `charterAmendments` from the stored
    // runtime tier to simulate a row persisted before the field existed.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT runtime_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { runtime_json: string };
    const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;
    expect(
      Array.isArray(runtime.charterAmendments) &&
        runtime.charterAmendments.length > 0,
      "fixture must persist a non-default charterAmendments log",
    ).toBe(true);
    delete runtime.charterAmendments;
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(runtime), PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the parsed-row cache, decoding the edited
    // row; the schema's `.default([])` admits the legacy shape.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.charterAmendments).toEqual([]);
  });

  it("admits a pre-D1 row with no planRepairRounds via the additive default of []", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT runtime_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { runtime_json: string };
    const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;
    expect(
      Array.isArray(runtime.planRepairRounds) &&
        runtime.planRepairRounds.length > 0,
      "fixture must persist a non-default planRepairRounds log",
    ).toBe(true);
    delete runtime.planRepairRounds;
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(runtime), PROJECT_PATH, SESSION_NAME);

    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.planRepairRounds).toEqual([]);
  });

  it("recreates the row via a full upsert when the runtime-only UPDATE matches zero rows", () => {
    const execution = maximalExecution();
    // First write warms the per-instance definition-hash cache.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    // Delete the row out-of-band WITHOUT going through setActive(null), so the
    // hash cache still believes the (unchanged) definition is already on disk.
    db.prepare(
      `DELETE FROM graph_workflow_executions
        WHERE project_path = ? AND session_name = ?`,
    ).run(PROJECT_PATH, SESSION_NAME);

    // A re-write with the SAME definition tier takes the runtime-only UPDATE
    // path (hash matches). Without the defensive fallback the UPDATE would
    // match 0 rows and the execution would be lost while events accumulate.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-02T00:00:00Z",
    );

    const row = db
      .prepare(
        `SELECT execution_id, definition_json, runtime_json
           FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as
      | { execution_id: string; definition_json: string; runtime_json: string }
      | undefined;
    expect(row, "row must be recreated, not silently dropped").toBeDefined();
    expect(row?.execution_id).toBe(execution.id);

    // The merged read reconstructs the full execution from the recreated row.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    expect(freshRepo.getActive(PROJECT_PATH, SESSION_NAME)?.id).toBe(
      execution.id,
    );
  });

  it("bumps cacheVersion on every write", () => {
    const v0 = repo.cacheVersion;
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const v1 = repo.cacheVersion;
    expect(v1).toBeGreaterThan(v0);
    repo.setActive(PROJECT_PATH, SESSION_NAME, null, "2026-03-02T00:00:00Z");
    expect(repo.cacheVersion).toBeGreaterThan(v1);
  });

  it("lists active executions across sessions keyed by project+session", () => {
    db.prepare(
      `INSERT INTO sessions (
         project_path, session_name, worktree_path, branch_name,
         created_at, last_activity_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      "s2",
      `${PROJECT_PATH}/.worktrees/s2`,
      "csm/s2",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );

    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    repo.setActive(
      PROJECT_PATH,
      "s2",
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );

    const all = repo.listActive();
    expect(all.size).toBe(2);
    const SEP = String.fromCharCode(0);
    expect(all.get(`${PROJECT_PATH}${SEP}${SESSION_NAME}`)?.id).toBe(
      "wf-maximal",
    );
    expect(all.get(`${PROJECT_PATH}${SEP}s2`)?.id).toBe("wf-maximal");
  });

  it("quarantines a corrupt runtime_json blob on read", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run("{not valid json", PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the in-memory parsed-row cache so the read
    // actually hits the corrupt blob.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    expect(() => freshRepo.getActive(PROJECT_PATH, SESSION_NAME)).toThrow();
  });
});

describe("graph-workflow-executions-repo derived lease projection", () => {
  function leaseHeld(): number {
    const row = db
      .prepare(
        `SELECT lease_held FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { lease_held: number };
    return row.lease_held;
  }

  function write(patch: Partial<GraphWorkflowExecution>): void {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      graphWorkflowExecutionSchema.parse({ ...maximalExecution(), ...patch }),
      "2026-03-01T00:00:00Z",
    );
  }

  const RESUMABLE_HALT = {
    type: "agent_turn_failed",
    contextId: "ctx-1",
    engine: "claude",
    cause: "sdk_error",
    message: "turn failed",
  } as const;

  // D15: derived on write from the full record, never declared by a caller —
  // the structural-revision pattern, so a writer cannot forget it.
  it("derives lease_held from status, halt reason, and abandonment on every write", () => {
    write({ status: "running", haltReason: null, abandonment: null });
    expect(leaseHeld()).toBe(1);

    write({ status: "completed", haltReason: null, abandonment: null });
    expect(leaseHeld()).toBe(0);

    write({ status: "halted", haltReason: RESUMABLE_HALT, abandonment: null });
    expect(leaseHeld()).toBe(1);

    write({
      status: "halted",
      haltReason: { type: "recovery_error", message: "unrecoverable" },
      abandonment: null,
    });
    expect(leaseHeld()).toBe(0);

    write({
      status: "halted",
      haltReason: RESUMABLE_HALT,
      abandonment: {
        abandonedAt: "2026-03-02T00:00:00.000Z",
        actor: { kind: "human" },
        reason: "superseded",
      },
    });
    expect(leaseHeld()).toBe(0);
  });

  // Status, halt reason, and abandonment all live in the RUNTIME tier, so the
  // release almost always arrives on the runtime-only UPDATE path. A projection
  // written on the full-upsert path alone would leave a finished run looking
  // ambient-active until its definition happened to change.
  it("moves the projection on the runtime-only write path", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      graphWorkflowExecutionSchema.parse({
        ...execution,
        status: "running",
        abandonment: null,
      }),
      "2026-03-01T00:00:00Z",
    );
    const definitionBefore = db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
    expect(leaseHeld()).toBe(1);

    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      graphWorkflowExecutionSchema.parse({
        ...execution,
        status: "aborted",
        abandonment: null,
        completedAt: "2026-03-02T00:00:00Z",
      }),
      "2026-03-02T00:00:00Z",
    );

    const after = db
      .prepare(
        `SELECT definition_json, lease_held FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as {
      definition_json: string;
      lease_held: number;
    };
    expect(
      after.definition_json,
      "this must exercise the runtime-only path, not a full upsert",
    ).toBe(definitionBefore.definition_json);
    expect(after.lease_held).toBe(0);
  });

  it("re-derives the projection when a legacy row is upgraded on read", () => {
    // Establish a row whose stored bytes say completed while the column lies.
    write({ status: "completed", haltReason: null, abandonment: null });
    db.prepare(
      `UPDATE graph_workflow_executions SET lease_held = 1
        WHERE project_path = ? AND session_name = ?`,
    ).run(PROJECT_PATH, SESSION_NAME);

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (reloaded === null) throw new Error("execution must reload");
    createGraphWorkflowExecutionsRepo(db).setActive(
      PROJECT_PATH,
      SESSION_NAME,
      reloaded,
      "2026-03-03T00:00:00Z",
    );

    expect(leaseHeld()).toBe(0);
  });
});

describe("graph-workflow-executions-repo one-off origin persistence", () => {
  /**
   * The pre-D7 required shape of the projection columns: every older reader,
   * including the `NOT NULL` constraints themselves, resolves a run through
   * these. A one-off run has no definition record anywhere, so it writes the
   * legacy-shaped filler rather than leaving them empty.
   */
  const preD7ProjectionSchema = z.object({
    execution_id: z.string().min(1),
    seed_definition_id: z.string().min(1),
    seed_definition_revision: z.number().int().min(1),
    started_at: z.string().min(1),
    status: z.string().min(1),
  });

  function oneOffExecution(): GraphWorkflowExecution {
    const base = maximalExecution();
    return graphWorkflowExecutionSchema.parse({
      ...base,
      origin: { kind: "one_off", planName: "Ship the search box" },
      ...buildOneOffSeedCompatibilityFields(base.id),
    });
  }

  it("keeps a one-off row readable through the pre-D7 required-field shape", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      oneOffExecution(),
      "2026-03-01T00:00:00Z",
    );

    const row = db
      .prepare(
        `SELECT execution_id, seed_definition_id, seed_definition_revision,
                started_at, status
           FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME);
    expect(preD7ProjectionSchema.safeParse(row).success).toBe(true);
    expect(
      (row as { seed_definition_id: string }).seed_definition_id,
    ).toContain(ONE_OFF_SEED_DEFINITION_ID_PREFIX);
  });

  it("reloads a one-off run by its origin, never by the seed sentinel", () => {
    const execution = oneOffExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(reloaded?.origin).toEqual({
      kind: "one_off",
      planName: "Ship the search box",
    });
    expect(reloaded?.launchDocument).toEqual(execution.launchDocument);
    // The filler survives untouched, so an older build still parses the row.
    expect(reloaded?.seedDefinitionId).toBe(execution.seedDefinitionId);
    expect(reloaded?.seedDefinitionRevision).toBe(1);
  });

  it("stores the same projections on a fresh floor and on a 0024-upgraded schema", async () => {
    const upgraded = _createTestDb({ inMemory: true });
    try {
      // Take the upgraded database back to the pre-0024 shape, then let the
      // migration bring it forward — the path a live database actually walks.
      upgraded.exec(`
        DROP TABLE graph_workflow_result_deliveries;
        ALTER TABLE graph_workflow_executions DROP COLUMN lease_held;
      `);
      await executionLeaseAndResultDeliveries.up({
        name: executionLeaseAndResultDeliveries.name,
        context: { db: upgraded, configDir: null },
      });
      upgraded
        .prepare("INSERT INTO projects (root_path) VALUES (?)")
        .run(PROJECT_PATH);
      upgraded
        .prepare(
          `INSERT INTO sessions (
             project_path, session_name, worktree_path, branch_name,
             created_at, last_activity_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          PROJECT_PATH,
          SESSION_NAME,
          `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
          `csm/${SESSION_NAME}`,
          "2026-01-01T00:00:00Z",
          "2026-01-01T00:00:00Z",
        );

      const execution = oneOffExecution();
      const read = `SELECT execution_id, seed_definition_id, seed_definition_revision,
                           started_at, status, completed_at, definition_json,
                           runtime_json, updated_at, lease_held
                      FROM graph_workflow_executions
                     WHERE project_path = ? AND session_name = ?`;
      repo.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        execution,
        "2026-03-01T00:00:00Z",
      );
      createGraphWorkflowExecutionsRepo(upgraded).setActive(
        PROJECT_PATH,
        SESSION_NAME,
        execution,
        "2026-03-01T00:00:00Z",
      );

      expect(upgraded.prepare(read).get(PROJECT_PATH, SESSION_NAME)).toEqual(
        db.prepare(read).get(PROJECT_PATH, SESSION_NAME),
      );
    } finally {
      upgraded.close();
    }
  });
});

describe("graph-workflow-executions-repo spec-delivery origin persistence", () => {
  const preD7ProjectionSchema = z.object({
    execution_id: z.string().min(1),
    seed_definition_id: z.string().min(1),
    seed_definition_revision: z.number().int().min(1),
    started_at: z.string().min(1),
    status: z.string().min(1),
  });

  function specDeliveryExecution(): GraphWorkflowExecution {
    const base = maximalExecution();
    return graphWorkflowExecutionSchema.parse({
      ...base,
      origin: {
        kind: "spec_delivery",
        specSlug: "conversation-compaction",
        candidateId: "cand-42",
      },
      ...buildSpecDeliverySeedCompatibilityFields(base.id),
    });
  }

  it("keeps a spec-delivery row readable through the pre-D7 required-field shape", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      specDeliveryExecution(),
      "2026-03-01T00:00:00Z",
    );

    const row = db
      .prepare(
        `SELECT execution_id, seed_definition_id, seed_definition_revision,
                started_at, status
           FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME);
    expect(preD7ProjectionSchema.safeParse(row).success).toBe(true);
    expect(
      (row as { seed_definition_id: string }).seed_definition_id,
    ).toContain(SPEC_DELIVERY_SEED_DEFINITION_ID_PREFIX);
  });

  it("reloads a spec-delivery run by its origin, never by the seed sentinel", () => {
    const execution = specDeliveryExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(reloaded?.origin).toEqual({
      kind: "spec_delivery",
      specSlug: "conversation-compaction",
      candidateId: "cand-42",
    });
    expect(reloaded?.launchDocument).toEqual(execution.launchDocument);
    // The filler survives untouched, so an older build still parses the row.
    expect(reloaded?.seedDefinitionId).toBe(execution.seedDefinitionId);
    expect(reloaded?.seedDefinitionRevision).toBe(1);
  });
});

describe("graph-workflow-executions owner identity durability", () => {
  it("round-trips the seed-time ownerConversationId through SQLite", () => {
    const execution: GraphWorkflowExecution = {
      ...maximalExecution(),
      ownerConversationId: "conv-owner-1",
    };
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    // A fresh repo instance bypasses the parsed-row cache so the read decodes
    // the persisted blob rather than returning the in-memory object.
    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(reloaded?.ownerConversationId).toBe("conv-owner-1");
  });

  it("floors a row written before the owner field existed to a null owner", () => {
    const execution: GraphWorkflowExecution = {
      ...maximalExecution(),
      ownerConversationId: "conv-owner-1",
    };
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    // Reshape the stored blob into a genuine pre-field row: the key is absent
    // from definition_json exactly as every execution written before this
    // change looks on disk.
    const row = db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
    const legacy: Record<string, unknown> = JSON.parse(row.definition_json);
    expect(legacy).toHaveProperty("ownerConversationId");
    delete legacy["ownerConversationId"];
    db.prepare(
      `UPDATE graph_workflow_executions SET definition_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(legacy), PROJECT_PATH, SESSION_NAME);

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(reloaded).not.toBeNull();
    expect(reloaded?.ownerConversationId).toBeNull();
  });
});
