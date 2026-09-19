import { describe, expect, it } from "vitest";

import {
  buildAuditReport,
  classifyHaltReason,
  parseAuditEvent,
  parseExecutionProjection,
  parseGitNumstat,
  parseJsonlLine,
  renderMarkdown,
  scanTranscriptText,
  type AuditEvent,
  type AuditExecution,
  type AuditInput,
  type JsonlRecord,
} from "./core";

const DAY = "2026-07-04";
const T = (clock: string): string => `${DAY}T${clock}.000Z`;
const ms = (clock: string): number => Date.parse(T(clock));

function rec(
  timestamp: string,
  event: string,
  fields: Record<string, unknown> = {},
): JsonlRecord {
  return { timestamp, event, fields };
}

function evt(occurredAt: string, payload: Record<string, unknown>): AuditEvent {
  const parsed = parseAuditEvent({ occurredAt, preReset: false, payload });
  if (parsed === null) throw new Error("fixture event failed to parse");
  return parsed;
}

function mustParseExecution(raw: unknown): AuditExecution {
  const result = parseExecutionProjection(raw);
  if (!result.ok) throw new Error(`fixture execution failed: ${result.error}`);
  return result.execution;
}

function baseExecutionRaw(): Record<string, unknown> {
  return {
    id: "exec-1",
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 2,
    launchedTier: "project",
    boundInputs: { feature: "ask-question" },
    status: "completed",
    startedAt: T("10:00:00"),
    completedAt: T("12:00:00"),
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    charter: { mission: "do the thing" },
    sharedDocuments: [
      {
        id: "doc-1",
        relativePath: "notes.md",
        description: "notes",
        kind: "shared",
      },
    ],
    workingDefinition: {
      executionContexts: [
        { id: "impl", title: "Implement" },
        { id: "validate", title: "Validate" },
      ],
    },
    contextStates: {
      impl: {
        contextId: "impl",
        status: "completed",
        totalTaskCount: 2,
        completedTaskCount: 2,
        iterationCount: 2,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        branchName: "csm/s.impl",
        laneId: "lane-impl",
        worktreePath: "/wt/s.impl",
        mergeStatus: "merged-success",
      },
      validate: {
        contextId: "validate",
        status: "completed",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 1,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        mergeStatus: "not-applicable",
      },
    },
    taskStates: {
      t1: {
        taskId: "t1",
        contextId: "impl",
        status: "completed",
        lastConversationId: "conv-impl",
      },
      t2: {
        taskId: "t2",
        contextId: "impl",
        status: "completed",
        lastConversationId: "conv-extra",
        failureHistory: [{ message: "tsc failed", timestamp: T("10:30:00") }],
      },
      t3: {
        taskId: "t3",
        contextId: "validate",
        status: "completed",
        lastConversationId: "conv-val",
      },
    },
    laneStates: {
      impl: {
        implementer: {
          lane: "implementer",
          engine: "claude",
          sessionRef: { conversationId: "conv-impl" },
          lastContextTokens: 750000,
          lastContextWindowMax: 1000000,
        },
      },
      validate: {
        context_validator: {
          lane: "context_validator",
          engine: "claude",
          sessionRef: { conversationId: "conv-val" },
        },
      },
    },
    joins: {
      "join-1": {
        joinId: "join-1",
        kind: "context_merge",
        status: "succeeded",
        sourceLaneIds: ["lane-impl"],
        conflicts: null,
      },
    },
  };
}

function baseInput(): AuditInput {
  const execution = mustParseExecution(baseExecutionRaw());
  const events: AuditEvent[] = [
    evt(T("10:40:00"), {
      type: "graph-workflow-validation-result",
      executionId: "exec-1",
      contextId: "impl",
      validatorType: "context",
      pass: false,
      summary: "night shift rounding is wrong",
      reopenTaskIds: ["t2"],
      issues: [
        { taskId: "t2", title: "rounding", description: "uses round" },
        { taskId: "t2", title: "test missing", description: "no unit test" },
      ],
    }),
    evt(T("11:10:00"), {
      type: "graph-workflow-validation-result",
      executionId: "exec-1",
      contextId: "impl",
      validatorType: "context",
      pass: true,
      summary: "all criteria satisfied",
      reopenTaskIds: [],
      issues: [],
    }),
    evt(T("10:35:30"), {
      type: "graph-workflow-user-input-pending",
      executionId: "exec-1",
      contextId: "impl",
      conversationId: "conv-impl",
      requestedAt: T("10:35:30"),
    }),
    evt(T("10:39:00"), {
      type: "graph-workflow-user-input-resolved",
      executionId: "exec-1",
      contextId: "impl",
      conversationId: "conv-impl",
      resolution: "answered",
      resolvedAt: T("10:39:00"),
    }),
    evt(T("11:10:30"), {
      type: "graph-workflow-approval-pending",
      executionId: "exec-1",
      contextId: "impl",
      contextTitle: "Implement",
      conversationId: "conv-impl",
      requestedAt: T("11:10:30"),
    }),
    evt(T("11:32:00"), {
      type: "graph-workflow-approval-resolved",
      executionId: "exec-1",
      contextId: "impl",
      conversationId: "conv-impl",
      decision: "approved",
      decidedAt: T("11:32:00"),
    }),
  ];
  return {
    source: "archived",
    execution,
    events,
    conversations: [
      {
        id: "conv-impl",
        role: null,
        totalCostUsd: 3.5,
        totalDurationMs: 3000000,
        totalTurns: 12,
        contextTokens: 750000,
        contextWindowMax: 1000000,
        transcriptPath: "/t/conv-impl.jsonl",
      },
      {
        id: "conv-val",
        role: null,
        totalCostUsd: 1.25,
        totalDurationMs: 600000,
        totalTurns: 3,
        contextTokens: 200000,
        contextWindowMax: 1000000,
        transcriptPath: "/t/conv-val.jsonl",
      },
      {
        id: "conv-extra",
        role: null,
        totalCostUsd: null,
        totalDurationMs: null,
        totalTurns: null,
        contextTokens: null,
        contextWindowMax: null,
        transcriptPath: null,
      },
      {
        id: "conv-history",
        role: null,
        totalCostUsd: 2,
        totalDurationMs: 900000,
        totalTurns: 5,
        contextTokens: 100000,
        contextWindowMax: 1000000,
        transcriptPath: "/t/conv-history.jsonl",
      },
    ],
    contextLogs: {
      impl: {
        iterations: [
          rec(T("10:00:05"), "iteration.started", {
            iterationNumber: 1,
            model: "opus",
            reasoningEffort: "xhigh",
          }),
          rec(T("10:00:05"), "iteration.conversation_resolved", {
            conversationId: "conv-impl",
          }),
          rec(T("10:00:06"), "iteration.prompt_sent", {
            promptLength: 10000,
            model: "opus",
          }),
          rec(T("10:35:00"), "iteration.agent_turn_completed", {
            turnNumber: 0,
            contextTokens: 400000,
            contextWindowMax: 1000000,
          }),
          rec(T("10:40:00"), "iteration.completed", {
            iterationNumber: 1,
            completedTaskCount: 1,
            remainingTaskCount: 1,
          }),
          rec(T("10:45:00"), "iteration.started", {
            iterationNumber: 2,
            model: "opus",
          }),
          rec(T("10:45:00"), "iteration.conversation_resolved", {
            conversationId: "conv-history",
          }),
          rec(T("10:45:01"), "iteration.prompt_sent", { promptLength: 25000 }),
          rec(T("11:05:00"), "iteration.agent_turn_completed", {
            turnNumber: 0,
            contextTokens: 750000,
            contextWindowMax: 1000000,
          }),
          rec(T("11:09:00"), "iteration.completed", {
            iterationNumber: 2,
            completedTaskCount: 2,
            remainingTaskCount: 0,
          }),
        ],
        tasks: [],
        validation: [],
        validatorResponses: [
          { file: "1.json", parsePath: "fenced_json_block" },
        ],
      },
      validate: {
        iterations: [
          rec(T("11:45:00"), "iteration.started", {
            iterationNumber: 1,
            model: "fable",
          }),
          rec(T("11:45:00"), "iteration.conversation_resolved", {
            conversationId: "conv-val",
          }),
          rec(T("11:45:01"), "iteration.prompt_sent", { promptLength: 9000 }),
          rec(T("11:55:00"), "iteration.agent_turn_completed", {
            turnNumber: 0,
            contextTokens: 200000,
            contextWindowMax: 1000000,
          }),
          rec(T("11:55:30"), "iteration.completed", {
            iterationNumber: 1,
            completedTaskCount: 1,
            remainingTaskCount: 0,
          }),
        ],
        tasks: [],
        validation: [],
        validatorResponses: [
          { file: "1.json", parsePath: "structured_output" },
        ],
      },
    },
    paths: { workflowLogsDir: "/logs/exec-1", transcriptsDir: "/t" },
  };
}

