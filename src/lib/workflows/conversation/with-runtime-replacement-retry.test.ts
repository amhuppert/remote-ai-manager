import { describe, it, expect, vi } from "vitest";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import { markPromptNotDelivered } from "@/lib/agent-backends/errors";
import {
  shouldReplaceRuntimeAndRetry,
  withRuntimeReplacementRetry,
  type RuntimeReplacementRetryDeps,
} from "./with-runtime-replacement-retry";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const META = {
  conversationId: "conv-1",
  sessionName: "sess",
  backend: "claude",
};

function makeTurnResult(
  overrides: Partial<ConversationBackendTurnResult> = {},
): ConversationBackendTurnResult {
  return {
    backendRef: { backend: "claude", ref: "sdk-1" },
    costUsd: null,
    durationMs: 10,
    numTurns: 1,
    contextTokens: null,
    contextWindowMax: null,
    contentBlocks: [{ type: "text", text: "ok" }],
    aborted: false,
    compacted: false,
    failure: null,
    continuationDisposition: "retain",
    ...overrides,
  };
}

function makeRuntime(
  overrides: Partial<ConversationBackendRuntime> = {},
): ConversationBackendRuntime {
  return {
    backend: "claude",
    status: "alive",
    modelId: "opus",
    reasoningEffort: undefined,
    outputFormat: undefined,
    alignmentVersion: null,
    async sendTurn() {
      return makeTurnResult();
    },
    close: vi.fn(),
    ...overrides,
  };
}

function makeTurnInput(): ConversationBackendTurnInput {
  return {
    promptText: "hi",
    imageRefs: [],
    sessionInstructions: [],
    autonomous: false,
    signal: new AbortController().signal,
    onEvent: () => {},
  };
}

function stubClassify(
  retryable = true,
): RuntimeReplacementRetryDeps["classify"] {
  return (error) => ({
    kind: "session_died",
    message: error instanceof Error ? error.message : String(error),
    retryable,
  });
}

describe("shouldReplaceRuntimeAndRetry", () => {
  const markedError = markPromptNotDelivered(new Error("never delivered"));

  it("allows exactly one retry for a marked error on a dead runtime", () => {
    expect(
      shouldReplaceRuntimeAndRetry({
        error: markedError,
        runtimeStatus: "dead",
        aborted: false,
        attempt: 0,
        retryable: true,
      }),
    ).toBe(true);
  });

  it("denies retry when the classifier vetoes a delivery-safe marked error", () => {
    expect(
      shouldReplaceRuntimeAndRetry({
        error: markedError,
        runtimeStatus: "dead",
        aborted: false,
        attempt: 0,
        retryable: false,
      }),
    ).toBe(false);
  });

  it("denies a second attempt", () => {
    expect(
      shouldReplaceRuntimeAndRetry({
        error: markedError,
        runtimeStatus: "dead",
        aborted: false,
        attempt: 1,
        retryable: true,
      }),
    ).toBe(false);
  });

  it("denies retry when the turn was aborted", () => {
    expect(
      shouldReplaceRuntimeAndRetry({
        error: markedError,
        runtimeStatus: "dead",
        aborted: true,
        attempt: 0,
        retryable: true,
      }),
    ).toBe(false);
  });

  it("denies retry while the runtime is still alive", () => {
    expect(
      shouldReplaceRuntimeAndRetry({
        error: markedError,
        runtimeStatus: "alive",
        aborted: false,
        attempt: 0,
        retryable: true,
      }),
    ).toBe(false);
  });

  it("denies retry for an unmarked error (delivery not provably safe)", () => {
    expect(
      shouldReplaceRuntimeAndRetry({
        error: new Error("mid-turn death"),
        runtimeStatus: "dead",
        aborted: false,
        attempt: 0,
        retryable: true,
      }),
    ).toBe(false);
  });
});

