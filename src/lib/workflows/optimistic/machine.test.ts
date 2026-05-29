import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise, toPromise } from "xstate";
import { optimisticMachine } from "./machine";
import type { OptimisticInput } from "./types";
import type {
  ExecutePromptInput,
  ExecutePromptOutput,
  DispatchMergeInput,
  DispatchMergeOutput,
} from "./actors";
import type { SessionState } from "@/lib/sessions/schemas";
// ============================================================
// Test Helpers
// ============================================================

const testSession: SessionState = {
  sessionName: "test-session",
  worktreePath: "/projects/app/.worktrees/test-session",
  branchName: "csm/test-session",
  createdAt: "2024-01-01T00:00:00Z",
  lastActivityAt: "2024-01-01T00:00:00Z",
  archived: false,
  finished: false,
  conversations: [
    {
      id: "conv-123",
      name: null,
      transcriptPath: null,
      status: "new",
      promptCount: 0,
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      source: "cc",
      summary: null,
      archived: false,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      pendingPromptText: null,
      forkedFrom: null,
      role: null,
      activeTurnSource: null,
      contextTokens: null,
      contextWindowMax: null,
      debugMode: null,
      machineSnapshot: null,
      agentBackend: "claude" as const,
      backendRef: null,
    },
  ],
  source: "cc",
  objective: "Build a feature",
  creationMode: "optimistic",
  tddEnabled: true,
  targetBranch: "main",
  parentSessionName: null,
  graphWorkflowExecution: null,
  graphWorkflowExecutionHistory: [],
  referenceDocuments: [],
};

const defaultInput: OptimisticInput = {
  projectPath: "/projects/app",
  projectName: "app",
  sessionName: "test-session",
  session: testSession,
  instructions: "Add a login page",
};

type PromptActor = ReturnType<
  typeof fromPromise<ExecutePromptOutput, ExecutePromptInput>
>;
type MergeActor = ReturnType<
  typeof fromPromise<DispatchMergeOutput, DispatchMergeInput>
>;

/** Helper to create a typed prompt actor for tests. */
function mockPromptActor(
  fn: (input: ExecutePromptInput) => Promise<ExecutePromptOutput>,
): PromptActor {
  return fromPromise<ExecutePromptOutput, ExecutePromptInput>(
    async ({ input }) => fn(input),
  );
}

/** Helper to create a typed merge actor for tests. */
function mockMergeActor(
  fn: (input: DispatchMergeInput) => Promise<DispatchMergeOutput>,
): MergeActor {
  return fromPromise<DispatchMergeOutput, DispatchMergeInput>(
    async ({ input }) => fn(input),
  );
}

function createTestMachine(
  overrides: {
    executePrompt?: PromptActor;
    dispatchMerge?: MergeActor;
    notifyFailure?: () => void;
  } = {},
) {
  return optimisticMachine.provide({
    actors: {
      executePrompt:
        overrides.executePrompt ??
        mockPromptActor(async () => ({ conversationId: "conv-result" })),
      dispatchMerge:
        overrides.dispatchMerge ??
        mockMergeActor(async () => ({ jobId: "job-123" })),
    },
    actions: {
      notifyFailure: overrides.notifyFailure ?? vi.fn(),
    },
  });
}

// ============================================================
// Tests
// ============================================================