describe("parseJsonlLine", () => {
  it("parses a structured log line into timestamp/event/fields", () => {
    const line = JSON.stringify({
      timestamp: T("10:00:00"),
      event: "iteration.started",
      executionId: "exec-1",
      iterationNumber: 3,
    });
    const parsed = parseJsonlLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.timestamp).toBe(T("10:00:00"));
    expect(parsed?.event).toBe("iteration.started");
    expect(parsed?.fields.iterationNumber).toBe(3);
  });

  it("returns null for garbage and non-record lines", () => {
    expect(parseJsonlLine("not json")).toBeNull();
    expect(parseJsonlLine('"just a string"')).toBeNull();
    expect(parseJsonlLine(JSON.stringify({ event: "x" }))).toBeNull();
  });
});

describe("parseAuditEvent", () => {
  it("returns null when the payload has no type", () => {
    expect(
      parseAuditEvent({
        occurredAt: T("10:00:00"),
        preReset: false,
        payload: {},
      }),
    ).toBeNull();
    expect(
      parseAuditEvent({
        occurredAt: T("10:00:00"),
        preReset: false,
        payload: 7,
      }),
    ).toBeNull();
  });
});

describe("parseExecutionProjection", () => {
  it("fills defaults for a minimal legacy execution", () => {
    const result = parseExecutionProjection({
      id: "old-exec",
      startedAt: T("10:00:00"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.contextStates).toEqual({});
    expect(result.execution.secondaryHaltReasons).toEqual([]);
  });

  it("rejects a record without an id", () => {
    const result = parseExecutionProjection({ startedAt: T("10:00:00") });
    expect(result.ok).toBe(false);
  });
});

describe("classifyHaltReason", () => {
  it("classifies infrastructure, agent, user, and unknown halts", () => {
    expect(classifyHaltReason("recovery_error")).toBe("infrastructure");
    expect(classifyHaltReason("script_validator_missing_command")).toBe(
      "infrastructure",
    );
    expect(classifyHaltReason("merge_failure")).toBe("infrastructure");
    expect(classifyHaltReason("circuit_breaker")).toBe("agent");
    expect(classifyHaltReason("max_iterations")).toBe("agent");
    expect(classifyHaltReason("aborted")).toBe("user");
    expect(classifyHaltReason("something_new")).toBe("unknown");
  });
});

describe("buildAuditReport", () => {
  it("computes the overview", () => {
    const report = buildAuditReport(baseInput());
    expect(report.overview.executionId).toBe("exec-1");
    expect(report.overview.seedDefinitionRevision).toBe(2);
    expect(report.overview.status).toBe("completed");
    expect(report.overview.wallClockMs).toBe(ms("12:00:00") - ms("10:00:00"));
    expect(report.overview.contextsTotal).toBe(2);
    expect(report.overview.contextsCompleted).toBe(2);
    expect(report.overview.charterPresent).toBe(true);
    expect(report.overview.sharedDocumentCount).toBe(1);
    expect(report.overview.source).toBe("archived");
  });

  it("computes per-iteration stats from iterations.jsonl", () => {
    const report = buildAuditReport(baseInput());
    const impl = report.contexts.find((c) => c.contextId === "impl");
    expect(impl).toBeDefined();
    if (!impl) return;
    expect(impl.title).toBe("Implement");
    expect(impl.iterations).toHaveLength(2);
    const first = impl.iterations[0];
    expect(first?.iterationNumber).toBe(1);
    expect(first?.durationMs).toBe(ms("10:40:00") - ms("10:00:05"));
    expect(first?.agentTurns).toBe(1);
    expect(first?.seedPromptLength).toBe(10000);
    expect(first?.maxContextTokens).toBe(400000);
    expect(first?.conversationId).toBe("conv-impl");
    expect(first?.model).toBe("opus");
    expect(impl.peakContextTokens).toBe(750000);
    expect(impl.peakOccupancyPct).toBe(75);
  });

  it("orders contexts by first activity", () => {
    const report = buildAuditReport(baseInput());
    expect(report.contexts.map((c) => c.contextId)).toEqual([
      "impl",
      "validate",
    ]);
  });

  it("collects validation verdicts and flags NO-GO churn", () => {
    const report = buildAuditReport(baseInput());
    const impl = report.contexts.find((c) => c.contextId === "impl");
    expect(impl?.validations).toHaveLength(2);
    expect(impl?.validations[0]?.pass).toBe(false);
    expect(impl?.validations[0]?.issueCount).toBe(2);
    const churn = report.friction.filter((f) => f.kind === "validation_no_go");
    expect(churn).toHaveLength(1);
    expect(churn[0]?.contextId).toBe("impl");
    expect(churn[0]?.summary).toContain("night shift");
  });

  it("pairs approval and user-input waits into human wait durations", () => {
    const report = buildAuditReport(baseInput());
    const impl = report.contexts.find((c) => c.contextId === "impl");
    expect(impl?.approvalWaits).toHaveLength(1);
    expect(impl?.approvalWaits[0]?.waitMs).toBe(
      ms("11:32:00") - ms("11:10:30"),
    );
    expect(impl?.approvalWaits[0]?.decision).toBe("approved");
    expect(impl?.userInputWaits).toHaveLength(1);
    expect(impl?.userInputWaits[0]?.waitMs).toBe(
      ms("10:39:00") - ms("10:35:30"),
    );
    expect(report.time.humanWaitMsTotal).toBe(
      ms("11:32:00") - ms("11:10:30") + (ms("10:39:00") - ms("10:35:30")),
    );
  });

  it("classifies long gaps and flags only uncovered ones as stalls", () => {
    const report = buildAuditReport(baseInput());
    const agentGap = report.time.gaps.find(
      (g) => g.startedAt === T("10:00:06"),
    );
    expect(agentGap?.classification).toBe("agent_work");
    const humanGap = report.time.gaps.find(
      (g) => g.startedAt === T("11:10:30"),
    );
    expect(humanGap?.classification).toBe("human_wait");
    const stallGap = report.time.gaps.find(
      (g) => g.startedAt === T("11:32:00"),
    );
    expect(stallGap?.classification).toBe("unexplained");
    const stalls = report.friction.filter((f) => f.kind === "stall_gap");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.summary).toContain("11:32");
  });

  it("flags context window pressure at >= 70% occupancy", () => {
    const report = buildAuditReport(baseInput());
    const pressure = report.friction.filter(
      (f) => f.kind === "context_window_pressure",
    );
    expect(pressure).toHaveLength(1);
    expect(pressure[0]?.contextId).toBe("impl");
    expect(pressure[0]?.severity).toBe("high");
  });

  it("flags seed prompt growth across iterations", () => {
    const report = buildAuditReport(baseInput());
    const growth = report.friction.filter((f) => f.kind === "prompt_growth");
    expect(growth).toHaveLength(1);
    expect(growth[0]?.contextId).toBe("impl");
  });

  it("surfaces task failure history and validator parse fallbacks", () => {
    const report = buildAuditReport(baseInput());
    expect(
      report.friction.some(
        (f) => f.kind === "task_failure" && f.summary.includes("tsc failed"),
      ),
    ).toBe(true);
    const fallback = report.friction.filter((f) => f.kind === "parse_fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.contextId).toBe("impl");
  });

  it("rolls up cost by lane and by context, counting missing costs", () => {
    const report = buildAuditReport(baseInput());
    expect(report.cost.totalUsd).toBeCloseTo(6.75);
    // conv-history is absent from the saved laneStates and must be attributed
    // through iteration.conversation_resolved log records.
    expect(report.cost.byLane.implementer).toBeCloseTo(5.5);
    expect(report.cost.byLane.context_validator).toBeCloseTo(1.25);
    expect(report.cost.byContext.impl).toBeCloseTo(5.5);
    expect(report.cost.byContext.validate).toBeCloseTo(1.25);
    expect(report.cost.missingCostCount).toBe(1);
  });

  it("attributes validator conversations from validation-event sessionRefs", () => {
    const input = baseInput();
    input.events.push(
      evt(T("11:58:00"), {
        type: "graph-workflow-validation-result",
        executionId: "exec-1",
        contextId: "validate",
        validatorType: "context",
        pass: true,
        summary: "ok",
        reopenTaskIds: [],
        issues: [],
        sessionRef: {
          engine: "claude",
          lane: "context_validator",
          conversationId: "conv-extra",
        },
      }),
    );
    const report = buildAuditReport(input);
    const extra = report.pointers.transcripts.find(
      (t) => t.conversationId === "conv-extra",
    );
    expect(extra?.lane).toBe("context_validator");
  });

  it("does not describe a recovered execution as having no halts", () => {
    const input = baseInput();
    input.lifecycle = [
      rec(T("10:30:00"), "execution.halted", {
        haltReason: { type: "loop_limit_reached", contextId: "impl" },
      }),
      rec(T("10:40:00"), "execution.resumed", {}),
    ];
    const report = buildAuditReport(input);
    expect(
      report.positives.some((finding) => finding.kind === "completed_clean"),
    ).toBe(false);
    expect(
      report.friction.some((finding) => finding.kind === "recovered_halt"),
    ).toBe(true);
  });

  it("records positives: clean completion, first-try GO, clean merges", () => {
    const report = buildAuditReport(baseInput());
    const kinds = report.positives.map((p) => p.kind);
    expect(kinds).toContain("completed_clean");
    expect(kinds).toContain("clean_merges");
    const firstTry = report.positives.find((p) => p.kind === "first_try_go");
    expect(firstTry?.summary).toContain("validate");
    expect(firstTry?.summary).not.toContain("impl");
  });

  it("reports auto-resolved conflicts instead of clean merges when a succeeded join carries them", () => {
    // Audit 1beec403: join 2's schemas.ts conflict was resolved by a
    // smart-merge sub-turn, yet the report claimed "all joins merged without
    // conflicts". A succeeded join with resolvedConflicts is NOT clean.
    const raw = baseExecutionRaw();
    (raw.joins as Record<string, unknown>)["join-1"] = {
      joinId: "join-1",
      kind: "context_merge",
      status: "succeeded",
      sourceLaneIds: ["lane-impl"],
      conflicts: null,
      resolvedConflicts: [
        {
          sourceLaneId: "lane-impl",
          files: ["src/lib/naming/schemas.ts"],
          resolution: "sub_turn",
        },
      ],
    };
    const input = { ...baseInput(), execution: mustParseExecution(raw) };

    const report = buildAuditReport(input);
    const kinds = report.positives.map((p) => p.kind);
    expect(kinds).not.toContain("clean_merges");
    const autoResolved = report.positives.find(
      (p) => p.kind === "conflicts_auto_resolved",
    );
    expect(autoResolved?.summary).toContain("join-1");
    expect(autoResolved?.summary).toContain("src/lib/naming/schemas.ts");
    expect(autoResolved?.summary).toContain("sub_turn");
  });

  it("emits a high-severity infrastructure halt finding for halted runs", () => {
    const raw = {
      ...baseExecutionRaw(),
      status: "halted",
      completedAt: null,
      haltReason: {
        type: "script_validator_missing_command",
        contextId: "impl",
        message: "no preMergeCommand configured",
      },
    };
    const input: AuditInput = {
      ...baseInput(),
      execution: mustParseExecution(raw),
    };
    const report = buildAuditReport(input);
    const halts = report.friction.filter((f) => f.kind === "halt");
    expect(halts).toHaveLength(1);
    expect(halts[0]?.severity).toBe("high");
    expect(halts[0]?.summary).toContain("script_validator_missing_command");
    expect(halts[0]?.summary).toContain("infrastructure");
    expect(report.positives.map((p) => p.kind)).not.toContain(
      "completed_clean",
    );
  });

  it("survives an execution with no on-disk logs", () => {
    const input: AuditInput = { ...baseInput(), contextLogs: {} };
    const report = buildAuditReport(input);
    const impl = report.contexts.find((c) => c.contextId === "impl");
    expect(impl?.iterations).toEqual([]);
    expect(impl?.validations).toHaveLength(2);
  });

  it("links transcript pointers for every known conversation", () => {
    const report = buildAuditReport(baseInput());
    const ids = report.pointers.transcripts.map((t) => t.conversationId);
    expect(ids).toContain("conv-impl");
    expect(ids).toContain("conv-val");
  });
});

describe("validator cost rollup", () => {
  it("is null when no validation-result event carries a usage artifact", () => {
    expect(buildAuditReport(baseInput()).cost.validators).toBeNull();
  });

  it("rolls up codex validator tokens and estimated cost, counting unpriced legacy events", () => {
    const input = baseInput();
    input.events.push(
      evt(T("11:20:00"), {
        type: "graph-workflow-validation-result",
        executionId: "exec-1",
        contextId: "impl",
        validatorType: "context",
        pass: true,
        summary: "GO",
        reopenTaskIds: [],
        issues: [],
        reviewArtifact: {
          engine: "codex",
          threadId: "th-1",
          response: "{}",
          usage: {
            inputTokens: 200_000,
            cachedInputTokens: 150_000,
            outputTokens: 5_000,
            costUsd: 0.4,
          },
        },
      }),
      evt(T("11:25:00"), {
        type: "graph-workflow-validation-result",
        executionId: "exec-1",
        contextId: "impl",
        validatorType: "context",
        pass: true,
        summary: "GO (legacy event, no recorded cost)",
        reopenTaskIds: [],
        issues: [],
        reviewArtifact: {
          engine: "codex",
          threadId: "th-1",
          response: "{}",
          usage: {
            inputTokens: 100_000,
            cachedInputTokens: 0,
            outputTokens: 1_000,
          },
        },
      }),
    );

    const report = buildAuditReport(input);
    expect(report.cost.validators).toEqual({
      estimatedUsd: 0.4,
      inputTokens: 300_000,
      cachedInputTokens: 150_000,
      outputTokens: 6_000,
      usageEventCount: 2,
      unpricedEventCount: 1,
    });

    const md = renderMarkdown(report);
    expect(md).toContain("context validators");
    expect(md).toContain("$0.40");
  });

  it("rolls up modern backend-shaped response artifacts", () => {
    const input = baseInput();
    input.events.push(
      evt(T("11:20:00"), {
        type: "graph-workflow-validation-result",
        executionId: "exec-1",
        contextId: "impl",
        validatorType: "context",
        pass: true,
        summary: "GO",
        reopenTaskIds: [],
        issues: [],
        reviewArtifact: {
          backend: "codex",
          kind: "response",
          ref: "th-1",
          response: "{}",
          usage: {
            inputTokens: 50_000,
            cachedInputTokens: 10_000,
            outputTokens: 2_000,
            costUsd: 0.2,
          },
        },
      }),
    );
    const report = buildAuditReport(input);
    expect(report.cost.validators?.estimatedUsd).toBeCloseTo(0.2);
    expect(report.cost.validators?.inputTokens).toBe(50_000);
    expect(report.cost.validators?.usageEventCount).toBe(1);
  });

  it("accrues latest cumulative per codex validator thread instead of summing snapshots", () => {
    // A resumed codex validator thread reports thread-CUMULATIVE usage on
    // every decision (audit 1beec403); summing the snapshots inflates the
    // validator estimate exactly like the conversation-row bug.
    const input = baseInput();
    input.events.push(
      evt(T("11:20:00"), {
        type: "graph-workflow-validation-result",
        executionId: "exec-1",
        contextId: "impl",
        validatorType: "context",
        pass: false,
        summary: "NO-GO",
        reopenTaskIds: [],
        issues: [],
        reviewArtifact: {
          backend: "codex",
          kind: "response",
          ref: "th-resumed",
          response: "{}",
          usage: {
            inputTokens: 4_030_000,
            cachedInputTokens: 3_000_000,
            outputTokens: 40_000,
            costUsd: 3.186902,
          },
        },
      }),
      evt(T("11:40:00"), {
        type: "graph-workflow-validation-result",
        executionId: "exec-1",
        contextId: "impl",
        validatorType: "context",
        pass: true,
        summary: "GO",
        reopenTaskIds: [],
        issues: [],
        reviewArtifact: {
          backend: "codex",
          kind: "response",
          ref: "th-resumed",
          response: "{}",
          usage: {
            inputTokens: 5_470_000,
            cachedInputTokens: 4_100_000,
            outputTokens: 55_000,
            costUsd: 4.072798,
          },
        },
      }),
    );

    const report = buildAuditReport(input);
    expect(report.cost.validators?.estimatedUsd).toBeCloseTo(4.072798, 6);
    expect(report.cost.validators?.inputTokens).toBe(5_470_000);
    expect(report.cost.validators?.cachedInputTokens).toBe(4_100_000);
    expect(report.cost.validators?.outputTokens).toBe(55_000);
    expect(report.cost.validators?.usageEventCount).toBe(2);
    expect(report.cost.validators?.unpricedEventCount).toBe(0);
  });

  it("counts conversation-artifact usage only when the conversation row is unpriced", () => {
    const input = baseInput();
    input.events.push(
      // conv-val already carries a priced conversation row ($1.25) — counting
      // its artifact usage again would double-count the same spend.
      evt(T("11:57:00"), {
        type: "graph-workflow-validation-result",
        executionId: "exec-1",
        contextId: "validate",
        validatorType: "context",
        pass: true,
        summary: "GO",
        reopenTaskIds: [],
        issues: [],
        reviewArtifact: {
          backend: "claude",
          kind: "conversation",
          ref: "conv-val",
          usage: { costUsd: 1.25, apiTurns: 3 },
        },
      }),
      // conv-extra has a null-cost conversation row: the artifact usage is
      // the only record of this validator decision's spend.
      evt(T("11:58:00"), {
        type: "graph-workflow-validation-result",
        executionId: "exec-1",
        contextId: "validate",
        validatorType: "context",
        pass: true,
        summary: "GO",
        reopenTaskIds: [],
        issues: [],
        reviewArtifact: {
          backend: "claude",
          kind: "conversation",
          ref: "conv-extra",
          usage: { costUsd: 2.5, apiTurns: 4 },
        },
      }),
    );
    const report = buildAuditReport(input);
    expect(report.cost.validators?.estimatedUsd).toBeCloseTo(2.5);
    expect(report.cost.validators?.usageEventCount).toBe(1);
  });
});

function transcriptLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function assistantToolUse(
  blocks: Array<{ name: string; input?: Record<string, unknown> }>,
): string {
  return transcriptLine({
    type: "assistant",
    role: "assistant",
    content: blocks.map((b, i) => ({
      type: "tool_use",
      id: `tu-${i}`,
      name: b.name,
      input: b.input ?? {},
    })),
  });
}

describe("scanTranscriptText", () => {
  it("counts Codex isError results and conservative Bash file rereads", () => {
    const scan = scanTranscriptText(
      [
        assistantToolUse([
          { name: "Bash", input: { command: "cat src/review.md" } },
          { name: "Bash", input: { command: "sed -n '1,80p' src/review.md" } },
          { name: "Bash", input: { command: "printf 'cat src/fake.md'" } },
          {
            name: "Bash",
            input: { command: "cat > src/output.md <<'EOF'\ntext\nEOF" },
          },
        ]),
        transcriptLine({
          type: "tool_result",
          role: "user",
          content: [{ type: "tool_result", isError: true, content: "failed" }],
        }),
        transcriptLine({
          type: "tool_result",
          role: "user",
          content: [{ type: "tool_result", isError: false, content: "ok" }],
        }),
      ].join("\n"),
    );
    expect(scan.toolErrorCount).toBe(1);
    expect(scan.reads).toEqual({
      uniqueFiles: 1,
      totalReads: 2,
      repeatReads: 1,
    });
    expect(scan.topReReads).toEqual([{ path: "src/review.md", count: 2 }]);
  });

  it("sums the final cumulative cost per session lineage, never every result", () => {
    // Mirrors the real double-count case: lineage A 42.37→64.85, lineage B
    // 43.73→50.79. True cost = 64.85 + 50.79, NOT the sum of all four.
    const text = [
      transcriptLine({
        type: "result",
        raw: { total_cost_usd: 42.37, num_turns: 112, session_id: "A" },
      }),
      transcriptLine({
        type: "result",
        raw: { total_cost_usd: 64.85, num_turns: 19, session_id: "A" },
      }),
      transcriptLine({
        type: "result",
        raw: { total_cost_usd: 43.73, num_turns: 116, session_id: "B" },
      }),
      transcriptLine({
        type: "result",
        raw: { total_cost_usd: 50.79, num_turns: 13, session_id: "B" },
      }),
    ].join("\n");
    const scan = scanTranscriptText(text);
    expect(scan.costUsd).toBeCloseTo(115.64);
    expect(scan.lineageCount).toBe(2);
    expect(scan.apiTurns).toBe(112 + 19 + 116 + 13);
  });

  it("treats a same-session-id cumulative drop as a lineage restart", () => {
    // Observed live: a restarted subprocess resumes the SAME session id with
    // its cumulative reset. The drop marks the lineage boundary.
    const text = [
      transcriptLine({
        type: "result",
        raw: { total_cost_usd: 64.85, num_turns: 19, session_id: "A" },
      }),
      transcriptLine({
        type: "result",
        raw: { total_cost_usd: 43.73, num_turns: 116, session_id: "A" },
      }),
      transcriptLine({
        type: "result",
        raw: { total_cost_usd: 50.79, num_turns: 13, session_id: "A" },
      }),
    ].join("\n");
    const scan = scanTranscriptText(text);
    expect(scan.costUsd).toBeCloseTo(115.64);
    expect(scan.lineageCount).toBe(2);
  });

  it("takes the final cumulative per codex thread, never the sum of snapshots", () => {
    // Audit 1beec403: regenerate-api's DB row $7.2597 was exactly the sum of
    // its two thread-cumulative snapshots. True thread cost is the final one.
    const text = [
      transcriptLine({
        type: "result",
        raw: {
          backend: "codex",
          backendRef: { backend: "codex", ref: "thread-1" },
          costUsd: 3.186902,
          numTurns: 1,
          contextTokens: 4_030_000,
        },
      }),
      transcriptLine({
        type: "result",
        raw: {
          backend: "codex",
          backendRef: { backend: "codex", ref: "thread-1" },
          costUsd: 4.072798,
          numTurns: 1,
          contextTokens: 5_470_000,
        },
      }),
    ].join("\n");
    const scan = scanTranscriptText(text);
    expect(scan.costUsd).toBeCloseTo(4.072798, 6);
    expect(scan.lineageCount).toBe(1);
    expect(scan.apiTurns).toBe(2);
  });

  it("sums final cumulatives across distinct codex threads", () => {
    const text = [
      transcriptLine({
        type: "result",
        raw: {
          backend: "codex",
          backendRef: { backend: "codex", ref: "thread-1" },
          costUsd: 2.5,
          numTurns: 1,
        },
      }),
      transcriptLine({
        type: "result",
        raw: {
          backend: "codex",
          backendRef: { backend: "codex", ref: "thread-2" },
          costUsd: 1.25,
          numTurns: 1,
        },
      }),
    ].join("\n");
    const scan = scanTranscriptText(text);
    expect(scan.costUsd).toBeCloseTo(3.75, 6);
    expect(scan.lineageCount).toBe(2);
  });

  it("tallies tool calls, tool errors, kills, fallbacks, compactions, and re-reads", () => {
    const text = [
      assistantToolUse([
        { name: "Read", input: { file_path: "/src/machine.ts" } },
        { name: "Bash", input: { command: "ls" } },
      ]),
      assistantToolUse([
        { name: "Read", input: { file_path: "/src/machine.ts" } },
        { name: "Read", input: { file_path: "/src/other.ts" } },
      ]),
      transcriptLine({
        type: "tool_result",
        raw: {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", content: "Exit code 1", is_error: true },
            ],
          },
        },
      }),
      transcriptLine({
        type: "system",
        raw: { subtype: "task_updated", patch: { status: "killed" } },
      }),
      transcriptLine({
        type: "system",
        raw: { subtype: "task_updated", patch: { status: "completed" } },
      }),
      transcriptLine({
        type: "system",
        raw: { subtype: "model_refusal_fallback", trigger: "refusal" },
      }),
      transcriptLine({
        type: "system",
        raw: { subtype: "compact_boundary" },
      }),
      "not json at all",
    ].join("\n");
    const scan = scanTranscriptText(text);
    expect(scan.toolUseCount).toBe(4);
    expect(scan.toolCounts).toEqual([
      { name: "Read", count: 3 },
      { name: "Bash", count: 1 },
    ]);
    expect(scan.toolErrorCount).toBe(1);
    expect(scan.backgroundTasksKilled).toBe(1);
    expect(scan.modelFallbacks).toBe(1);
    expect(scan.compactions).toBe(1);
    expect(scan.reads).toEqual({
      uniqueFiles: 2,
      totalReads: 3,
      repeatReads: 1,
    });
    expect(scan.topReReads).toEqual([{ path: "/src/machine.ts", count: 2 }]);
  });

  it("returns nulls and zeros for an empty transcript", () => {
    const scan = scanTranscriptText("");
    expect(scan.costUsd).toBeNull();
    expect(scan.apiTurns).toBeNull();
    expect(scan.lineageCount).toBe(0);
    expect(scan.toolUseCount).toBe(0);
    expect(scan.backgroundTasksKilled).toBe(0);
  });
});

