/**
 * Tests for the AskUserQuestion MCP tool handler.
 *
 * Persistence-dependent behavior — does asking a question actually transition
 * the stored conversation to `waiting_for_input` with the pending question
 * recorded, and does answering clear it back to `running`? — is verified by
 * RELOADING the conversation through the real conversation seam
 * (`createPersistenceFixture().deps`) rather than by asserting on a non-
 * serializing in-memory fake. If `status` / `pendingQuestionId` /
 * `pendingQuestions` ever stop serializing, the reload-based assertions fail.
 *
 * Tests whose correctness does NOT depend on persisted state (registration,
 * the early-return error paths that short-circuit before any mutate, and the
 * abort path whose assertion is the rejection message) stay on lightweight
 * stubs — there is no persisted state for them to read back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetForTesting as resetRuntimeRegistry,
  conversationRuntimeKey,
  registerConversationRuntime,
  type ConversationRuntimeState,
} from "@/lib/workflows/conversation/runtime-state";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { conversationStateSchema } from "./schemas";
import type { ConversationState } from "./schemas";
import {
  registerAskUserQuestionTool,
  type AskUserQuestionToolDeps,
} from "./ask-user-question-tool";

type ToolHandler = (args: unknown) => Promise<unknown>;

interface CapturedTool {
  name: string;
  config: { description?: string; inputSchema?: unknown };
  handler: ToolHandler;
}

function createCapturingServer(tools: Map<string, CapturedTool>) {
  return {
    registerTool(name: string, config: unknown, handler: ToolHandler): void {
      tools.set(name, {
        name,
        config: config as CapturedTool["config"],
        handler,
      });
    },
  };
}

const projectPath = "/projects/test";
const sessionName = "test-session";
const conversationId = "conv-1";
const runtimeKey = conversationRuntimeKey(
  projectPath,
  sessionName,
  conversationId,
);

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return conversationStateSchema.parse({
    id: conversationId,
    transcriptPath: null,
    status: "running",
    promptCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:01:00Z",
    ...overrides,
  });
}

function createRuntimeState(
  overrides: Partial<ConversationRuntimeState> = {},
): ConversationRuntimeState {
  return {
    abortController: new AbortController(),
    sendToMachine: vi.fn(),
    streamEmit: vi.fn(),
    ...overrides,
  };
}

/**
 * Lightweight, non-persisting deps for tests whose correctness does not depend
 * on persisted conversation state (early returns, the abort-message path).
 */
function createStubDeps(
  overrides: Partial<AskUserQuestionToolDeps> = {},
): AskUserQuestionToolDeps {
  return {
    mutateConversation: vi.fn(async () => {}),
    getRuntime: (key) =>
      key === runtimeKey
        ? (overrides.getRuntime?.(key) ?? undefined)
        : undefined,
    ...overrides,
  };
}

function register(deps: AskUserQuestionToolDeps): {
  tools: Map<string, CapturedTool>;
  handler: ToolHandler;
} {
  const tools = new Map<string, CapturedTool>();
  registerAskUserQuestionTool(
    createCapturingServer(tools) as never,
    { projectPath, sessionName, conversationId },
    deps,
  );
  const tool = tools.get("AskUserQuestion");
  if (!tool) {
    throw new Error("AskUserQuestion tool was not registered");
  }
  return { tools, handler: tool.handler };
}

