import { describe, it, expect } from "vitest";
import { buildSessionContext, buildConversationContext } from "./copy-context";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    scope: "session",
    name: null,
    transcriptPath: "/tmp/transcripts/conv-1.jsonl",
    status: "awaiting" as const,
    promptCount: 3,
    createdAt: "2026-03-28T10:00:00Z",
    lastActivityAt: "2026-03-28T12:00:00Z",
    source: "cc" as const,
    summary: null,
    archived: false,
    totalCostUsd: 0.42,
    totalDurationMs: 60000,
    totalTurns: 5,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: 80000,
    contextWindowMax: 200000,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude" as const,
    backendRef: null,
    unread: false,
    pendingQueue: [],
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}): SessionState {
  return {
    sessionName: "my-session",
    worktreePath: "/home/user/project/.worktrees/my-session",
    branchName: "csm/my-session",
    createdAt: "2026-03-28T09:00:00Z",
    lastActivityAt: "2026-03-28T12:00:00Z",
    archived: false,
    finished: false,
    conversations: [makeConversation()],
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
    ...overrides,
  } as SessionState;
}

function makeGraphWorkflowExecution(
  overrides: Record<string, unknown> = {},
): GraphWorkflowExecution {
  return {
    id: "exec-1",
    seedDefinitionId: "def-abc",
    seedDefinitionRevision: 3,
    workingDefinition: {
      schemaVersion: 1,
      executionContexts: [
        {
          id: "ctx-1",
          title: "Implementation",
          description: "Implement the feature",
          acceptanceCriteria: "TBD",
          implementer: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          contextValidator: null,
          scriptValidator: { enabled: false },
          humanApprovalGate: { enabled: false },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 10, continuity: { enabled: true } },
        },
        {
          id: "ctx-2",
          title: "Testing",
          acceptanceCriteria: "TBD",
          implementer: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          contextValidator: null,
          scriptValidator: { enabled: false },
          humanApprovalGate: { enabled: false },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
        },
      ],
      tasks: [
        {
          id: "task-1",
          contextId: "ctx-1",
          order: 1,
          title: "Build the widget",
          instructions: "...",
          source: "user",
        },
        {
          id: "task-2",
          contextId: "ctx-1",
          order: 2,
          title: "Wire up events",
          instructions: "...",
          source: "user",
        },
        {
          id: "task-3",
          contextId: "ctx-2",
          order: 1,
          title: "Write unit tests",
          instructions: "...",
          source: "user",
        },
      ],
      edges: [
        { id: "e-1", sourceContextId: "ctx-1", targetContextId: "ctx-2" },
      ],
    },
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: ["ctx-1"],
    contextStates: {
      "ctx-1": {
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 2,
        completedTaskCount: 1,
        iterationCount: 2,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
        pendingApproval: null,
      },
      "ctx-2": {
        contextId: "ctx-2",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
        pendingApproval: null,
      },
    },
    taskStates: {
      "task-1": {
        taskId: "task-1",
        contextId: "ctx-1",
        order: 1,
        status: "completed",
        summary: "Built widget component",
        startedAt: "2026-03-28T10:00:00Z",
        completedAt: "2026-03-28T10:30:00Z",
        lastConversationId: "conv-iter-1",
        failureMessage: null,
        failureHistory: [],
      },
      "task-2": {
        taskId: "task-2",
        contextId: "ctx-1",
        order: 2,
        status: "running",
        summary: null,
        startedAt: "2026-03-28T10:30:00Z",
        completedAt: null,
        lastConversationId: "conv-iter-2",
        failureMessage: null,
        failureHistory: [],
      },
      "task-3": {
        taskId: "task-3",
        contextId: "ctx-2",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
    },
    sharedDocuments: [],
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
    machineSnapshot: null,
    history: [],
    startedAt: "2026-03-28T10:00:00Z",
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    pendingCollaborations: {},
    collaborationContinuations: {},
    pendingMergeRetry: [],
    ...overrides,
  } as GraphWorkflowExecution;
}

// ---------------------------------------------------------------------------
// Tests: buildSessionContext
// ---------------------------------------------------------------------------