describe("transcript-derived findings", () => {
  function withScan(
    input: AuditInput,
    conversationId: string,
    scan: Partial<ReturnType<typeof scanTranscriptText>>,
  ): AuditInput {
    const base = scanTranscriptText("");
    return {
      ...input,
      conversations: input.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, transcriptScan: { ...base, ...scan } }
          : c,
      ),
    };
  }

  it("flags a recorded-vs-transcript cost mismatch and reports the corrected total", () => {
    const input = withScan(baseInput(), "conv-impl", { costUsd: 2.0 });
    const report = buildAuditReport(input);
    // conv-impl corrected 3.5 → 2.0; conv-val 1.25 + conv-history 2 unchanged.
    expect(report.cost.correctedTotalUsd).toBeCloseTo(5.25);
    const mismatch = report.friction.filter((f) => f.kind === "cost_mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.summary).toContain("conv-impl");
    expect(mismatch[0]?.summary).toContain("$3.50");
    expect(mismatch[0]?.summary).toContain("$2.00");
  });

  it("does not flag when recorded cost matches the transcript", () => {
    const input = withScan(baseInput(), "conv-impl", { costUsd: 3.5 });
    const report = buildAuditReport(input);
    expect(report.friction.some((f) => f.kind === "cost_mismatch")).toBe(false);
    expect(report.cost.correctedTotalUsd).toBeCloseTo(6.75);
  });

  it("leaves the corrected total null when no transcript scans exist", () => {
    const report = buildAuditReport(baseInput());
    expect(report.cost.correctedTotalUsd).toBeNull();
  });

  it("flags background task kills at or above the threshold, attributed to the context", () => {
    const input = withScan(baseInput(), "conv-impl", {
      backgroundTasksKilled: 3,
    });
    const report = buildAuditReport(input);
    const kills = report.friction.filter(
      (f) => f.kind === "background_task_kills",
    );
    expect(kills).toHaveLength(1);
    expect(kills[0]?.contextId).toBe("impl");
    expect(kills[0]?.summary).toContain("3");
  });

  it("stays silent on kills below the threshold", () => {
    const input = withScan(baseInput(), "conv-impl", {
      backgroundTasksKilled: 2,
    });
    const report = buildAuditReport(input);
    expect(
      report.friction.some((f) => f.kind === "background_task_kills"),
    ).toBe(false);
  });

  it("flags compaction events", () => {
    const input = withScan(baseInput(), "conv-val", { compactions: 2 });
    const report = buildAuditReport(input);
    const compaction = report.friction.filter(
      (f) => f.kind === "compaction_events",
    );
    expect(compaction).toHaveLength(1);
    expect(compaction[0]?.contextId).toBe("validate");
  });
});

