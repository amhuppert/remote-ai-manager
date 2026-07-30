import { makeTestCharter } from "./charter-fixture";

/**
 * A maximal {@link GraphWorkflowExecution}-shaped value with EVERY introspectable
 * persisted key path populated to a distinctive non-default value, so the
 * schema-driven durability harness can prove no field is dropped on write or
 * reset to its default on read. Returned as `unknown` (not parsed) so callers
 * choose whether to feed it through the schema; the durability harness parses
 * via its `schema` parameter.
 *
 * MUST NOT be imported by production code; it lives under
 * `src/lib/shared/testing/`.
 */
export function buildMaximalGraphWorkflowExecution(): unknown {
  return {
    id: "wf-maximal",
    seedDefinitionId: "seed-maximal",
    seedDefinitionRevision: 3,
    liveRevision: 4,
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
      {
        seq: 2,
        amendedAt: "2026-01-02T03:30:00.000Z",
        source: "plan-repair",
        rationale: "Repair round 1 corrected the false endpoint assumption",
        fieldsChanged: ["mission"],
        charterHash: "hash-after-amendment-2",
      },
    ],
    planRepairRounds: [
      {
        seq: 1,
        contextId: "ctx-1",
        haltType: "circuit_breaker",
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
    loopEpoch: 2,
    boundInputs: {
      feature: "search box",
      notes: "first line\nsecond line",
    },
    launchedTier: "global",
    definitionApproval: {
      requestedAt: "2026-01-01T00:00:00.000Z",
      approvedAt: "2026-01-01T00:00:05.000Z",
    },
    workingDefinition: {
      schemaVersion: 2,
      approvalRequired: true,
      origin: {
        sourceUri: "workflow-source:maximal/revision/3",
        label: "Maximal workflow source",
      },
      lockedRegions: [
        {
          paths: ["/tasks/task-1/instructions"],
          sourceUri: "workflow-source:maximal/revision/3",
          reason: "Task instructions come from the source workflow",
        },
      ],
      executionContexts: [
        {
          id: "ctx-1",
          title: "Implement the thing",
          description: "Detailed description of the context",
          acceptanceCriteria: "All tests pass and the build is green",
          origin: {
            sourceUri: "workflow-source:maximal/context/ctx-1",
            label: "Maximal context source",
          },
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
          planRepair: {
            enabled: false,
            maxAttemptsPerContext: 3,
            agent: {
              backend: "codex",
              model: "gpt-5.4",
              reasoningEffort: "high",
            },
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
        {
          id: "edge-1",
          sourceContextId: "ctx-1",
          targetContextId: "ctx-2",
        },
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
        // records (pendingApproval AND pendingUserInput, each with a
        // recorded-but-unapplied decision/answer) to prove every persisted key
        // path survives the round-trip. That superimposition is schema-valid
        // but not a reachable runtime state — a real context parks at exactly
        // one gate at a time. `status` is set to the user-input value so the
        // widened `awaiting_user_input` enum value is exercised on write.
        status: "awaiting_user_input",
        totalTaskCount: 4,
        completedTaskCount: 2,
        iterationCount: 3,
        consecutiveFailureCount: 1,
        worktreePath: "/wt/ctx-1",
        branchName: "csm/ctx-1",
        isolation: "worktree",
        batchId: "batch-1",
        reservedByBatchId: "batch-1",
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
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-02T07:00:00Z",
    haltReason: {
      type: "max_iterations",
      contextId: "ctx-1",
      iterationCount: 7,
      summary: "plan repair declined: failures are implementation-side",
    },
    pendingHaltReason: {
      type: "recovery_error",
      message: "could not recover lane state",
    },
    secondaryHaltReasons: [
      { type: "aborted" },
      // Maximal delivery-gate halt: carries the approval presentation fields
      // (refusalCode + spec deep-link block) so the optional extension is
      // proven durable through the repository round trip.
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
            // Non-converged so the schema's superRefine demands a populated
            // openConflicts; a non-null finalAnswer is still permitted, which
            // the durability guard requires (a nullable field left null reads
            // as "missing"). Both branches stay non-default.
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
}
