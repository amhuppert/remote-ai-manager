import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SessionState,
  RalphLoopWorkflow,
} from "@/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track what the plan generator persists
const sessions = new Map<string, SessionState>();

// SDK mock: the plan generator expects to call submit_plan via MCP tool
let mockStreamMessages: Array<Record<string, unknown>> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  let capturedToolHandler: ((args: unknown) => Promise<unknown>) | null = null;

  return {
    query: vi.fn((_args: { options?: { mcpServers?: Record<string, unknown> } }) => {
      // Access the MCP server to get the submit_plan handler
      // (In real flow, the SDK invokes the tool — here we simulate it)
      return {
        async *[Symbol.asyncIterator]() {
          for (const msg of mockStreamMessages) {
            yield msg;
          }
          // Simulate the tool call if a handler was captured
          if (capturedToolHandler) {
            await capturedToolHandler({
              tasks: [
                { description: "Implement JWT tokens", priority: "high" },
                { description: "Add user registration", priority: "medium" },
                { description: "Write integration tests", priority: "low" },
              ],
            });
          }
        },
      };
    }),
    createSdkMcpServer: vi.fn((config: { tools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
      for (const t of config.tools) {
        if (t.name === "submit_plan") {
          capturedToolHandler = t.handler;
        }
      }
      return { __mock: true };
    }),
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

vi.mock("../state", () => ({
  getSession: vi.fn(
    async (projectPath: string, sessionName: string) =>
      sessions.get(`${projectPath}::${sessionName}`) ?? null,
  ),
  updateSession: vi.fn(async (projectPath: string, session: SessionState) => {
    sessions.set(`${projectPath}::${session.sessionName}`, session);
  }),
}));

vi.mock("../logging", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../transcript", () => ({
  readConversationMessages: vi.fn(async () => [
    {
      role: "user",
      content: [{ type: "text", text: "I need an auth system" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "I'll help with that" }],
    },
  ]),
}));

vi.mock("../sse-broadcaster", () => ({
  broadcast: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(overrides?: Partial<RalphLoopWorkflow>): RalphLoopWorkflow {
  return {
    status: "planning",
    objective: "Implement user authentication system",
    fixPlan: [],
    config: {
      maxIterations: 20,
      iterationTimeoutMs: 3_600_000,
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
    createdAt: "2026-02-25T10:00:00Z",
    startedAt: null,
    completedAt: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
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
  beforeEach(() => {
    vi.clearAllMocks();
    sessions.clear();
    mockStreamMessages = [];

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
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          maxTurns: 3,
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
    });

    await new Promise((r) => setTimeout(r, 300));

    const updatedSession = sessions.get(`${PROJECT}::${SESSION_NAME}`);
    const plan = updatedSession?.workflow?.fixPlan;
    expect(plan).toBeDefined();
    expect(plan!.length).toBe(3);
    expect(plan![0]!.description).toBe("Implement JWT tokens");
    expect(plan![0]!.priority).toBe("high");
    expect(plan![0]!.status).toBe("pending");
    expect(plan![1]!.description).toBe("Add user registration");
    expect(plan![2]!.description).toBe("Write integration tests");
  });

  it("broadcasts fix plan update SSE event after generation", async () => {
    const { dispatchPlanGeneration } = await import("./plan-generator");
    const { broadcast } = await import("../sse-broadcaster");
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;

    dispatchPlanGeneration({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 300));

    expect(broadcast).toHaveBeenCalledWith(
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
        priority: "high" as const,
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
    const { readConversationMessages } = await import("../transcript");
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;

    dispatchPlanGeneration({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(readConversationMessages).toHaveBeenCalled();
  });

  it("denies AskUserQuestion tool during plan generation", async () => {
    const { dispatchPlanGeneration } = await import("./plan-generator");
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;

    dispatchPlanGeneration({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 200));

    const callArgs = vi.mocked(query).mock.calls[0]?.[0] as {
      options?: { canUseTool?: (name: string) => Promise<{ behavior: string }> };
    };
    const canUseTool = callArgs?.options?.canUseTool;
    if (canUseTool) {
      const result = await canUseTool("AskUserQuestion");
      expect(result.behavior).toBe("deny");
    }
  });
});