describe("final publish composition", () => {
  it("parses git numstat output, tolerating binary markers", () => {
    const out =
      "10\t2\tsrc/a.ts\n-\t-\tassets/img.png\n100\t0\t.cc/private-dev/poll.log\n";
    expect(parseGitNumstat(out)).toEqual([
      { path: "src/a.ts", additions: 10, deletions: 2 },
      { path: "assets/img.png", additions: 0, deletions: 0 },
      { path: ".cc/private-dev/poll.log", additions: 100, deletions: 0 },
    ]);
  });

  it("classifies scratch files and flags scratch debris", () => {
    const input: AuditInput = {
      ...baseInput(),
      finalPublish: {
        commitSha: "abc1234def5678",
        files: [
          { path: "src/a.ts", additions: 10, deletions: 2 },
          { path: ".cc/private-dev/poll.log", additions: 100, deletions: 0 },
          {
            path: ".cc/graph-workflow-docs/charter.md",
            additions: 5,
            deletions: 0,
          },
          { path: "docs/notes.md", additions: 3, deletions: 1 },
          { path: "server.log", additions: 40, deletions: 0 },
        ],
      },
    };
    const report = buildAuditReport(input);
    expect(report.publish).not.toBeNull();
    expect(report.publish?.fileCount).toBe(5);
    expect(report.publish?.totalAdditions).toBe(158);
    expect(report.publish?.scratchFiles.map((f) => f.path)).toEqual([
      ".cc/private-dev/poll.log",
      "server.log",
    ]);
    const debris = report.friction.filter((f) => f.kind === "scratch_debris");
    expect(debris).toHaveLength(1);
    expect(debris[0]?.summary).toContain(".cc/private-dev/poll.log");
    expect(debris[0]?.summary).toContain("abc1234d");
    const md = renderMarkdown(report);
    expect(md).toContain("Final publish");
  });

  it("reports null publish and no debris finding when unavailable", () => {
    const report = buildAuditReport(baseInput());
    expect(report.publish).toBeNull();
    expect(report.friction.some((f) => f.kind === "scratch_debris")).toBe(
      false,
    );
  });
});

