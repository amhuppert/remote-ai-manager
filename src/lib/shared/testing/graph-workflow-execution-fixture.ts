import { makeTestCharter } from "./charter-fixture";

/**
 * The one fully-populated resolved execution context the harness descends
 * into. Shared by the scheduled graph and by the loop body template below, so
 * a field added to a resolved context is proven durable on both paths from a
 * single literal.
 */
function maximalResolvedContext(): Record<string, unknown> {
  return {
    id: "ctx-1",
    title: "Implement the thing",
    description: "Detailed description of the context",
    acceptanceCriteria: "All tests pass and the build is green",
    placement: { lane: "lane-loop", mode: "full" },
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
    // The source of the guarded edge below, so its cardinality policy is
    // the one D4 actually evaluates.
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
        commands: ["typecheck", "test"],
      },
      contextValidator: {
        value: { mode: "only", commands: ["test"] },
        source: "per-node",
        commands: ["test"],
      },
    },
    charter: makeTestCharter(),
  };
}

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
  const maximalContext = maximalResolvedContext();
  return {
    id: "wf-maximal",
    seedDefinitionId: "seed-maximal",
    seedDefinitionRevision: 3,
    liveRevision: 4,
    executionStateRevision: 17,
    // Distinct from every other counter here: a mapping that persisted the wrong
    // fence, or crossed two of them, has to show up as a value mismatch.
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
      // The LOOP repair round leads deliberately: the durability guard inspects
      // element [0], and `loopGroupId` is only non-null on a loop round (D4
      // R12) — its accounting keys on the group rather than on the pass
      // instance it names.
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
    // The audit log R12 requires a predicate amendment to be recorded in. The
    // rationale survives ONLY here — the amended predicate itself lives on the
    // working definition, which keeps no history.
    loopControlAmendments: [
      // The amendment leads: `rationale` is mandatory only on a predicate
      // amendment, and the durability guard inspects element [0].
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
          // The owning grade, so the round trip carries an ownedPaths list
          // rather than only the shape a bare full-access placement has.
          placement: {
            lane: "lane-1",
            mode: "owned",
            ownedPaths: ["src/lib/state-store", "docs/design/persistence.md"],
          },
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
                // Non-default authority: an authored blocking specialist has to
                // survive persistence as blocking, not decay to the advisory
                // default on reload.
                authority: "blocking",
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
          // A D4 activation guard over `ctx-1`'s declared output above: subset-
          // valid and statically compatible with it, so this fixture is a shape
          // accept-time validation admits, not merely one Zod parses.
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
      // template's contexts, tasks, and edges appear nowhere above. The
      // entry/exit ids stay the AUTHORED ones — the logical exit an external
      // edge addresses while the route projection resolves the pass instance
      // that satisfies it.
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
              { ...maximalContext, id: "ctx-loop-judge" },
              { ...maximalContext, id: "ctx-loop-worker" },
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
          // Non-default so a template edit that failed to bump the version, or
          // a repair policy dropped on write, is visible in the round-trip.
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
              advisories: [
                {
                  kind: "plan",
                  title: "The rollback step belongs in its own task",
                  description:
                    "Reverting the migration is work in its own right, not a footnote on this one.",
                  identity: {
                    roundSeq: 4,
                    assignmentId: "general",
                    ordinal: 1,
                  },
                  deliveredAt: "2026-03-01T00:00:00.000Z",
                  disposition: {
                    outcome: "declined",
                    reason: "The plan is already approved at this shape.",
                    recordedAt: "2026-03-01T00:05:00.000Z",
                  },
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
              // Undelivered and undisposed, so the round trip also covers the
              // state every advisory starts in.
              advisories: [
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
              ],
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
        // A D4 skip record superimposed on the same maximal entry (see above):
        // the complete incoming-edge verdict set, including the `active` and
        // `omitted` siblings, because the skip reason records the whole
        // conjunction rather than only the edges that vetoed the context.
        skipReason: {
          edgeEvaluations: [
            { edgeId: "edge-1", verdict: "inactive" },
            { edgeId: "edge-2", verdict: "active" },
            { edgeId: "edge-3", verdict: "omitted" },
          ],
          at: "2026-01-02T06:00:00.000Z",
        },
        // A D4 landing intent recorded at dispatch and settled by an adopted
        // self-authored commit, which is the mode that carries BOTH ends of the
        // SHA range — the field a shallow round-trip would most easily drop.
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
        // The advisory-response phase, under the same superimposition rule as
        // the records above: a context that owes a re-certification does not
        // simultaneously carry a failed round, but every persisted key path has
        // to survive the round-trip.
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
    // Both D4 expansion ledgers carrying content: the permanent acceptance
    // receipt with its added ids (the node-level provenance link) and one
    // retained refusal, so a round-trip that dropped either half is visible.
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
    // A loop mid-flight: pass 1 decided and counted, pass 2 reserved, with the
    // activation-time boundary snapshot pinned. Deliberately populated rather
    // than left at its dormant `{}`, so a round trip that dropped the ledger,
    // flattened the slot states, or lost the snapshot's nested payload fails
    // here rather than in a live loop.
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
              {
                name: "findings",
                type: "array",
                required: false,
                description: null,
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
        // Per-pass clone provenance (R11.2). Keys are pass numbers as STRINGS,
        // and the two passes deliberately cloned DIFFERENT versions: a
        // round trip that coerced the record to an array, or collapsed it to
        // the group's current version, loses exactly the fact that makes a
        // template amendment provably non-retroactive.
        passTemplateVersions: { "1": 1, "2": 2 },
        concludingExitContextId: "loop-refine__p2__ctx-1",
        activatedAt: "2026-01-02T05:00:00.000Z",
        settledAt: "2026-01-02T07:30:00.000Z",
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
    // Both indexed kinds, projected from the two advisories the round record
    // above carries: the index is what an advisory's audience reads without
    // opening a round, so a run that persisted the rounds but dropped the index
    // would lose exactly the long-lived half of the record.
    advisoryIndex: [
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
      // Maximal loop-budget halt (D4 R10): the execution-scope variant, whose
      // verdict/passCount/totalPassCount fields are what an operator reads back
      // after a restart, so all of them have to survive the round trip.
      {
        type: "loop_limit_reached",
        scope: "execution",
        loopGroupId: "refine",
        pass: 4,
        maxPasses: 6,
        verdict: "unsatisfied",
        passCount: 4,
        totalPassCount: 25,
        contextId: "refine__p4__ctx-2",
        message: "the execution spent its total pass backstop",
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
