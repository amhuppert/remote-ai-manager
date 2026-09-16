import { describe, it, expect, vi } from "vitest";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import { markPromptNotDelivered } from "@/lib/agent-backends/errors";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  shouldReplaceRuntimeAndRetry,
  withRuntimeReplacementRetry,
  type RuntimeReplacementRetryDeps,
} from "./with-runtime-replacement-retry";

const META = {
  conversationId: "conv-1",
  scopeRef: { scope: "session", sessionName: "sess" },
  backend: "claude",
} satisfies RuntimeReplacementRetryDeps["meta"];

const PROJECT_META = {
  conversationId: "conv-1",
  scopeRef: { scope: "project" },
  backend: "claude",
} satisfies RuntimeReplacementRetryDeps["meta"];

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
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "high" },
    },
    outputFormat: undefined,

    async sendTurn() {
      return makeTurnResult();
    },
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeTurnInput(): ConversationBackendTurnInput {
  return {
    promptText: "hi",
    imageRefs: [],
    sessionInstructions: [],
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "high" },
    },
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
  it.each([false, true])(
    "makes cleanup failure visible before facade projection (aborted: %s)",
    async (aborted) => {
      const cleanupFailure = {
        kind: "cleanup_unverified",
        message: "Commands may remain; inspect before resuming.",
      } as const;
      const raw = makeTurnResult({ aborted, costUsd: 0.25, cleanupFailure });
      const runtime = makeRuntime({ sendTurn: async () => raw });
      const completed = vi.fn();
      const replacement = vi.fn(async () => makeRuntime());
      const wrapped = withRuntimeReplacementRetry({
        getRuntime: () => runtime,
        replaceRuntime: replacement,
        classify: stubClassify(),
        signal: new AbortController().signal,
        meta: META,
        log: createCapturingLogger(),
        observe: { sending() {}, failed() {}, completed },
      });
      const result = await wrapped.sendTurn(makeTurnInput());
      expect(result).toMatchObject({
        aborted: false,
        failure: {
          kind: "backend_error",
          retryable: false,
          message: cleanupFailure.message,
        },
        cleanupFailure,
        costUsd: 0.25,
        contentBlocks: raw.contentBlocks,
        backendRef: raw.backendRef,
      });
      expect(completed).toHaveBeenCalledExactlyOnceWith(result);
      expect(replacement).not.toHaveBeenCalled();
    },
  );

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
      log: createCapturingLogger(),
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
      log: createCapturingLogger(),
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
      log: createCapturingLogger(),
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
      log: createCapturingLogger(),
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
      log: createCapturingLogger(),
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
      log: createCapturingLogger(),
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
      log: createCapturingLogger(),
    });

    const result = await wrapped.sendTurn(makeTurnInput());
    expect(result.continuationDisposition).toBe("clear");
    expect(result.backendRef).toBeNull();
  });

  // R1.3: this policy is the LAST diagnostic sink on the turn path. It is
  // handed the turn's identity as `meta` and emits it from two structured
  // events, so a `sessionName` field here reported the internal sentinel for
  // every project conversation that hit a runtime replacement or an adapter
  // continuation contradiction.
  describe("scope in structured diagnostics (R1.3)", () => {
    async function retryOnce(
      meta: RuntimeReplacementRetryDeps["meta"],
    ): Promise<ReturnType<typeof createCapturingLogger>> {
      const log = createCapturingLogger();
      const staleRuntime = makeRuntime({
        async sendTurn() {
          (staleRuntime as { status: string }).status = "dead";
          throw markPromptNotDelivered(new Error("died before delivery"));
        },
      });
      const freshRuntime = makeRuntime();
      let current = staleRuntime;

      const wrapped = withRuntimeReplacementRetry({
        getRuntime: () => current,
        replaceRuntime: async () => {
          current = freshRuntime;
          return freshRuntime;
        },
        classify: stubClassify(),
        signal: new AbortController().signal,
        meta,
        log,
      });

      await wrapped.sendTurn(makeTurnInput());
      return log;
    }

    async function contradictContinuation(
      meta: RuntimeReplacementRetryDeps["meta"],
    ): Promise<ReturnType<typeof createCapturingLogger>> {
      const log = createCapturingLogger();
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
        meta,
        log,
      });

      await wrapped.sendTurn(makeTurnInput());
      return log;
    }

    it("emits scope:project with no session identity on the retry event", async () => {
      const log = await retryOnce(PROJECT_META);

      const retry = log.entries.find(
        (e) => e.message === "prompt.runtime_retry",
      );
      expect(retry).toBeDefined();
      expect(retry?.fields).toMatchObject({ scope: "project", attempt: 1 });
      expect(retry?.fields).not.toHaveProperty("sessionName");
      expect(log.allFieldValues()).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    });

    it("emits scope:project with no session identity on the continuation contradiction", async () => {
      const log = await contradictContinuation(PROJECT_META);

      const contradiction = log.entries.find(
        (e) => e.message === "prompt.continuation_pair_contradiction",
      );
      expect(contradiction).toBeDefined();
      expect(contradiction?.fields).toMatchObject({ scope: "project" });
      expect(contradiction?.fields).not.toHaveProperty("sessionName");
      expect(log.allFieldValues()).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    });

    it("still attributes a session turn to its session on both events", async () => {
      // The fix removes the sentinel, not the diagnostic.
      const retry = await retryOnce(META);
      expect(
        retry.entries.find((e) => e.message === "prompt.runtime_retry")?.fields,
      ).toMatchObject({ scope: "session", sessionName: "sess" });

      const contradiction = await contradictContinuation(META);
      expect(
        contradiction.entries.find(
          (e) => e.message === "prompt.continuation_pair_contradiction",
        )?.fields,
      ).toMatchObject({ scope: "session", sessionName: "sess" });
    });
  });

  it("delegates identity members to the live runtime across replacement", async () => {
    const first = makeRuntime({
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    });
    const second = makeRuntime({
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "high" },
      },
    });
    let current = first;

    const wrapped = withRuntimeReplacementRetry({
      getRuntime: () => current,
      replaceRuntime: async () => current,
      classify: stubClassify(),
      signal: new AbortController().signal,
      meta: META,
      log: createCapturingLogger(),
    });

    expect(wrapped.modelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
    current = second;
    expect(wrapped.modelSelection).toEqual({
      modelId: "sonnet",
      parameters: { effort: "high" },
    });
    expect(wrapped.backend).toBe("claude");
  });
});