describe("shared documents positive", () => {
  it("does not count the charter as a shared document", () => {
    const raw = {
      ...baseExecutionRaw(),
      sharedDocuments: [
        {
          id: "doc-charter-xyz",
          kind: "charter",
          relativePath: ".cc/graph-workflow-docs/charter.md",
        },
      ],
    };
    const input: AuditInput = {
      ...baseInput(),
      execution: mustParseExecution(raw),
    };
    const report = buildAuditReport(input);
    expect(
      report.positives.some((p) => p.kind === "shared_documents_used"),
    ).toBe(false);
    expect(report.overview.sharedDocumentCount).toBe(0);
  });

  it("counts agent-registered documents beyond the charter", () => {
    const report = buildAuditReport(baseInput());
    const positive = report.positives.find(
      (p) => p.kind === "shared_documents_used",
    );
    expect(positive?.summary).toContain("beyond the charter");
    expect(report.overview.sharedDocumentCount).toBe(1);
  });
});

describe("turn-unit labels", () => {
  it("labels iteration turns as prompt cycles and conversation turns as sdk turns", () => {
    const md = renderMarkdown(buildAuditReport(baseInput()));
    expect(md).toContain("| prompt cycles |");
    expect(md).toContain("12 sdk turns");
  });
});

describe("renderMarkdown", () => {
  it("renders overview, friction, positives, cost, and context sections", () => {
    const md = renderMarkdown(buildAuditReport(baseInput()));
    expect(md).toContain("# Graph workflow audit — exec-1");
    expect(md).toContain("## Friction");
    expect(md).toContain("## What worked");
    expect(md).toContain("$6.75");
    expect(md).toContain("Implement");
    expect(md).toContain("## Where to dig deeper");
  });

  it("bounds long issue lists", () => {
    const input = baseInput();
    const manyIssues = Array.from({ length: 30 }, (_, i) => ({
      taskId: "t2",
      title: `issue ${i}`,
      description: "x",
    }));
    input.events.push(
      evt(T("11:11:00"), {
        type: "graph-workflow-validation-result",
        executionId: "exec-1",
        contextId: "impl",
        validatorType: "context",
        pass: false,
        summary: "many problems",
        reopenTaskIds: ["t2"],
        issues: manyIssues,
      }),
    );
    const md = renderMarkdown(buildAuditReport(input));
    const rendered = md
      .split("\n")
      .filter((line) => line.includes("issue ")).length;
    expect(rendered).toBeLessThanOrEqual(5);
    expect(md).toContain("more");
  });
});

