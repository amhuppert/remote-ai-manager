import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import {
  createGraphWorkflowEventsRepo,
  type GraphWorkflowEventsRepo,
} from "@/lib/state-store/graph-workflow-events-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { graphWorkflowExecutionEventSchema } from "@/lib/workflow-graph/event-schemas";
import {
  createEvidenceService,
  type EvidenceServiceDeps,
} from "./evidence-service";
import {
  createEvidenceIngestService,
  type EvidenceIngestDeps,
} from "./evidence-ingest";
import type { CompiledOriginMapEntry } from "./compiler";

type Db = InstanceType<typeof Database>;

const projectPath = "/repos/evidence-ingest";
const sessionName = "evidence-session";
const workflowExecutionId = "workflow-execution-evidence";
const specExecutionId = "spec-execution-evidence";
const specId = "spec-evidence-ingest";
const revisionId = "revision-evidence-ingest";
const now = "2026-07-18T14:00:00.000Z";

describe("EvidenceIngest", () => {
  let db: Db;
  let deps: EvidenceIngestDeps;
  let originMap: CompiledOriginMapEntry[];
  let workflowEvents: GraphWorkflowEventsRepo;

  beforeEach(() => {
    db = _createTestDb();
    seedParents(db);
    workflowEvents = createGraphWorkflowEventsRepo(db);

    const repo = createSpecDeliveryRepo(db);
    let nextEvidenceId = 0;
    const evidenceService = createEvidenceService({
      repo,
      ingestExecutionEvidence: async () => undefined,
      nextId: () => `ingested-evidence-${++nextEvidenceId}`,
      now: () => now,
      getApprovedCriterion: async (targetRevisionId, criterionElementId) =>
        targetRevisionId === revisionId &&
        ["criterion-1", "criterion-2", "criterion-3"].includes(
          criterionElementId,
        )
          ? {
              specId,
              validationStrategy: {
                kinds:
                  criterionElementId === "criterion-1"
                    ? ["commit", "test_run", "validator_verdict"]
                    : ["validator_verdict"],
              },
            }
          : null,
      gitObjectExists: async (ref) =>
        ["commit-abc", "commit-other"].includes(ref.objectId),
      workflowEventExists: async (ref, expectedExecution) => {
        const record = workflowEvents.findRecordById(ref.eventId);
        return (
          record !== null &&
          record.executionId === expectedExecution.workflowExecutionId &&
          "contextId" in record.event &&
          record.event.contextId === ref.contextId
        );
      },
      mergeValidationFactExists: async () => false,

      isEvidenceFresh: async () => true,
      routeStrategyInadequacy: async () => undefined,
      routeWaiverRequestToHuman: async () => ({ attentionId: "unused" }),
      getTaskClaimContext: async () => null,
      getCriterionVersion: async () => null,
      wasCriterionDeliveredByMergedExecution: async () => false,
      recordMutation: () => undefined,
      runInImmediateTransaction: (operation) => operation(),
    } satisfies EvidenceServiceDeps);
    const writeQueue = createWriteQueue();
    originMap = [
      {
        contextId: "context-task-1",
        taskElementId: "task-1",
        taskHandle: "native-sdd/T1",
        touchedPaths: ["src/lib/specs/evidence-ingest.ts"],
        criterionElementIds: ["criterion-1", "criterion-2"],
        criterionHandles: ["native-sdd/R1.1", "native-sdd/R1.2"],
        validationStrategies: {
          "criterion-1": {
            kinds: ["commit", "test_run", "validator_verdict"],
          },
          "criterion-2": { kinds: ["validator_verdict"] },
        },
        criterionBriefs: {
          "criterion-1": "Validate criterion 1.",
          "criterion-2": "Validate criterion 2.",
        },
      },
      {
        contextId: "context-task-2",
        taskElementId: "task-2",
        taskHandle: "native-sdd/T2",
        touchedPaths: ["src/lib/specs/other-context.ts"],
        criterionElementIds: ["criterion-3"],
        criterionHandles: ["native-sdd/R2.1"],
        validationStrategies: {
          "criterion-3": { kinds: ["validator_verdict"] },
        },
        criterionBriefs: {
          "criterion-3": "Validate criterion 3.",
        },
      },
    ];

    deps = {
      repo,
      workflowEvents,
      evidenceService,
      writeQueue,
      validatedTreeHash: vi.fn(
        async (_execution, commitSha, relevantPaths) =>
          `${commitSha}:${relevantPaths.join(",")}`,
      ),
      loadOriginMap: async () => originMap,
      getWorkflowExecutionStatus: async () => "running",
    };
  });

  function appendEvents(
    events: Array<{ occurredAt: string; event: Record<string, unknown> }>,
  ): void {
    workflowEvents.appendMany(
      projectPath,
      sessionName,
      workflowExecutionId,
      now,
      events.map((entry) => graphWorkflowExecutionEventSchema.parse(entry)),
    );
  }

  function validationResult(
    contextId: string,
    occurredAt: string,
    pass = true,
    kind: "context_validation" | "output_schema" = "context_validation",
  ): { occurredAt: string; event: Record<string, unknown> } {
    return {
      occurredAt,
      event: {
        type: "graph-workflow-validation-result",
        projectName: "evidence-ingest",
        sessionName,
        executionId: workflowExecutionId,
        contextId,
        validatorType: "context",
        kind,
        pass,
        summary: pass
          ? "Compiler contract and focused tests pass."
          : "A distinct criterion still fails.",
        sessionRef: {
          backend: "codex",
          ref: "validator-response-1",
          lane: "context_validator",
          refKind: "backend",
        },
      },
    };
  }

  function laneCommit(
    contextId: string,
    sha: string,
    occurredAt: string,
  ): { occurredAt: string; event: Record<string, unknown> } {
    return {
      occurredAt,
      event: {
        type: "graph-workflow-lane-commit",
        projectName: "evidence-ingest",
        sessionName,
        executionId: workflowExecutionId,
        contextId,
        laneId: `lane-${contextId}`,
        sha,
        committedAt: occurredAt,
      },
    };
  }

  // Production ordering: a context's validation results precede the lane
  // commit that seals its tree; a failed context that never converged has no
  // subsequent same-context event at all.
  function appendProductionShapedEvents(): void {
    appendEvents([
      validationResult("context-task-1", "2026-07-18T13:58:00.000Z"),
      laneCommit("context-task-1", "commit-abc", "2026-07-18T13:59:00.000Z"),
      validationResult("context-task-2", "2026-07-18T13:59:30.000Z", false),
    ]);
  }

  it("13.7 folds a seeded workflow log twice into one identical criterion-routed evidence set", async () => {
    appendProductionShapedEvents();
    const service = createEvidenceIngestService(deps);

    const first = await service.ingestAuthoritatively(specExecutionId);
    const afterFirst = readEvidence(db);
    const second = await service.ingestAuthoritatively(specExecutionId);
    const afterSecond = readEvidence(db);

    // context-task-2's validation has no subsequent same-context event on a
    // live execution: its stamp is undecidable, so it defers (no row yet).
    expect(first).toMatchObject({
      scannedEventCount: 3,
      ignoredEventCount: 1,
      materializedEvidenceCount: 5,
      existingEvidenceCount: 0,
    });
    expect(second).toMatchObject({
      scannedEventCount: 3,
      materializedEvidenceCount: 0,
      existingEvidenceCount: 5,
    });
    expect(afterSecond).toEqual(afterFirst);
    expect(
      afterSecond.map((row) => [
        row.criterion_element_id,
        row.kind,
        row.source_event_id,
      ]),
    ).toEqual([
      ["criterion-1", "test_run", 1],
      ["criterion-1", "validator_verdict", 1],
      ["criterion-2", "validator_verdict", 1],
      ["criterion-1", "commit", 2],
      ["criterion-2", "commit", 2],
    ]);
    const commitRow = afterSecond.find((row) => row.kind === "commit");
    expect(JSON.parse(commitRow?.ref_json ?? "{}")).toEqual({
      type: "git_object",
      objectId: "commit-abc",
    });
    // The sealed validation carries the lane HEAD that snapshotted its tree.
    for (const row of afterSecond.filter((entry) => entry.kind !== "commit")) {
      expect(JSON.parse(row.evaluated_state_json)).toEqual({
        commitSha: "commit-abc",
        relevantPaths: ["src/lib/specs/evidence-ingest.ts"],
        relevantTreeHash: "commit-abc:src/lib/specs/evidence-ingest.ts",
      });
    }
    expect(
      deps.repo.findProofVerdictsByCriterionRevision("criterion-1", revisionId),
    ).toHaveLength(1);
    expect(
      deps.repo.findProofVerdictsByCriterionRevision("criterion-2", revisionId),
    ).toHaveLength(1);
    expect(
      deps.repo.findProofVerdictsByCriterionRevision("criterion-3", revisionId),
    ).toHaveLength(0);
  });

  it("13.7 unions criterion mappings when legal regrouping assigns multiple compiled tasks to one context", async () => {
    appendProductionShapedEvents();
    originMap[1] = { ...originMap[1]!, contextId: "context-task-1" };
    const service = createEvidenceIngestService(deps);

    const summary = await service.ingestAuthoritatively(specExecutionId);

    expect(summary).toMatchObject({
      scannedEventCount: 3,
      ignoredEventCount: 1,
      materializedEvidenceCount: 7,
    });
    expect(
      readEvidence(db).map((row) => [
        row.criterion_element_id,
        row.kind,
        row.source_event_id,
      ]),
    ).toEqual([
      ["criterion-1", "test_run", 1],
      ["criterion-1", "validator_verdict", 1],
      ["criterion-2", "validator_verdict", 1],
      ["criterion-3", "validator_verdict", 1],
      ["criterion-1", "commit", 2],
      ["criterion-2", "commit", 2],
      ["criterion-3", "commit", 2],
    ]);
  });

  it("F24 defers a validation with no same-context follower, then stamps it from the commit that lands", async () => {
    appendEvents([
      validationResult("context-task-1", "2026-07-18T13:58:00.000Z"),
    ]);
    const service = createEvidenceIngestService(deps);

    const beforeCommit = await service.ingestAuthoritatively(specExecutionId);
    expect(beforeCommit).toMatchObject({
      scannedEventCount: 1,
      materializedEvidenceCount: 0,
      existingEvidenceCount: 0,
    });
    expect(readEvidence(db)).toEqual([]);

    appendEvents([
      laneCommit("context-task-1", "commit-abc", "2026-07-18T13:59:00.000Z"),
    ]);
    const afterCommit = await service.ingestAuthoritatively(specExecutionId);

    expect(afterCommit).toMatchObject({ materializedEvidenceCount: 5 });
    const validationRows = readEvidence(db).filter(
      (row) => row.source_event_id === 1,
    );
    expect(validationRows.map((row) => row.kind).sort()).toEqual([
      "test_run",
      "validator_verdict",
      "validator_verdict",
    ]);
    for (const row of validationRows) {
      expect(JSON.parse(row.evaluated_state_json)).toEqual({
        commitSha: "commit-abc",
        relevantPaths: ["src/lib/specs/evidence-ingest.ts"],
        relevantTreeHash: "commit-abc:src/lib/specs/evidence-ingest.ts",
      });
    }
  });

  it("F24 materializes a superseded validation unstamped and never restamps it on later runs", async () => {
    appendEvents([
      validationResult("context-task-1", "2026-07-18T13:57:00.000Z"),
      validationResult("context-task-1", "2026-07-18T13:58:00.000Z"),
      laneCommit("context-task-1", "commit-abc", "2026-07-18T13:59:00.000Z"),
    ]);
    const service = createEvidenceIngestService(deps);

    await service.ingestAuthoritatively(specExecutionId);
    const afterFirst = readEvidence(db);
    await service.ingestAuthoritatively(specExecutionId);
    const afterSecond = readEvidence(db);

    // The remediated-away first validation is honest-stale (no sha claim);
    // the sealing validation carries the commit that snapshotted its tree.
    const supersededRows = afterFirst.filter(
      (row) => row.source_event_id === 1,
    );
    const sealedRows = afterFirst.filter((row) => row.source_event_id === 2);
    expect(supersededRows).toHaveLength(3);
    expect(sealedRows).toHaveLength(3);
    for (const row of supersededRows) {
      expect(JSON.parse(row.evaluated_state_json)).toEqual({
        relevantPaths: [],
      });
    }
    for (const row of sealedRows) {
      expect(JSON.parse(row.evaluated_state_json)).toEqual({
        commitSha: "commit-abc",
        relevantPaths: ["src/lib/specs/evidence-ingest.ts"],
        relevantTreeHash: "commit-abc:src/lib/specs/evidence-ingest.ts",
      });
    }
    // Ingest-key dedup: a later run neither rewrites nor restamps rows.
    expect(afterSecond).toEqual(afterFirst);
    const [verdict] = deps.repo.findProofVerdictsByCriterionRevision(
      "criterion-1",
      revisionId,
    );
    const citedSourceEvents = (
      JSON.parse(verdict?.evidence_ids_json ?? "[]") as string[]
    ).map(
      (evidenceId) => deps.repo.findEvidenceById(evidenceId)?.source_event_id,
    );
    expect(citedSourceEvents).toEqual(expect.arrayContaining([2, 2, 3]));
    expect(citedSourceEvents).not.toContain(1);
  });

  it.each([
    ["failed context validation", "context_validation"],
    ["output-schema rejection", "output_schema"],
  ] as const)("never promotes a sealed %s into proof", async (_label, kind) => {
    appendEvents([
      validationResult(
        "context-task-1",
        "2026-07-18T13:58:00.000Z",
        false,
        kind,
      ),
      laneCommit("context-task-1", "commit-abc", "2026-07-18T13:59:00.000Z"),
    ]);

    await createEvidenceIngestService(deps).ingestAuthoritatively(
      specExecutionId,
    );

    expect(
      deps.repo.findProofVerdictsByCriterionRevision("criterion-1", revisionId),
    ).toEqual([]);
    expect(
      deps.repo.findProofVerdictsByCriterionRevision("criterion-2", revisionId),
    ).toEqual([]);
  });

  it("F24 never stamps a validation from another context's commit", async () => {
    appendEvents([
      validationResult("context-task-1", "2026-07-18T13:58:00.000Z"),
      laneCommit("context-task-2", "commit-other", "2026-07-18T13:59:00.000Z"),
    ]);
    const service = createEvidenceIngestService(deps);

    await service.ingestAuthoritatively(specExecutionId);

    const rows = readEvidence(db);
    // context-task-1's validation stays deferred; only context-task-2's
    // commit evidence materializes.
    expect(rows.map((row) => [row.criterion_element_id, row.kind])).toEqual([
      ["criterion-3", "commit"],
    ]);
  });

  it("F24 materializes deferred validations unstamped once the execution is terminal", async () => {
    appendEvents([
      validationResult("context-task-1", "2026-07-18T13:58:00.000Z"),
    ]);
    db.prepare(
      "UPDATE spec_executions SET state = 'abandoned' WHERE id = ?",
    ).run(specExecutionId);
    const service = createEvidenceIngestService(deps);

    const summary = await service.ingestAuthoritatively(specExecutionId);

    expect(summary).toMatchObject({ materializedEvidenceCount: 3 });
    const rows = readEvidence(db);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(JSON.parse(row.evaluated_state_json)).toEqual({
        relevantPaths: [],
      });
    }
  });

  // The real terminal ingest paths run BEFORE the spec execution leaves
  // "running": workflow-completed reconciliation ingests while the spec
  // execution still runs, and markDelivered ingests before the state flip.
  // Terminality therefore has to come from the graph workflow itself, or a
  // followerless final validation defers forever.
  it.each(["completed", "aborted", null] as const)(
    "F24 materializes a followerless validation unstamped when the graph workflow is %s while the spec execution still runs",
    async (workflowStatus) => {
      appendEvents([
        validationResult("context-task-1", "2026-07-18T13:58:00.000Z"),
      ]);
      const service = createEvidenceIngestService({
        ...deps,
        getWorkflowExecutionStatus: async () => workflowStatus,
      });

      const summary = await service.ingestAuthoritatively(specExecutionId);

      expect(summary).toMatchObject({ materializedEvidenceCount: 3 });
      for (const row of readEvidence(db)) {
        expect(JSON.parse(row.evaluated_state_json)).toEqual({
          relevantPaths: [],
        });
      }
    },
  );

  it.each(["running", "halted", "paused", "pending"] as const)(
    "F24 keeps deferring a followerless validation while the graph workflow is %s",
    async (workflowStatus) => {
      appendEvents([
        validationResult("context-task-1", "2026-07-18T13:58:00.000Z"),
      ]);
      const service = createEvidenceIngestService({
        ...deps,
        getWorkflowExecutionStatus: async () => workflowStatus,
      });

      const summary = await service.ingestAuthoritatively(specExecutionId);

      // A halted/paused run can resume and still land the sealing commit, so
      // the stamp stays decidable-later rather than frozen wrong.
      expect(summary).toMatchObject({ materializedEvidenceCount: 0 });
      expect(readEvidence(db)).toEqual([]);
    },
  );

  it("best-effort reads return current state immediately when the write queue is contended", async () => {
    appendProductionShapedEvents();
    const contendedQueue: EvidenceIngestDeps["writeQueue"] = {
      withWriteQueue: vi.fn(async (_label, fn) => fn()),
      withWriteQueueSync: vi.fn(async (_label, fn, ...reject) => {
        void reject; // compile-time-only guard tuple; never populated at runtime
        return fn();
      }),
      async tryWithWriteQueue<T>(): Promise<
        { acquired: true; value: T } | { acquired: false }
      > {
        return { acquired: false };
      },
      _resetForTesting: vi.fn(),
    };
    const service = createEvidenceIngestService({
      ...deps,
      writeQueue: contendedQueue,
    });

    await expect(service.ingestBestEffort(specExecutionId)).resolves.toEqual({
      status: "contended",
    });
    expect(contendedQueue.withWriteQueue).not.toHaveBeenCalled();
  });

  // R12.2: the aggregate is the SOLE evidence-ingestion record. A cohort round
  // adds per-specialist detail on the aggregate and two new event kinds, and
  // none of it may change what ingestion records or how it seals it.
  describe("a multi-assignment cohort round", () => {
    /** The aggregate a three-validator round publishes: no top-level session
     *  ref (no single reviewer owns the round), detail on the entries. */
    function cohortValidationResult(
      contextId: string,
      occurredAt: string,
      pass = true,
    ): { occurredAt: string; event: Record<string, unknown> } {
      return {
        occurredAt,
        event: {
          type: "graph-workflow-validation-result",
          projectName: "evidence-ingest",
          sessionName,
          executionId: workflowExecutionId,
          contextId,
          validatorType: "context",
          kind: "context_validation",
          pass,
          summary: "general: ok\nsecurity: ok",
          roundSeq: 1,
          sessionRef: null,
          reviewArtifact: null,
          specialists: [
            {
              assignmentId: "general",
              profile: { tier: "builtin", id: "general-reviewer", revision: 1 },
              resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
              pass: true,
              summary: "general: ok",
              issues: [],
              sessionRef: {
                backend: "claude",
                ref: "conversation-general",
                lane: "context_validator",
                assignmentId: "general",
                refKind: "conversation",
              },
            },
            {
              assignmentId: "security",
              profile: {
                tier: "project",
                id: "security-reviewer",
                revision: 4,
              },
              resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
              pass,
              summary: "security: ok",
              issues: [],
            },
          ],
        },
      };
    }

    function specialistDetail(contextId: string, occurredAt: string) {
      return {
        occurredAt,
        event: {
          type: "graph-workflow-validation-specialist-result",
          projectName: "evidence-ingest",
          sessionName,
          executionId: workflowExecutionId,
          contextId,
          roundSeq: 1,
          specialist: {
            assignmentId: "general",
            profile: { tier: "builtin", id: "general-reviewer", revision: 1 },
            resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
            pass: true,
            summary: "general: ok",
            issues: [],
          },
        },
      };
    }

    function incident(contextId: string, occurredAt: string) {
      return {
        occurredAt,
        event: {
          type: "graph-workflow-validation-incident",
          projectName: "evidence-ingest",
          sessionName,
          executionId: workflowExecutionId,
          contextId,
          incident: "infra_failure",
          roundSeq: 1,
          stage: "specialist_result",
          assignmentId: "perf",
          attempts: 1,
          driftedComponents: "",
          message: "perf retried",
        },
      };
    }

    it("records the aggregate and ignores the detail and incident kinds", async () => {
      appendEvents([
        specialistDetail("context-task-1", "2026-07-18T13:57:00.000Z"),
        incident("context-task-1", "2026-07-18T13:57:30.000Z"),
        cohortValidationResult("context-task-1", "2026-07-18T13:58:00.000Z"),
        laneCommit("context-task-1", "commit-abc", "2026-07-18T13:59:00.000Z"),
      ]);
      const service = createEvidenceIngestService(deps);

      const result = await service.ingestAuthoritatively(specExecutionId);

      // Four events scanned; the two new kinds contribute nothing.
      expect(result).toMatchObject({
        scannedEventCount: 4,
        ignoredEventCount: 2,
      });
      expect(
        readEvidence(db).map((row) => [row.kind, row.source_event_id]),
      ).toEqual([
        ["test_run", 3],
        ["validator_verdict", 3],
        ["validator_verdict", 3],
        ["commit", 4],
        ["commit", 4],
      ]);
    });

    it("attributes an unowned round to the execution, not to an arbitrary member", async () => {
      appendEvents([
        cohortValidationResult("context-task-1", "2026-07-18T13:58:00.000Z"),
        laneCommit("context-task-1", "commit-abc", "2026-07-18T13:59:00.000Z"),
      ]);
      const service = createEvidenceIngestService(deps);

      await service.ingestAuthoritatively(specExecutionId);

      // The existing null-safe fallback, unchanged: with no single reviewer at
      // the top level the producer is the workflow execution itself.
      const verdictRow = readEvidence(db).find(
        (row) => row.kind === "validator_verdict",
      );
      expect(JSON.parse(verdictRow?.producer_json ?? "{}")).toEqual({
        kind: "agent",
        conversationId: `workflow:${workflowExecutionId}`,
      });
    });

    it("still seals on the following lane commit and supersedes on the next round", async () => {
      appendEvents([
        cohortValidationResult(
          "context-task-1",
          "2026-07-18T13:58:00.000Z",
          false,
        ),
        // A second round for the same context supersedes the first.
        cohortValidationResult("context-task-1", "2026-07-18T13:58:30.000Z"),
        laneCommit("context-task-1", "commit-abc", "2026-07-18T13:59:00.000Z"),
      ]);
      const service = createEvidenceIngestService(deps);

      await service.ingestAuthoritatively(specExecutionId);

      // Unchanged sealing semantics: only the round the commit FOLLOWS may
      // claim that sha. The superseded round was remediated away, so its rows
      // exist but carry no commit stamp.
      const stamps = readEvidence(db)
        .filter((row) => row.kind === "validator_verdict")
        .map((row) => [
          row.source_event_id,
          (JSON.parse(row.evaluated_state_json) as { commitSha?: string })
            .commitSha ?? null,
        ]);
      expect(stamps).toEqual([
        [1, null],
        [1, null],
        [2, "commit-abc"],
        [2, "commit-abc"],
      ]);
    });
  });
});