describe("ask-user-question-tool", () => {
  beforeEach(() => {
    resetRuntimeRegistry();
  });

  afterEach(() => {
    resetRuntimeRegistry();
  });

  it("registers the AskUserQuestion tool", () => {
    const { tools } = register(createStubDeps());
    expect(tools.has("AskUserQuestion")).toBe(true);
  });

  it("returns isError when no runtime is registered for the conversation", async () => {
    const { handler } = register(
      createStubDeps({ getRuntime: () => undefined }),
    );

    const result = (await handler({
      questions: [
        { question: "Pick one", options: [{ label: "a" }, { label: "b" }] },
      ],
    })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/runtime/i);
  });

  it("returns isError with autonomous parity message when currentTurnAutonomous is true", async () => {
    const runtimeState = createRuntimeState({ currentTurnAutonomous: true });
    registerConversationRuntime(runtimeKey, runtimeState);

    const { handler } = register(
      createStubDeps({ getRuntime: () => runtimeState }),
    );

    const result = (await handler({
      questions: [
        { question: "Pick one", options: [{ label: "a" }, { label: "b" }] },
      ],
    })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Autonomous optimistic mode — make your best judgment and proceed without asking questions.",
    );
    expect(runtimeState.sendToMachine).not.toHaveBeenCalled();
    expect(runtimeState.streamEmit).not.toHaveBeenCalled();
  });

  it("returns isError when called with an empty questions array", async () => {
    const runtimeState = createRuntimeState();
    registerConversationRuntime(runtimeKey, runtimeState);

    const { handler } = register(
      createStubDeps({ getRuntime: () => runtimeState }),
    );

    const result = (await handler({ questions: [] })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/at least one question/i);
  });

  describe("persisted pending-question lifecycle (real store)", () => {
    let fixture: PersistenceFixture;

    beforeEach(async () => {
      fixture = createPersistenceFixture();
      fixture.seedProject(projectPath);
      fixture.seedSession(projectPath, sessionName);
      await fixture.seedConversation(
        projectPath,
        sessionName,
        makeConversation(),
      );
    });

    afterEach(() => {
      fixture.close();
    });

    async function reload(): Promise<ConversationState> {
      const reloaded = await fixture.deps.getConversation(
        projectPath,
        sessionName,
        conversationId,
      );
      if (!reloaded) {
        throw new Error("conversation not found after reload");
      }
      return reloaded;
    }

    it("persists waiting_for_input with the pending question, then clears it on answer (verified by reload)", async () => {
      const runtimeState = createRuntimeState();
      registerConversationRuntime(runtimeKey, runtimeState);

      const { handler } = register(
        createStubDeps({
          getRuntime: () => runtimeState,
          mutateConversation: fixture.deps.mutateConversation,
        }),
      );

      const questions = [
        {
          question: "Pick one",
          options: [{ label: "a" }, { label: "b" }],
          multiSelect: false,
        },
      ];

      const resultPromise = handler({ questions });

      await vi.waitFor(() => {
        if (!runtimeState.activeQuestionResolver) {
          throw new Error("resolver not yet installed");
        }
      });

      // The handler mints a stable index id when the agent omits one, and
      // threads the normalized questions (not the raw args) downstream.
      expect(runtimeState.sendToMachine).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "ASK_QUESTION",
          questions: [
            expect.objectContaining({ id: "0", question: "Pick one" }),
          ],
        }),
      );
      expect(runtimeState.streamEmit).toHaveBeenCalledWith(
        "ask-question",
        expect.objectContaining({
          questions: [expect.objectContaining({ id: "0" })],
        }),
      );

      const waiting = await reload();
      expect(waiting.status).toBe("waiting_for_input");
      expect(waiting.pendingQuestionId).toEqual(expect.any(String));
      expect(waiting.pendingQuestions?.[0]).toMatchObject({
        id: "0",
        question: "Pick one",
        required: true, // schema default applied on persist round-trip
        allowNote: true,
      });

      runtimeState.activeQuestionResolver?.resolve({
        "0": {
          selected: ["a"],
          note: null,
          skipped: false,
          question: "Pick one",
        },
      });

      const result = (await resultPromise) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      expect(JSON.parse(text)).toEqual({
        "0": {
          selected: ["a"],
          note: null,
          skipped: false,
          question: "Pick one",
        },
      });

      const resumed = await reload();
      expect(resumed.status).toBe("running");
      expect(resumed.pendingQuestionId).toBeNull();
      expect(resumed.pendingQuestions).toBeNull();
    });

    it("clears the persisted pending question on the abort path (verified by reload)", async () => {
      const runtimeState = createRuntimeState();
      registerConversationRuntime(runtimeKey, runtimeState);

      const { handler } = register(
        createStubDeps({
          getRuntime: () => runtimeState,
          mutateConversation: fixture.deps.mutateConversation,
        }),
      );

      const resultPromise = handler({
        questions: [{ question: "Pick", options: [{ label: "a" }] }],
      });

      await vi.waitFor(() => {
        if (!runtimeState.activeQuestionResolver) {
          throw new Error("resolver not yet installed");
        }
      });

      expect((await reload()).status).toBe("waiting_for_input");

      runtimeState.activeQuestionResolver?.reject(
        new Error("Prompt aborted by user"),
      );

      const result = (await resultPromise) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Prompt aborted by user");

      const resumed = await reload();
      expect(resumed.status).toBe("running");
      expect(resumed.pendingQuestionId).toBeNull();
      expect(resumed.pendingQuestions).toBeNull();
    });
  });
});