describe("halt recovery and operator wait", () => {
  it("pairs execution.halted with execution.resumed into operator recovery waits", () => {
    const input = baseInput();
    input.lifecycle = [
      rec(T("11:32:00"), "execution.halted", {
        haltReason: {
          type: "join_failure",
          contextId: "impl",
          message: "pre-merge validation failed",
        },
      }),
      rec(T("11:45:00"), "execution.resumed", { previousStatus: "halted" }),
    ];
    const report = buildAuditReport(input);
    expect(report.time.operatorRecoveryWaitMsTotal).toBe(
      ms("11:45:00") - ms("11:32:00"),
    );
    expect(report.time.haltRecoveries).toHaveLength(1);
    const recovery = report.time.haltRecoveries[0];
    expect(recovery?.haltType).toBe("join_failure");
    expect(recovery?.contextId).toBe("impl");
    expect(recovery?.resumedAt).toBe(T("11:45:00"));
    const recovered = report.friction.filter(
      (f) => f.kind === "recovered_halt",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.summary).toContain("join_failure");
  });

  it("classifies gaps inside a halt window as halt_wait, not stall", () => {
    const input = baseInput();
    input.lifecycle = [
      rec(T("11:32:00"), "execution.halted", {
        haltReason: { type: "join_failure", contextId: "impl" },
      }),
      rec(T("11:45:00"), "execution.resumed", {}),
    ];
    const report = buildAuditReport(input);
    const gap = report.time.gaps.find((g) => g.startedAt === T("11:32:00"));
    expect(gap?.classification).toBe("halt_wait");
    expect(report.friction.some((f) => f.kind === "stall_gap")).toBe(false);
  });

  it("classifies gaps inside a join window as join_compute, not stall", () => {
    // Audit 1beec403: 52 minutes (22% of wall clock) sat inside joins with
    // zero telemetry and surfaced as "unexplained" stall gaps. The lifecycle
    // log already brackets every join with join.started/join.completed.
    const input = baseInput();
    input.lifecycle = [
      rec(T("11:32:00"), "join.started", {
        joinId: "join-1",
        kind: "context_merge",
      }),
      rec(T("11:52:00"), "join.completed", { joinId: "join-1" }),
    ];
    const report = buildAuditReport(input);
    const gap = report.time.gaps.find((g) => g.startedAt === T("11:32:00"));
    expect(gap?.classification).toBe("join_compute");
    expect(report.friction.some((f) => f.kind === "stall_gap")).toBe(false);
  });

  it("bounds an unmatched join window at the failure record", () => {
    const input = baseInput();
    input.lifecycle = [
      rec(T("11:32:00"), "join.started", {
        joinId: "join-1",
        kind: "context_merge",
      }),
      rec(T("11:52:00"), "join.failed", { joinId: "join-1" }),
    ];
    const report = buildAuditReport(input);
    const gap = report.time.gaps.find((g) => g.startedAt === T("11:32:00"));
    expect(gap?.classification).toBe("join_compute");
  });

  it("reports an unresolved trailing halt with a null wait", () => {
    const input = baseInput();
    input.lifecycle = [
      rec(T("11:50:00"), "execution.halted", {
        haltReason: { type: "circuit_breaker", contextId: "validate" },
      }),
    ];
    const report = buildAuditReport(input);
    expect(report.time.haltRecoveries).toHaveLength(1);
    expect(report.time.haltRecoveries[0]?.resumedAt).toBeNull();
    expect(report.time.haltRecoveries[0]?.waitMs).toBeNull();
    expect(report.time.operatorRecoveryWaitMsTotal).toBe(0);
    // Unresolved halts are already reported via the execution's halt state —
    // no recovered_halt finding for a halt that never resumed.
    expect(report.friction.some((f) => f.kind === "recovered_halt")).toBe(
      false,
    );
  });

  it("withholds clean_merges when a merge-class halt was recovered", () => {
    const input = baseInput();
    input.lifecycle = [
      rec(T("11:32:00"), "execution.halted", {
        haltReason: { type: "join_failure", contextId: "impl" },
      }),
      rec(T("11:45:00"), "execution.resumed", {}),
    ];
    const report = buildAuditReport(input);
    expect(report.positives.map((p) => p.kind)).not.toContain("clean_merges");
  });
});