describe("buildSessionContext", () => {
  it("includes basic session fields", () => {
    const session = makeSession();
    const result = buildSessionContext({
      projectName: "my-project",
      sessionName: "my-session",
      session,
    });

    expect(result).toContain("<project>my-project</project>");
    expect(result).toContain("<session>my-session</session>");
    expect(result).toContain("<branch>csm/my-session</branch>");
    expect(result).toContain(
      "<worktree>/home/user/project/.worktrees/my-session</worktree>",
    );
    expect(result).toContain("<created>2026-03-28T09:00:00Z</created>");
    expect(result).toContain("<conversation-count>1</conversation-count>");
    expect(result).toContain("<total-prompts>3</total-prompts>");
    expect(result).toContain("<source>cc</source>");
    expect(result).toContain("<creation-mode>fast</creation-mode>");
    expect(result).toContain("<finished>false</finished>");
  });

  it("includes session status", () => {
    const session = makeSession();
    const result = buildSessionContext({
      projectName: "p",
      sessionName: "s",
      session,
    });
    expect(result).toContain("<status>awaiting</status>");
  });

  it("wraps output in xml code block", () => {
    const session = makeSession();
    const result = buildSessionContext({
      projectName: "p",
      sessionName: "s",
      session,
    });
    expect(result).toMatch(/^```xml\n/);
    expect(result).toMatch(/\n```$/);
    expect(result).toContain("<session-context>");
    expect(result).toContain("</session-context>");
  });

  it("omits workflow section when no workflow is active", () => {
    const session = makeSession();
    const result = buildSessionContext({
      projectName: "p",
      sessionName: "s",
      session,
    });
    expect(result).not.toContain("<graph-workflow>");
  });

  it("sources the workflow block from the execution param, not session.graphWorkflowExecution", () => {
    // The executions table is decoupled from the sessions row, so
    // session.graphWorkflowExecution is always null in production. The block
    // must appear only when the execution is threaded in explicitly.
    const execution = makeGraphWorkflowExecution();
    const sessionCarryingField = makeSession({
      graphWorkflowExecution: execution,
    });

    const withoutParam = buildSessionContext({
      projectName: "p",
      sessionName: "s",
      session: sessionCarryingField,
    });
    expect(withoutParam).not.toContain("<graph-workflow>");

    const withParam = buildSessionContext({
      projectName: "p",
      sessionName: "s",
      session: makeSession(),
      graphWorkflowExecution: execution,
    });
    expect(withParam).toContain("<graph-workflow>");
    expect(withParam).toContain("<execution-id>exec-1</execution-id>");
  });

  it("includes graph workflow execution info when active", () => {
    const execution = makeGraphWorkflowExecution();
    const session = makeSession();
    const result = buildSessionContext({
      projectName: "p",
      sessionName: "s",
      session,
      graphWorkflowExecution: execution,
    });

    expect(result).toContain("<graph-workflow>");
    expect(result).toContain("<execution-id>exec-1</execution-id>");
    expect(result).toContain("<workflow-status>running</workflow-status>");
    expect(result).toContain(
      "<seed-definition-id>def-abc</seed-definition-id>",
    );
    expect(result).toContain(
      "<seed-definition-revision>3</seed-definition-revision>",
    );
    expect(result).toContain("<active-context-id>ctx-1</active-context-id>");
    expect(result).toContain(
      "<active-context-title>Implementation</active-context-title>",
    );
    expect(result).toContain(
      "<context-iteration-count>2</context-iteration-count>",
    );
    expect(result).toContain(
      "<context-completed-tasks>1</context-completed-tasks>",
    );
    expect(result).toContain("<context-total-tasks>2</context-total-tasks>");
    expect(result).toContain("<total-contexts>2</total-contexts>");
    expect(result).toContain("<completed-contexts>0</completed-contexts>");
    expect(result).toContain("</graph-workflow>");
  });

  it("includes graph workflow halt reason when halted", () => {
    const execution = makeGraphWorkflowExecution({
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: "ctx-1",
        failureCount: 3,
      },
    });
    const session = makeSession();
    const result = buildSessionContext({
      projectName: "p",
      sessionName: "s",
      session,
      graphWorkflowExecution: execution,
    });

    expect(result).toContain("<halt-reason>circuit_breaker</halt-reason>");
  });
});

