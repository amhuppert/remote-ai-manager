import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState, RalphLoopWorkflow } from "@/types";
import type { PlanGeneratorDeps } from "./plan-generator";

// ---------------------------------------------------------------------------
// SDK mock (external dependency — acceptable to vi.mock)
// ---------------------------------------------------------------------------

let capturedToolHandler: ((args: unknown) => Promise<unknown>) | null = null;
let mockStreamMessages: Array<Record<string, unknown>> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn(() => {
      return {
        async *[Symbol.asyncIterator]() {
          for (const msg of mockStreamMessages) {
            yield msg;
          }
          // Simulate the tool call if a handler was captured
          if (capturedToolHandler) {
            await capturedToolHandler({
              tasks: [
                { description: "Implement JWT tokens", group: 1 },
                { description: "Add user registration", group: 1 },
                { description: "Write integration tests", group: 2 },
              ],
            });
          }
        },
      };
    }),
    createSdkMcpServer: vi.fn(
      (config: {
        tools: Array<{
          name: string;
          handler: (args: unknown) => Promise<unknown>;
        }>;
      }) => {
        for (const t of config.tools) {
          if (t.name === "submit_plan") {
            capturedToolHandler = t.handler;
          }
        }
        return { __mock: true };
      },
    ),
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) => ({ name, handler }),
    ),
  };
});

// ---------------------------------------------------------------------------
// Injected test deps (no vi.mock on internal modules)
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionState>();

