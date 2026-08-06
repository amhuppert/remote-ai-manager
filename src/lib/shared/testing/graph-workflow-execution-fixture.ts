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
      // Workflow-scope lane-merge selection snapshot — non-default on every
      // leaf so the round-trip harness proves both fields persist.
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
          origin: {
            sourceUri: "workflow-source:maximal/context/ctx-1",
            label: "Maximal context source",
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
          // Disabled with its assignments intact — the dormant-retention shape
          // R1.1 requires to survive persistence.
          contextValidator: {
            enabled: false,
            assignments: [
              {
                id: "security",
                profile: { tier: "project", id: "security-reviewer" },
                focus: "auth boundaries",
                strategy: "conversation",
                agent: {
                  backend: "claude",
                  model: "sonnet",
                  reasoningEffort: "medium",
                },
                continuity: { enabled: false, contextLimitTokens: 120_000 },
                // A dormant assignment carries its seeded snapshot too: it is
                // enabled by a config edit that does no resolution.
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
          // An author-declared output contract. `taskValidation` is a removed CC
          // config field name deliberately reused here as an ordinary property:
          // the legacy-schema cutover guard scans by field name, so this proves
          // the outputSchema subtree stays opaque to it across a real save and
          // reload rather than making a word collision unpersistable.
          //
          // It is also the contract `contextOutputs["ctx-1"].value` below is
          // required to satisfy — D5 admits only accepted candidates into
          // contextOutputs, so a fixture output that its own context's schema
          // would reject models a state the engine must never persist. The
          // executions-repo contract test enforces that with the canonical
          // validator, so this schema and that payload cannot drift apart.
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
              // The seed-time expansion frozen against the registry as it
              // stood at seed (design §6).
              commands: ["typecheck", "test"],
            },
            contextValidator: {
              value: { mode: "only", commands: ["test"] },
              source: "per-node",
              commands: ["test"],
            },
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
        // records (pendingApproval AND pendingUserInputs, each with a
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
        pendingUserInputs: {
          // Keyed by lane key: a cohort's validators park independently, so the
          // durability claim has to cover an assignment-scoped key, not just a
          // lane kind.
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
        // An open validation round, superimposed on the parked records for the
        // same maximal-coverage reason as those. The harness descends into the
        // FIRST specialist entry only, so that one co-populates a settled
        // verdict (summary + issues) AND a `questionToken` — schema-valid but
        // not a reachable runtime state, since a specialist either rendered a
        // verdict or is waiting on an answer, never both.
        validationRound: {
          seq: 4,
          candidate: {
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
            {
              assignmentId: "security-reviewer",
              profileRef: { tier: "project", id: "security-reviewer" },
              revision: 7,
              resolvedInstructionHash: `sha256:${"e".repeat(64)}`,
              strategy: "task",
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
              questionToken: "qb-general-1",
              sessionRef: {
                backend: "claude",
                ref: "conversation-general-validator",
                lane: "context_validator",
                assignmentId: "general",
                refKind: "conversation",
                workflowConversationId: "conversation-general-validator",
              },
              reviewArtifact: {
                backend: "claude",
                kind: "conversation",
                ref: "conversation-general-validator",
                usage: { costUsd: 0.42, apiTurns: 4 },
              },
              lastInfraFailure: {
                reason: "unparseable",
                message: "the reviewer returned prose, not a verdict",
                engine: "claude",
              },
            },
            "security-reviewer": {
              state: "parked",
              attempts: 1,
              summary: null,
              issues: [],
              questionToken: "qb-security-1",
              sessionRef: {
                backend: "codex",
                ref: "thread-security-validator",
                lane: "context_validator",
                assignmentId: "security-reviewer",
                refKind: "backend",
              },
              reviewArtifact: {
                backend: "codex",
                kind: "response",
                ref: "thread-security-validator",
                response: '{"verdict":"fail"}',
                usage: {
                  inputTokens: 1200,
                  cachedInputTokens: 400,
                  outputTokens: 300,
                  costUsd: 0.11,
                },
              },
              lastInfraFailure: null,
            },
          },
          phase: "concluded",
          outcome: "failed",
          startedAt: "2026-01-01T00:03:00.000Z",
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
    contextOutputs: {
      "ctx-1": {
        // An ACCEPTED output for ctx-1: every key and element type is admitted
        // by that context's authored outputSchema above (D5 keeps rejected
        // candidates out of contextOutputs entirely). Deliberately deep within
        // those bounds — nested objects, a nested array, and an explicit null —
        // because a shallow copy or a round-trip that coerced null to undefined
        // would still satisfy a flat key check.
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
        validationDebtSourceLaneIds: ["lane-2"],
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
      // Maximal abort: the additive cause/summary the assignment cutover stamps
      // on a run it ended, so both fields are proven durable.
      {
        type: "aborted",
        cause: "migration_cutover",
        summary: "ended by the agent assignments cutover",
      },
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