describe("optimisticMachine", () => {
  describe("initial state", () => {
    it("starts in executingPrompt state", () => {
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      expect(actor.getSnapshot().value).toBe("executingPrompt");
    });

    it("initializes context from input", () => {
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const ctx = actor.getSnapshot().context;
      expect(ctx.projectPath).toBe("/projects/app");
      expect(ctx.projectName).toBe("app");
      expect(ctx.sessionName).toBe("test-session");
      expect(ctx.instructions).toBe("Add a login page");
      expect(ctx.images).toEqual([]);
      expect(ctx.error).toBeNull();
      expect(ctx.conversationId).toBeNull();
      expect(ctx.mergeJobId).toBeNull();
      expect(ctx._schemaVersion).toBe(1);
      expect(ctx.startedAt).toBeTruthy();
      expect(ctx.completedAt).toBeNull();
    });
  });

  describe("happy path: executingPrompt → dispatchingMerge → completed", () => {
    it("transitions through the full lifecycle", async () => {
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(true);
      expect(output.conversationId).toBe("conv-result");
      expect(output.mergeJobId).toBe("job-123");
      expect(output.error).toBeNull();
    });

    it("stores conversationId from prompt execution", async () => {
      const machine = createTestMachine({
        executePrompt: mockPromptActor(async () => ({
          conversationId: "custom-conv-id",
        })),
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);
      expect(output.conversationId).toBe("custom-conv-id");
    });

    it("stores mergeJobId from merge dispatch", async () => {
      const machine = createTestMachine({
        dispatchMerge: mockMergeActor(async () => ({
          jobId: "merge-job-456",
        })),
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);
      expect(output.mergeJobId).toBe("merge-job-456");
    });

    it("sets completedAt on completion", async () => {
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);
      const ctx = actor.getSnapshot().context;
      expect(ctx.completedAt).toBeTruthy();
    });
  });

  describe("prompt execution failure", () => {
    it("transitions to failed when prompt throws", async () => {
      const notifyFn = vi.fn();
      const machine = createTestMachine({
        executePrompt: mockPromptActor(async () => {
          throw new Error("SDK connection failed");
        }),
        notifyFailure: notifyFn,
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(false);
      expect(output.error).toBe("SDK connection failed");
      expect(output.conversationId).toBeNull();
      expect(output.mergeJobId).toBeNull();
    });

    it("calls notifyFailure on prompt failure", async () => {
      const notifyFn = vi.fn();
      const machine = createTestMachine({
        executePrompt: mockPromptActor(async () => {
          throw new Error("Timeout");
        }),
        notifyFailure: notifyFn,
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(notifyFn).toHaveBeenCalled();
    });

    it("sets completedAt on failure", async () => {
      const machine = createTestMachine({
        executePrompt: mockPromptActor(async () => {
          throw new Error("fail");
        }),
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);
      const ctx = actor.getSnapshot().context;
      expect(ctx.completedAt).toBeTruthy();
    });
  });

  describe("merge dispatch failure", () => {
    it("transitions to failed when merge dispatch throws", async () => {
      const machine = createTestMachine({
        dispatchMerge: mockMergeActor(async () => {
          throw new Error("Merge dispatch failed: JOB_ALREADY_RUNNING");
        }),
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(false);
      expect(output.error).toBe("Merge dispatch failed: JOB_ALREADY_RUNNING");
      // Should have conversation ID from successful prompt
      expect(output.conversationId).toBe("conv-result");
      expect(output.mergeJobId).toBeNull();
    });

    it("calls notifyFailure on merge failure", async () => {
      const notifyFn = vi.fn();
      const machine = createTestMachine({
        dispatchMerge: mockMergeActor(async () => {
          throw new Error("merge failed");
        }),
        notifyFailure: notifyFn,
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);
      expect(notifyFn).toHaveBeenCalled();
    });
  });

  describe("context preservation", () => {
    it("preserves project context across transitions", async () => {
      const states: string[] = [];
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((snapshot) => {
        states.push(String(snapshot.value));
      });

      actor.start();
      await toPromise(actor);

      // Should have observed: executingPrompt, dispatchingMerge, completed
      expect(states).toContain("executingPrompt");
      expect(states).toContain("dispatchingMerge");
      expect(states).toContain("completed");

      const ctx = actor.getSnapshot().context;
      expect(ctx.projectPath).toBe("/projects/app");
      expect(ctx.projectName).toBe("app");
      expect(ctx.sessionName).toBe("test-session");
    });

    it("includes images in context when provided", async () => {
      const inputWithImages: OptimisticInput = {
        ...defaultInput,
        images: [
          {
            attachmentId: "img-1",
            mediaType: "image/png",
            base64Data: "abc123",
          },
        ],
      };

      const machine = createTestMachine();
      const actor = createActor(machine, { input: inputWithImages });
      actor.start();

      const ctx = actor.getSnapshot().context;
      expect(ctx.images).toHaveLength(1);
      expect(ctx.images[0]!.mediaType).toBe("image/png");

      await toPromise(actor);
    });
  });

  describe("terminal states", () => {
    it("completed is a final state", async () => {
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(actor.getSnapshot().status).toBe("done");
    });

    it("failed is a final state", async () => {
      const machine = createTestMachine({
        executePrompt: mockPromptActor(async () => {
          throw new Error("boom");
        }),
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(actor.getSnapshot().status).toBe("done");
    });

    it("output reflects success on completed", async () => {
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);
      expect(output.success).toBe(true);
    });

    it("output reflects failure on failed", async () => {
      const machine = createTestMachine({
        executePrompt: mockPromptActor(async () => {
          throw new Error("nope");
        }),
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);
      expect(output.success).toBe(false);
    });
  });

  describe("non-Error exceptions", () => {
    it("handles non-Error thrown values in prompt execution", async () => {
      const machine = createTestMachine({
        executePrompt: mockPromptActor(async () => {
          throw "string error";
        }),
      });

      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);
      expect(output.success).toBe(false);
      expect(output.error).toBe("string error");
    });
  });
});
