import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetForTesting as resetRuntimeRegistry,
  conversationRuntimeKey,
  registerConversationRuntime,
  type ConversationRuntimeState,
} from "@/lib/workflows/conversation/runtime-state";

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

function createDeps(
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
    const { tools } = register(createDeps());
    expect(tools.has("AskUserQuestion")).toBe(true);
  });

  it("returns isError when no runtime is registered for the conversation", async () => {
    const { handler } = register(createDeps({ getRuntime: () => undefined }));

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
      createDeps({ getRuntime: () => runtimeState }),
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
      createDeps({ getRuntime: () => runtimeState }),
    );

    const result = (await handler({ questions: [] })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/at least one question/i);
  });

  it("emits ASK_QUESTION, persists pending state, emits SSE, awaits resolver, and returns answers", async () => {
    const runtimeState = createRuntimeState();
    registerConversationRuntime(runtimeKey, runtimeState);

    const mutateConversation = vi.fn(async () => {});
    const { handler } = register(
      createDeps({
        getRuntime: () => runtimeState,
        mutateConversation,
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

    expect(runtimeState.sendToMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ASK_QUESTION",
        questions,
      }),
    );
    expect(runtimeState.streamEmit).toHaveBeenCalledWith(
      "ask-question",
      expect.objectContaining({ questions }),
    );

    expect(mutateConversation).toHaveBeenCalledWith(
      projectPath,
      sessionName,
      conversationId,
      "prompt.setWaitingForInput",
      expect.any(Function),
    );

    runtimeState.activeQuestionResolver?.resolve({ "Pick one": "a" });

    const result = (await resultPromise) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({ "Pick one": "a" });

    expect(mutateConversation).toHaveBeenCalledWith(
      projectPath,
      sessionName,
      conversationId,
      "prompt.resumeRunning",
      expect.any(Function),
    );
  });

  it("returns isError when the active question resolver is rejected (abort path)", async () => {
    const runtimeState = createRuntimeState();
    registerConversationRuntime(runtimeKey, runtimeState);

    const { handler } = register(
      createDeps({ getRuntime: () => runtimeState }),
    );

    const resultPromise = handler({
      questions: [{ question: "Pick", options: [{ label: "a" }] }],
    });

    await vi.waitFor(() => {
      if (!runtimeState.activeQuestionResolver) {
        throw new Error("resolver not yet installed");
      }
    });

    runtimeState.activeQuestionResolver?.reject(
      new Error("Prompt aborted by user"),
    );

    const result = (await resultPromise) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Prompt aborted by user");
  });
});