describe("withRuntimeReplacementRetry", () => {
  it("replaces the runtime and reattempts once on an undelivered prompt", async () => {
    const staleRuntime = makeRuntime({
      async sendTurn() {
        (staleRuntime as { status: string }).status = "dead";
        throw markPromptNotDelivered(new Error("died before delivery"));
      },
    });
    const freshResult = makeTurnResult({
      backendRef: { backend: "claude", ref: "sdk-fresh" },
    });
    const freshRuntime = makeRuntime({
      async sendTurn() {
        return freshResult;
      },
    });

    let current = staleRuntime;
    const replaceRuntime = vi.fn(async () => {
      current = freshRuntime;
      return freshRuntime;
    });

    const wrapped = withRuntimeReplacementRetry({
      getRuntime: () => current,
      replaceRuntime,
      classify: stubClassify(),
      signal: new AbortController().signal,
      meta: META,
    });

    const result = await wrapped.sendTurn(makeTurnInput());
    expect(replaceRuntime).toHaveBeenCalledTimes(1);
    expect(result.backendRef).toEqual({ backend: "claude", ref: "sdk-fresh" });
  });

  it("rethrows without replacement when the failure is not delivery-safe", async () => {
    const runtime = makeRuntime({
      async sendTurn() {
        (runtime as { status: string }).status = "dead";
        throw new Error("mid-turn pipe break");
      },
    });
    const replaceRuntime = vi.fn();

    const wrapped = withRuntimeReplacementRetry({
      getRuntime: () => runtime,
      replaceRuntime,
      classify: stubClassify(),
      signal: new AbortController().signal,
      meta: META,
    });

    await expect(wrapped.sendTurn(makeTurnInput())).rejects.toThrow(
      "mid-turn pipe break",
    );
    expect(replaceRuntime).not.toHaveBeenCalled();
  });

  it("rethrows without replacement when the classifier vetoes a delivery-safe marked error", async () => {
    const runtime = makeRuntime({
      async sendTurn() {
        (runtime as { status: string }).status = "dead";
        throw markPromptNotDelivered(new Error("died before delivery"));
      },
    });
    const replaceRuntime = vi.fn();

    const wrapped = withRuntimeReplacementRetry({
      getRuntime: () => runtime,
      replaceRuntime,
      classify: stubClassify(false),
      signal: new AbortController().signal,
      meta: META,
    });

    await expect(wrapped.sendTurn(makeTurnInput())).rejects.toThrow(
      "died before delivery",
    );
    expect(replaceRuntime).not.toHaveBeenCalled();
  });

  it("classifies the failure exactly once on the successful-reattempt path", async () => {
    const staleRuntime = makeRuntime({
      async sendTurn() {
        (staleRuntime as { status: string }).status = "dead";
        throw markPromptNotDelivered(new Error("died before delivery"));
      },
    });
    const freshRuntime = makeRuntime({
      async sendTurn() {
        return makeTurnResult();
      },
    });
    let current = staleRuntime;
    const classify = vi.fn(stubClassify(true));

    const wrapped = withRuntimeReplacementRetry({
      getRuntime: () => current,
      replaceRuntime: async () => {
        current = freshRuntime;
        return freshRuntime;
      },
      classify,
      signal: new AbortController().signal,
      meta: META,
    });

    await wrapped.sendTurn(makeTurnInput());
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("classifies each failure once on the failed-reattempt path", async () => {
    const runtime = makeRuntime({
      status: "dead",
      async sendTurn() {
        throw markPromptNotDelivered(new Error("still dead"));
      },
    });
    const classify = vi.fn(stubClassify(true));

    const wrapped = withRuntimeReplacementRetry({
      getRuntime: () => runtime,
      replaceRuntime: async () => runtime,
      classify,
      signal: new AbortController().signal,
      meta: META,
    });

    await expect(wrapped.sendTurn(makeTurnInput())).rejects.toThrow(
      "still dead",
    );
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("rethrows after a failed second attempt instead of looping", async () => {
    const dyingSendTurn = vi.fn(async () => {
      throw markPromptNotDelivered(new Error("still dead"));
    });
    const runtime = makeRuntime({ status: "dead", sendTurn: dyingSendTurn });

    const wrapped = withRuntimeReplacementRetry({
      getRuntime: () => runtime,
      replaceRuntime: async () => runtime,
      classify: stubClassify(),
      signal: new AbortController().signal,
      meta: META,
    });

    await expect(wrapped.sendTurn(makeTurnInput())).rejects.toThrow(
      "still dead",
    );
    expect(dyingSendTurn).toHaveBeenCalledTimes(2);
  });

  it("normalizes a clear-disposition result that still carries a backendRef", async () => {
    const runtime = makeRuntime({
      async sendTurn() {
        return makeTurnResult({
          backendRef: { backend: "claude", ref: "stale-ref" },
          continuationDisposition: "clear",
        });
      },
    });

    const wrapped = withRuntimeReplacementRetry({
      getRuntime: () => runtime,
      replaceRuntime: async () => runtime,
      classify: stubClassify(),
      signal: new AbortController().signal,
      meta: META,
    });

    const result = await wrapped.sendTurn(makeTurnInput());
    expect(result.continuationDisposition).toBe("clear");
    expect(result.backendRef).toBeNull();
  });

  it("delegates identity members to the live runtime across replacement", async () => {
    const first = makeRuntime({ modelId: "opus" });
    const second = makeRuntime({ modelId: "sonnet" });
    let current = first;

    const wrapped = withRuntimeReplacementRetry({
      getRuntime: () => current,
      replaceRuntime: async () => current,
      classify: stubClassify(),
      signal: new AbortController().signal,
      meta: META,
    });

    expect(wrapped.modelId).toBe("opus");
    current = second;
    expect(wrapped.modelId).toBe("sonnet");
    expect(wrapped.backend).toBe("claude");
  });
});