// ---------------------------------------------------------------------------
// Tests: buildConversationContext
// ---------------------------------------------------------------------------

describe("buildConversationContext", () => {
  it("includes basic conversation fields", () => {
    const session = makeSession();
    const result = buildConversationContext({
      projectName: "my-project",
      sessionName: "my-session",
      session,
      conversationId: "conv-1",
    });

    expect(result).toContain("<project>my-project</project>");
    expect(result).toContain("<session>my-session</session>");
    expect(result).toContain("<branch>csm/my-session</branch>");
    expect(result).toContain(
      "<worktree>/home/user/project/.worktrees/my-session</worktree>",
    );
    expect(result).toContain("<conversation-id>conv-1</conversation-id>");
    expect(result).toContain("<agent-backend>claude</agent-backend>");
    expect(result).toContain("<agent-session-ref>null</agent-session-ref>");
    expect(result).toContain("<status>awaiting</status>");
    expect(result).toContain("<prompt-count>3</prompt-count>");
    expect(result).toContain(
      "<last-activity>2026-03-28T12:00:00Z</last-activity>",
    );
    expect(result).toContain(
      "<transcript-path>/tmp/transcripts/conv-1.jsonl</transcript-path>",
    );
    expect(result).toContain("<total-cost-usd>0.42</total-cost-usd>");
    expect(result).toContain("<total-duration-ms>60000</total-duration-ms>");
    expect(result).toContain("<total-turns>5</total-turns>");
    expect(result).toContain("<source>cc</source>");
    expect(result).toContain("<session-source>cc</session-source>");
    expect(result).toContain("<creation-mode>fast</creation-mode>");
  });

  it("wraps output in xml code block", () => {
    const session = makeSession();
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "conv-1",
    });
    expect(result).toMatch(/^```xml\n/);
    expect(result).toMatch(/\n```$/);
    expect(result).toContain("<conversation-context>");
    expect(result).toContain("</conversation-context>");
  });

  it("includes conversation role when set", () => {
    const session = makeSession({
      conversations: [makeConversation({ role: "iteration" })],
    });
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "conv-1",
    });

    expect(result).toContain("<role>iteration</role>");
  });

  it("includes context token info when available", () => {
    const session = makeSession({
      conversations: [
        makeConversation({ contextTokens: 80000, contextWindowMax: 200000 }),
      ],
    });
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "conv-1",
    });

    expect(result).toContain("<context-tokens>80000</context-tokens>");
    expect(result).toContain("<context-window-max>200000</context-window-max>");
  });

  it("omits workflow section when no workflow is active", () => {
    const session = makeSession();
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "conv-1",
    });
    expect(result).not.toContain("<graph-workflow>");
  });

  it("includes graph workflow info with task linkage for iteration conversation", () => {
    const execution = makeGraphWorkflowExecution();
    const session = makeSession({
      conversations: [
        makeConversation({ id: "conv-iter-2", role: "iteration" }),
      ],
    });
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "conv-iter-2",
      graphWorkflowExecution: execution,
    });

    expect(result).toContain("<graph-workflow>");
    expect(result).toContain("<execution-id>exec-1</execution-id>");
    expect(result).toContain(
      "<active-context-title>Implementation</active-context-title>",
    );
    // Should include which task this conversation is linked to
    expect(result).toContain("<linked-task-id>task-2</linked-task-id>");
    expect(result).toContain(
      "<linked-task-title>Wire up events</linked-task-title>",
    );
  });

  it("handles missing conversation gracefully", () => {
    const session = makeSession();
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "nonexistent",
    });

    // Should still produce valid output with empty values
    expect(result).toContain("<conversation-context>");
    expect(result).toContain("<conversation-id>nonexistent</conversation-id>");
    expect(result).toContain("<status></status>");
  });
});