describe("hung turn detection", () => {
  function hungInput(): AuditInput {
    const input = baseInput();
    input.contextLogs.impl = {
      iterations: [
        rec(T("10:00:05"), "iteration.started", {
          iterationNumber: 1,
          model: "opus",
        }),
        rec(T("10:00:05"), "iteration.conversation_resolved", {
          conversationId: "conv-impl",
        }),
        rec(T("10:00:06"), "iteration.prompt_sent", { promptLength: 10000 }),
        rec(T("11:30:00"), "iteration.agent_turn_completed", {
          turnNumber: 0,
          contextTokens: 400000,
          contextWindowMax: 1000000,
        }),
        rec(T("11:31:00"), "iteration.completed", {
          iterationNumber: 1,
          completedTaskCount: 2,
          remainingTaskCount: 0,
        }),
      ],
      tasks: [],
      validation: [],
      validatorResponses: [],
    };
    return input;
  }

  it("excludes over-threshold turn intervals from agent-work time and flags them", () => {
    const report = buildAuditReport(hungInput());
    const impl = report.contexts.find((c) => c.contextId === "impl");
    expect(impl?.hungTurnMs).toBe(ms("11:30:00") - ms("10:00:06"));
    expect(impl?.agentTurnMs).toBe(0);
    expect(report.time.hungTurnMsTotal).toBe(ms("11:30:00") - ms("10:00:06"));
    const hung = report.friction.filter((f) => f.kind === "hung_turn");
    expect(hung).toHaveLength(1);
    expect(hung[0]?.severity).toBe("high");
    expect(hung[0]?.contextId).toBe("impl");
  });

  it("classifies gaps covered by a hung turn as hung_turn, not agent_work", () => {
    const report = buildAuditReport(hungInput());
    const gap = report.time.gaps.find((g) => g.startedAt === T("10:00:06"));
    expect(gap?.classification).toBe("hung_turn");
  });

  it("flags a trailing unterminated turn bounded by the execution's last activity", () => {
    const input = baseInput();
    input.contextLogs.impl = {
      iterations: [
        rec(T("10:00:05"), "iteration.started", { iterationNumber: 1 }),
        rec(T("10:00:06"), "iteration.prompt_sent", { promptLength: 10000 }),
      ],
      tasks: [],
      validation: [],
      validatorResponses: [],
    };
    const report = buildAuditReport(input);
    const impl = report.contexts.find((c) => c.contextId === "impl");
    // Bounded by execution.completedAt (12:00), the latest known activity.
    expect(impl?.hungTurnMs).toBe(ms("12:00:00") - ms("10:00:06"));
    expect(impl?.agentTurnMs).toBe(0);
    expect(report.friction.some((f) => f.kind === "hung_turn")).toBe(true);
  });

  it("keeps ordinary turn intervals in agent-work time", () => {
    const report = buildAuditReport(baseInput());
    const impl = report.contexts.find((c) => c.contextId === "impl");
    expect(impl?.hungTurnMs).toBe(0);
    expect(impl?.agentTurnMs).toBeGreaterThan(0);
    expect(report.friction.some((f) => f.kind === "hung_turn")).toBe(false);
  });
});