function createTestDeps(): PlanGeneratorDeps {
  return {
    getSession: vi.fn(
      async (projectPath: string, sessionName: string) =>
        sessions.get(`${projectPath}::${sessionName}`) ?? null,
    ) as unknown as PlanGeneratorDeps["getSession"],
    mutateSession: vi.fn(
      async (
        projectPath: string,
        sessionName: string,
        _label: string,
        mutate: (session: SessionState) => unknown,
      ) => {
        const session = sessions.get(`${projectPath}::${sessionName}`);
        if (!session) throw new Error(`Session not found: ${sessionName}`);
        const result = await mutate(session);
        session.lastActivityAt = new Date().toISOString();
        return result;
      },
    ) as unknown as PlanGeneratorDeps["mutateSession"],
    readConversationMessages: vi.fn(async () => [
      {
        role: "user",
        content: [{ type: "text", text: "I need an auth system" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I'll help with that" }],
      },
    ]) as unknown as PlanGeneratorDeps["readConversationMessages"],
  };
}

// Injected spy for broadcast (no vi.mock needed)
const mockBroadcast = vi.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(
  overrides?: Partial<RalphLoopWorkflow>,
): RalphLoopWorkflow {
  return {
    status: "planning",
    objective: "Implement user authentication system",
    fixPlan: [],
    references: [],
    config: {
      maxIterations: 20,
      iterationTimeoutMs: 3_600_000,
      contextSoftLimitTokens: 160_000,
      contextHardLimitTokens: 180_000,
      circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
    },
    circuitBreaker: {
      state: "closed" as const,
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
      lastProgressIteration: 0,
    },
    iterations: [],
    haltReason: null,
    generatingPlan: false,
    createdAt: "2026-02-25T10:00:00Z",
    startedAt: null,
    completedAt: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    currentIterationConversationId: null,
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionName: "feature-auth",
    branchName: "csm/feature-auth",
    worktreePath: "/tmp/worktrees/feature-auth",
    createdAt: "2026-02-25T09:00:00Z",
    lastActivityAt: "2026-02-25T10:00:00Z",
    objective: "Auth system",
    conversations: [
      {
        id: "conv-001",
        status: "awaiting",
        role: null,
        transcriptPath: "/tmp/transcripts/conv-001.jsonl",
        lastActivityAt: "2026-02-25T10:00:00Z",
        createdAt: "2026-02-25T09:00:00Z",
        claudeSessionId: null,
        promptCount: 1,
        totalCostUsd: 0.1,
        totalDurationMs: 5000,
        totalTurns: 3,
      },
    ] as unknown as SessionState["conversations"],
    mode: "worktree" as const,
    workflow: makeWorkflow(),
    ...overrides,
  } as SessionState;
}

const PROJECT = "/home/user/my-project";
const SESSION_NAME = "feature-auth";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlanGenerator", () => {
  let deps: PlanGeneratorDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    sessions.clear();
    mockStreamMessages = [];
    capturedToolHandler = null;
    deps = createTestDeps();

    const session = makeSession();
    sessions.set(`${PROJECT}::${SESSION_NAME}`, session);
  });

  it("dispatches plan generation as fire-and-forget", async () => {
    const { dispatchPlanGeneration } = await import("./plan-generator");
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;

    // Should not throw — fire and forget
    expect(() =>
      dispatchPlanGeneration({
        projectPath: PROJECT,
        session,
        workflow: session.workflow!,
        deps,
      }),
    ).not.toThrow();

    // Give async operation time to complete
    await new Promise((r) => setTimeout(r, 200));
  });

  it("calls SDK query with planning-focused configuration", async () => {
    const { dispatchPlanGeneration } = await import("./plan-generator");
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;

    dispatchPlanGeneration({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
      deps,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "bypassPermissions",
          persistSession: false,
          cwd: session.worktreePath,
        }),
      }),
    );
  });

  it("persists generated tasks to workflow state", async () => {
    const { dispatchPlanGeneration } = await import("./plan-generator");
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;

    dispatchPlanGeneration({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
      deps,
    });

    await new Promise((r) => setTimeout(r, 300));

    const updatedSession = sessions.get(`${PROJECT}::${SESSION_NAME}`);
    const plan = updatedSession?.workflow?.fixPlan;
    expect(plan).toBeDefined();
    expect(plan!.length).toBe(3);
    expect(plan![0]!.description).toBe("Implement JWT tokens");
    expect(plan![0]!.group).toBe(1);
    expect(plan![0]!.status).toBe("pending");
    expect(plan![1]!.description).toBe("Add user registration");
    expect(plan![2]!.description).toBe("Write integration tests");
  });

  it("broadcasts fix plan update SSE event after generation", async () => {
    const { dispatchPlanGeneration } = await import("./plan-generator");
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;

    dispatchPlanGeneration({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
      broadcast: mockBroadcast,
      deps,
    });

    await new Promise((r) => setTimeout(r, 300));

    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workflow-fix-plan-updated",
        sessionName: SESSION_NAME,
        source: "tool",
      }),
    );
  });

  it("appends to existing tasks rather than replacing", async () => {
    // Pre-populate with existing tasks
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    session.workflow!.fixPlan = [
      {
        id: "existing-1",
        description: "Already planned task",
        group: 1,
        status: "pending" as const,
        createdAt: "2026-02-25T09:00:00Z",
        completedAt: null,
        skipReason: null,
        addedByIteration: null,
      },
    ];
    sessions.set(`${PROJECT}::${SESSION_NAME}`, session);

    const { dispatchPlanGeneration } = await import("./plan-generator");

    dispatchPlanGeneration({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
      deps,
    });

    await new Promise((r) => setTimeout(r, 300));

    const updatedSession = sessions.get(`${PROJECT}::${SESSION_NAME}`);
    const plan = updatedSession?.workflow?.fixPlan;
    // Original task + 3 generated tasks = 4
    expect(plan!.length).toBe(4);
    expect(plan![0]!.id).toBe("existing-1");
    expect(plan![0]!.description).toBe("Already planned task");
  });

  it("reads conversation messages for context", async () => {
    const { dispatchPlanGeneration } = await import("./plan-generator");
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;

    dispatchPlanGeneration({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
      deps,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(deps.readConversationMessages).toHaveBeenCalled();
  });

  it("denies AskUserQuestion tool during plan generation", async () => {
    const { dispatchPlanGeneration } = await import("./plan-generator");
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;

    dispatchPlanGeneration({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
      deps,
    });

    await new Promise((r) => setTimeout(r, 200));

    const callArgs = vi.mocked(query).mock.calls[0]?.[0] as {
      options?: {
        canUseTool?: (name: string) => Promise<{ behavior: string }>;
      };
    };
    const canUseTool = callArgs?.options?.canUseTool;
    if (canUseTool) {
      const result = await canUseTool("AskUserQuestion");
      expect(result.behavior).toBe("deny");
    }
  });
});