function seedParents(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(projectPath);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name, created_at,
       last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectPath, sessionName, "/worktrees/evidence", "evidence", now, now);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    specId,
    projectPath,
    "evidence-ingest",
    "Evidence ingest",
    '{"preset":"contract-bearing"}',
    null,
    null,
    now,
    now,
  );
  for (const [index, criterionId] of [
    "criterion-1",
    "criterion-2",
    "criterion-3",
  ].entries()) {
    db.prepare(
      `INSERT INTO spec_elements (
         id, spec_id, kind, number, parent_element_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(criterionId, specId, "criterion", index + 1, null, now);
  }
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    specId,
    1,
    "approved",
    null,
    "revision-hash",
    now,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    specExecutionId,
    specId,
    revisionId,
    JSON.stringify({
      selectedTaskIds: ["task-1", "task-2"],
      selectedCriterionIds: ["criterion-1", "criterion-2", "criterion-3"],
      exclusionDispositions: [],
    }),
    "running",
    "workflow-definition-evidence",
    workflowExecutionId,
    sessionName,
    null,
    null,
    now,
    now,
  );
}

function readEvidence(db: Db) {
  return db
    .prepare(
      `SELECT criterion_element_id, kind, source_event_id, ref_json,
              evaluated_state_json, producer_json
         FROM spec_evidence
        ORDER BY source_event_id ASC, criterion_element_id ASC, kind ASC`,
    )
    .all() as Array<{
    criterion_element_id: string;
    kind: string;
    source_event_id: number;
    ref_json: string;
    evaluated_state_json: string;
    producer_json: string;
  }>;
}