describe("script validation visibility", () => {
  it("counts script validation runs and classifies their windows as validation_compute", () => {
    const input = baseInput();
    input.contextLogs.impl = {
      ...input.contextLogs.impl!,
      validation: [
        rec(T("10:05:00"), "script_validation.started", {
          command: "bun run test",
        }),
        rec(T("10:25:00"), "script_validation.failed", { exitCode: 1 }),
      ],
    };
    const report = buildAuditReport(input);
    const impl = report.contexts.find((c) => c.contextId === "impl");
    expect(impl?.scriptValidationRuns).toEqual({
      started: 1,
      passed: 0,
      failed: 1,
    });
    const gap = report.time.gaps.find((g) => g.startedAt === T("10:05:00"));
    expect(gap?.classification).toBe("validation_compute");
    expect(
      report.friction.some(
        (f) => f.kind === "stall_gap" && f.summary.includes("10:05"),
      ),
    ).toBe(false);
  });
});

describe("occupancy confidence", () => {
  it.each(["codex", "claude"])(
    "reads backend-neutral lane counters without inventing %s occupancy",
    (backend) => {
      const input = baseInput();
      input.execution = mustParseExecution({
        ...baseExecutionRaw(),
        laneStates: {
          impl: {
            implementer: {
              lane: "implementer",
              backend,
              workflowConversationId: "conv-impl",
              metrics: { contextTokens: 850000, contextWindowMax: 1000000 },
            },
          },
        },
      });
      input.contextLogs = {};
      const context = buildAuditReport(input).contexts.find(
        (entry) => entry.contextId === "impl",
      );
      expect(context?.peakContextTokens).toBe(850000);
      expect(context?.peakOccupancyPct).toBe(backend === "codex" ? null : 85);
    },
  );

  it.each([null, 272000])(
    "does not interpret Codex cumulative usage as occupancy with window max %s",
    (windowMax) => {
      const raw = baseExecutionRaw();
      (
        raw.workingDefinition as { executionContexts: unknown[] }
      ).executionContexts = [
        {
          id: "impl",
          title: "Implement",
        },
        { id: "validate", title: "Validate" },
      ];
      (raw.laneStates as Record<string, Record<string, unknown>>).impl = {
        implementer: {
          lane: "implementer",
          engine: "codex",
          sessionRef: { conversationId: "conv-impl" },
          lastContextTokens: 750000,
          lastContextWindowMax: windowMax,
        },
      };
      const input: AuditInput = {
        ...baseInput(),
        execution: mustParseExecution(raw),
      };
      // Strip window max from turn records: a codex lane never reports one.
      input.contextLogs.impl = {
        ...input.contextLogs.impl!,
        iterations: input.contextLogs.impl!.iterations.map((record) =>
          record.event === "iteration.agent_turn_completed"
            ? {
                ...record,
                fields: { ...record.fields, contextWindowMax: windowMax },
              }
            : record,
        ),
      };
      const report = buildAuditReport(input);
      const impl = report.contexts.find((c) => c.contextId === "impl");
      expect(impl?.peakOccupancyPct).toBeNull();
      const note = report.confidence.find(
        (c) => c.kind === "occupancy_unmeasurable",
      );
      expect(note).toBeDefined();
      expect(note?.summary).toContain("impl");
    },
  );
});

describe("cost gaps", () => {
  it("flags a zero-cost conversation with substantial recorded activity", () => {
    const input = baseInput();
    input.conversations.push({
      id: "conv-zero",
      role: null,
      totalCostUsd: 0,
      totalDurationMs: 2400000,
      totalTurns: 40,
      contextTokens: null,
      contextWindowMax: null,
      transcriptPath: "/t/conv-zero.jsonl",
      transcriptScan: {
        costUsd: null,
        lineageCount: 0,
        apiTurns: null,
        toolUseCount: 100,
        toolCounts: [],
        toolErrorCount: 0,
        backgroundTasksKilled: 0,
        modelFallbacks: 0,
        compactions: 0,
        reads: { uniqueFiles: 0, totalReads: 0, repeatReads: 0 },
        topReReads: [],
      },
    });
    const report = buildAuditReport(input);
    const gaps = report.friction.filter((f) => f.kind === "cost_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.summary).toContain("conv-zero");
  });

  it("does not flag inactive conversations that merely lack a cost row", () => {
    // conv-extra in the base fixture has a null cost and no activity signals.
    const report = buildAuditReport(baseInput());
    expect(report.friction.some((f) => f.kind === "cost_gap")).toBe(false);
  });
});

describe("join attempt history", () => {
  it("surfaces join retries and withholds clean_merges", () => {
    const input = baseInput();
    input.lifecycle = [
      rec(T("10:52:00"), "merge.retry_attempted", {
        joinId: "join-1",
        attempt: 2,
      }),
      rec(T("10:57:00"), "merge.retry_attempted", {
        joinId: "join-1",
        attempt: 3,
      }),
    ];
    const report = buildAuditReport(input);
    const retry = report.friction.find((f) => f.kind === "join_retry");
    expect(retry).toBeDefined();
    expect(retry?.summary).toContain("join-1");
    expect(retry?.summary).toContain("2");
    expect(report.positives.map((p) => p.kind)).not.toContain("clean_merges");
  });
});

describe("telemetry confidence", () => {
  it("reports unscanned transcripts and unpriced validator decisions", () => {
    // Every base-fixture conversation lacks a transcript scan.
    const report = buildAuditReport(baseInput());
    const unscanned = report.confidence.find(
      (c) => c.kind === "transcripts_unscanned",
    );
    expect(unscanned).toBeDefined();
    expect(unscanned?.summary).toContain("4");
  });

  it("renders the confidence section, recovery table, and hung/recovery time totals", () => {
    const input = baseInput();
    input.lifecycle = [
      rec(T("11:32:00"), "execution.halted", {
        haltReason: { type: "join_failure", contextId: "impl" },
      }),
      rec(T("11:45:00"), "execution.resumed", {}),
    ];
    const md = renderMarkdown(buildAuditReport(input));
    expect(md).toContain("## Telemetry confidence");
    expect(md).toContain("operator recovery");
    expect(md).toContain("Halt recoveries");
    expect(md).toContain("join_failure");
  });
});
