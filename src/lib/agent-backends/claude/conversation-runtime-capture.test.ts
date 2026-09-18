import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeConversationBackendFactory } from "./conversation-runtime";
import { _setSdkQueryForTesting } from "./query-session";
import { createFakeClaudeSdkController } from "../testing/fake-claude-sdk-port";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import { CHECKPOINT_CAPTURE_LIMITS } from "@/lib/conversation-checkpoints/budget";
import type { ConversationBackendCreateInput } from "../conversation";

const input: ConversationBackendCreateInput = {
  projectPath: process.cwd(),
  executionClass: "ordinary-conversation",
  conversationId: "capture-test",
  projectName: "test",
  worktreePath: process.cwd(),
  conversationTarget: sessionConversationTarget(
    "test",
    "session",
    "capture-test",
  ),
  modelSelection: { modelId: "sonnet", parameters: { effort: "high" } },
  persistedRef: { backend: "claude", ref: "source-session" },
  sessionInstructions: [],
  tooling: {},
};
afterEach(() => _setSdkQueryForTesting(null));

describe("Claude capture preparation through registered factory", () => {
  it("starts dormant capture with restricted settings and exact continuity", async () => {
    const sdk = createFakeClaudeSdkController();
    _setSdkQueryForTesting(sdk.createSdkQuery);
    const runtime = await claudeConversationBackendFactory.createRuntime({
      ...input,
      initialPurpose: {
        kind: "checkpoint_handoff",
        captureId: "capture",
        mode: "tool-disabled",
      },
    });
    try {
      expect(sdk.lastOptions).toMatchObject({
        resume: "source-session",
        model: "sonnet",
        tools: [],
        mcpServers: {},
        plugins: [],
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: "dontAsk",
        settings: {
          disableAllHooks: true,
          autoMemoryEnabled: false,
          autoDreamEnabled: false,
        },
      });
      expect(runtime.captureHandoff).toBeTypeOf("function");
    } finally {
      await runtime.close();
    }
  });

  it("waits for hook acknowledgement before replacing the live transport", async () => {
    const sdk = createFakeClaudeSdkController();
    const ack = Promise.withResolvers<void>();
    const events: string[] = [];
    _setSdkQueryForTesting((args) => {
      events.push(args.options.tools ? "capture-created" : "ordinary-created");
      const port = args.options.tools
        ? scriptedCaptureSdk((user, emit) => {
            emit(captureInit());
            emit(captureResult(user.uuid));
          })(args)
        : sdk.createSdkQuery(args);
      if (args.options.tools)
        expect(args.options).toMatchObject({
          resume: "source-session",
          tools: [],
          maxTurns: 1,
        });
      return {
        ...port,
        async awaitChildCollection() {
          await port.awaitChildCollection?.();
        },
        close() {
          events.push("closed");
          port.close();
        },
        async applyFlagSettings(settings) {
          expect(settings).toEqual({ disableAllHooks: true });
          events.push("suppress");
          await ack.promise;
          events.push("ack");
        },
      };
    });
    const runtime = await claudeConversationBackendFactory.createRuntime(input);
    const capture = runtime.captureHandoff?.({
      captureId: "capture",
      mode: "tool-disabled",
      promptText: "Record working state only.",
      outputSchema: { type: "object" },
      limits: CHECKPOINT_CAPTURE_LIMITS,
      signal: new AbortController().signal,
      async onTranscript() {},
    });
    expect(events).toEqual(["ordinary-created", "suppress"]);
    ack.resolve();
    await capture;
    expect(events.slice(0, 5)).toEqual([
      "ordinary-created",
      "suppress",
      "ack",
      "closed",
      "capture-created",
    ]);
    await runtime.close();
  });

  it("omits capture when restricted transport creation fails without downgrading", async () => {
    const sdk = createFakeClaudeSdkController();
    let launches = 0;
    _setSdkQueryForTesting((args) => {
      launches++;
      if (args.options.tools) throw new Error("capture setup failed");
      return { ...sdk.createSdkQuery(args), async awaitChildCollection() {} };
    });
    const runtime = await claudeConversationBackendFactory.createRuntime(input);
    await expect(
      runtime.captureHandoff?.({
        captureId: "capture",
        mode: "tool-disabled",
        promptText: "Record working state only.",
        outputSchema: { type: "object" },
        limits: CHECKPOINT_CAPTURE_LIMITS,
        signal: new AbortController().signal,
        async onTranscript() {},
      }),
    ).resolves.toMatchObject({
      modeEstablished: false,
      submitted: false,
      omissionReason: "mode_establishment_failed",
      continuation: { nextRuntime: "recreate_from_ref" },
    });
    expect(launches).toBe(2);
    await runtime.close();
  });

  it.each(["rejected"])(
    "leaves the original Query open when hook suppression ACK is %s",
    async (ack) => {
      const sdk = createFakeClaudeSdkController();
      const close = vi.fn();
      _setSdkQueryForTesting((args) => {
        const port = sdk.createSdkQuery(args);
        return {
          ...port,
          close() {
            close();
            port.close();
          },
          async applyFlagSettings() {
            if (ack === "missing") await new Promise<void>(() => {});
            throw new Error("controls_unavailable");
          },
        };
      });
      const runtime =
        await claudeConversationBackendFactory.createRuntime(input);
      try {
        expect(runtime.captureHandoff).toBeTypeOf("function");
        const result = await runtime.captureHandoff?.({
          captureId: "capture",
          mode: "tool-disabled",
          promptText: "Record working state only.",
          outputSchema: { type: "object" },
          limits: { ...CHECKPOINT_CAPTURE_LIMITS, executionMs: 20 },
          signal: new AbortController().signal,
          async onTranscript() {},
        });
        expect(result).toMatchObject({
          submitted: false,
          modeEstablished: false,
          omissionReason: "mode_establishment_failed",
          continuation: { nextRuntime: "current" },
        });
        expect(close).not.toHaveBeenCalled();
        expect(runtime.status).toBe("alive");
      } finally {
        await runtime.close();
      }
    },
  );
});

import {
  captureInit,
  captureResult,
  scriptedCaptureSdk,
} from "./capture-test-support";

async function runScriptedCapture(
  script: Parameters<typeof scriptedCaptureSdk>[0],
  executionMs = 1000,
) {
  _setSdkQueryForTesting(scriptedCaptureSdk(script));
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  const result = await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: { ...CHECKPOINT_CAPTURE_LIMITS, executionMs },
    signal: new AbortController().signal,
    async onTranscript() {},
  });
  await runtime.close();
  return result;
}

describe("Claude correlated bounded capture", () => {
  it("submits one UUID input before inventory and ignores unrelated zero-turn notices", async () => {
    let submissions = 0;
    let uuid: string | undefined;
    const result = await runScriptedCapture((user, emit) => {
      submissions++;
      uuid = user.uuid;
      emit(captureResult("unrelated", "task stopped", 0));
      emit(captureInit());
      emit(captureResult(user.uuid));
    });
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(submissions).toBe(1);
    expect(result?.correlatedCompletion).toBe(true);
  });
  it("omits mismatched inventory even when followed by a correlated success", async () => {
    const result = await runScriptedCapture((user, emit) => {
      emit(captureInit(["Bash"]));
      emit(captureResult(user.uuid));
    });
    expect(result).toMatchObject({
      modeEstablished: false,
      omissionReason: "mode_establishment_failed",
    });
  });
  it("rejects answer overflow", async () => {
    const result = await runScriptedCapture((user, emit) => {
      emit(captureInit());
      emit(
        captureResult(
          user.uuid,
          "x".repeat(CHECKPOINT_CAPTURE_LIMITS.outputBytes + 1),
        ),
      );
    });
    expect(result?.omissionReason).toBe("output_limit");
  });
  it("bounds a capture with no timely correlated completion", async () => {
    const result = await runScriptedCapture((user, emit) => {
      emit(captureInit());
      setTimeout(() => emit(captureResult(user.uuid)), 80);
    }, 20);
    expect(result?.omissionReason).toBe("execution_limit");
  });
});

import {
  captureAssistant,
  captureDelta,
  captureMaxTokens,
} from "./capture-test-support";
import { randomUUID } from "node:crypto";

it("interrupts immediately on streamed native max_tokens instead of accepting recovery output", async () => {
  const result = await runScriptedCapture((user, emit) => {
    emit(captureInit());
    emit(captureMaxTokens());
    emit(captureResult(user.uuid));
  });
  expect(result?.omissionReason).toBe("output_limit");
  expect(result?.correlatedCompletion).toBe(false);
});
it("deduplicates streamed fragments and final assistant/result representations", async () => {
  const text = "x".repeat(4000);
  const result = await runScriptedCapture((user, emit) => {
    emit(captureInit());
    emit({
      type: "stream_event",
      uuid: randomUUID(),
      session_id: "source-session",
      parent_tool_use_id: null,
      event: { type: "message_start", message: captureAssistant("").message },
    });
    const fragment = captureDelta(text);
    emit(fragment);
    emit(fragment);
    const assistant = captureAssistant(text);
    emit(assistant);
    emit(assistant);
    emit(captureResult(user.uuid, text));
  });
  expect(result?.correlatedCompletion).toBe(true);
  expect(result?.omissionReason).not.toBe("output_limit");
});
it("counts distinct assistant messages against the combined answer budget", async () => {
  const result = await runScriptedCapture((user, emit) => {
    emit(captureInit());
    emit(captureAssistant("x".repeat(4000), "message-1"));
    emit(captureAssistant("x".repeat(4000), "message-2"));
    emit(captureResult(user.uuid));
  });
  expect(result?.omissionReason).toBe("output_limit");
});

it("does not publish the candidate until the owned child is collected", async () => {
  const child = Promise.withResolvers<void>();
  _setSdkQueryForTesting(
    scriptedCaptureSdk(
      (user, emit) => {
        emit(captureInit());
        emit(captureResult(user.uuid));
      },
      { childCompletion: child.promise },
    ),
  );
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  let finished = false;
  const capture = runtime
    .captureHandoff?.({
      captureId: "capture",
      mode: "tool-disabled",
      promptText: "Record working state only.",
      outputSchema: { type: "object" },
      limits: CHECKPOINT_CAPTURE_LIMITS,
      signal: new AbortController().signal,
      async onTranscript() {},
    })
    .then((result) => {
      finished = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(finished).toBe(false);
  child.resolve();
  expect(await capture).toMatchObject({
    candidateText: "{}",
    executionSettled: true,
    cleanupFailure: null,
    continuation: {
      nextRuntime: "recreate_from_ref",
      backendRef: input.persistedRef,
    },
  });
  await runtime.close();
});

it("collects an actual child exposed by the supported SDK spawn callback", async () => {
  let childExited = false;
  _setSdkQueryForTesting((args) => {
    const spawnChild = args.options.spawnClaudeCodeProcess;
    if (!spawnChild) throw new Error("Missing supported spawn observer");
    const child = spawnChild({
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      cwd: process.cwd(),
      env: process.env,
      signal: new AbortController().signal,
    });
    child.on("exit", () => {
      childExited = true;
    });
    const port = scriptedCaptureSdk((user, emit) => {
      emit(captureInit());
      emit(captureResult(user.uuid));
    })(args);
    return {
      ...port,
      close() {
        port.close();
        child.stdin.end();
      },
    };
  });
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  const result = await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: new AbortController().signal,
    async onTranscript() {},
  });
  expect(result).toMatchObject({
    executionSettled: true,
    candidateText: "{}",
    cleanupFailure: null,
  });
  expect(childExited).toBe(true);
  await runtime.close();
});

it("keeps an uncollected child owned so a later close still awaits it", async () => {
  const child = Promise.withResolvers<void>();
  _setSdkQueryForTesting(
    scriptedCaptureSdk(
      (user, emit) => {
        emit(captureInit());
        emit(captureResult(user.uuid));
      },
      { childCompletion: child.promise },
    ),
  );
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  const result = await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: { ...CHECKPOINT_CAPTURE_LIMITS, settlementMs: 20 },
    signal: new AbortController().signal,
    async onTranscript() {},
  });
  expect(result).toMatchObject({
    executionSettled: false,
    candidateText: null,
    cleanupFailure: { code: "cleanup_unverified" },
  });
  await expect(runtime.close()).rejects.toThrow();
  child.resolve();
  await expect(runtime.close()).resolves.toBeUndefined();
});

it("cancels capture with a resumable ref and reconstructs ordinary tools in a new runtime", async () => {
  const abort = new AbortController();
  _setSdkQueryForTesting(
    scriptedCaptureSdk((_user, emit) => {
      emit(captureInit());
      abort.abort();
    }),
  );
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  const result = await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: abort.signal,
    async onTranscript() {},
  });
  expect(result).toMatchObject({
    executionSettled: true,
    omissionReason: "cancelled",
    continuation: {
      disposition: "retain",
      backendRef: input.persistedRef,
      nextRuntime: "recreate_from_ref",
    },
    usage: {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      costBasis: null,
    },
  });
  const ordinary = createFakeClaudeSdkController();
  _setSdkQueryForTesting(ordinary.createSdkQuery);
  const restored = await claudeConversationBackendFactory.createRuntime({
    ...input,
    persistedRef: result?.continuation.backendRef ?? null,
  });
  expect(ordinary.lastOptions).toMatchObject({
    resume: "source-session",
    permissionMode: "bypassPermissions",
    settingSources: ["user", "project", "local"],
  });
  expect(ordinary.lastOptions?.tools).toBeUndefined();
  expect(ordinary.lastOptions?.settings).not.toMatchObject({
    disableAllHooks: true,
  });
  await restored.close();
  await runtime.close();
});

it("returns capture-only terminal usage with a successful correlated response", async () => {
  const result = await runScriptedCapture((user, emit) => {
    emit(captureInit());
    emit(captureResult(user.uuid));
  });
  expect(result).toMatchObject({
    usage: {
      inputTokens: 1000,
      outputTokens: 50,
      cachedInputTokens: 200,
      costUsd: 0.01,
      costBasis: "provider_reported",
    },
  });
});

it("clears provider-confirmed stale continuity after settled capture failure", async () => {
  const result = await runScriptedCapture((user, emit) => {
    emit(captureInit());
    emit({
      ...captureResult(user.uuid),
      subtype: "error_during_execution" as const,
      is_error: true,
      errors: ["session source-session not found"],
    });
  });
  expect(result).toMatchObject({
    candidateText: null,
    executionSettled: true,
    omissionReason: "continuity_unavailable",
    continuation: {
      disposition: "clear",
      backendRef: null,
      nextRuntime: "unavailable",
    },
  });
});

it("keeps cancellation counters unavailable without a terminal provider result", async () => {
  const result = await runScriptedCapture((_user, emit) => {
    emit(captureInit());
  }, 20);
  expect(result).toMatchObject({
    executionSettled: true,
    omissionReason: "execution_limit",
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
      costBasis: null,
    },
  });
});

it("does not create capture until the suppressed original child's collection settles", async () => {
  const oldChild = Promise.withResolvers<void>();
  let captures = 0;
  _setSdkQueryForTesting((args) => {
    if (args.options.tools) captures++;
    return scriptedCaptureSdk(
      (user, emit) => {
        emit(captureInit());
        emit(captureResult(user.uuid));
      },
      args.options.tools ? undefined : { childCompletion: oldChild.promise },
    )(args);
  });
  const runtime = await claudeConversationBackendFactory.createRuntime(input);
  const capture = runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: new AbortController().signal,
    async onTranscript() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(captures).toBe(0);
  oldChild.resolve();
  expect(await capture).toMatchObject({
    executionSettled: true,
    candidateText: "{}",
  });
  expect(captures).toBe(1);
  await runtime.close();
});

it("retains a pending required audit after child collection until a later close can verify it", async () => {
  const audit = Promise.withResolvers<void>();
  _setSdkQueryForTesting(
    scriptedCaptureSdk((user, emit) => {
      emit(captureInit());
      emit(captureResult(user.uuid));
    }),
  );
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  const result = await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: { ...CHECKPOINT_CAPTURE_LIMITS, executionMs: 20, settlementMs: 20 },
    signal: new AbortController().signal,
    async onTranscript() {
      await audit.promise;
    },
  });
  expect(result).toMatchObject({
    candidateText: null,
    executionSettled: false,
    submitted: false,
  });
  await expect(runtime.close()).rejects.toThrow();
  audit.resolve();
  await expect(runtime.close()).resolves.toBeUndefined();
});

it("preserves positive provider cost and model counters on a failed terminal capture", async () => {
  const result = await runScriptedCapture((user, emit) => {
    emit(captureInit());
    emit({
      ...captureResult(user.uuid),
      subtype: "error_max_budget_usd" as const,
      is_error: true,
      errors: [],
      usage: {
        ...captureResult(user.uuid).usage,
        input_tokens: 0,
        output_tokens: 0,
      },
    });
  });
  expect(result).toMatchObject({
    candidateText: null,
    omissionReason: "capture_failed",
    usage: {
      costUsd: 0.01,
      costBasis: "provider_reported",
      inputTokens: 1000,
      outputTokens: 50,
    },
  });
});

it("aborts the SDK request controller immediately at native max_tokens", async () => {
  let signal: AbortSignal | undefined;
  _setSdkQueryForTesting((args) => {
    signal = args.options.abortController?.signal;
    return scriptedCaptureSdk((_user, emit) => {
      emit(captureInit());
      emit(captureMaxTokens());
    })(args);
  });
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: new AbortController().signal,
    async onTranscript() {},
  });
  expect(signal?.aborted).toBe(true);
  await runtime.close();
});

it("retires dormant restricted startup when capture is cancelled before submission", async () => {
  const abort = new AbortController();
  abort.abort();
  let submissions = 0;
  _setSdkQueryForTesting(
    scriptedCaptureSdk(() => {
      submissions++;
    }),
  );
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  const result = await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: abort.signal,
    async onTranscript() {},
  });
  expect(result).toMatchObject({
    submitted: false,
    executionSettled: true,
    omissionReason: "cancelled",
    continuation: { nextRuntime: "recreate_from_ref" },
  });
  expect(runtime.status).toBe("dead");
  expect(submissions).toBe(0);
  await runtime.close();
});

it("observes prohibited activity buffered after the correlated result through pump shutdown", async () => {
  _setSdkQueryForTesting(
    scriptedCaptureSdk(
      (user, emit) => {
        emit(captureInit());
        emit(captureResult(user.uuid));
        const assistant = captureAssistant("");
        assistant.message.content = [
          {
            type: "tool_use",
            id: "late-tool",
            name: "Bash",
            input: { command: "echo late" },
            caller: { type: "direct" },
          },
        ];
        emit(assistant);
      },
      { drainOnClose: true },
    ),
  );
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  const result = await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: new AbortController().signal,
    async onTranscript() {},
  });
  expect(result).toMatchObject({
    candidateText: null,
    omissionReason: "prohibited_activity",
    activity: { prohibited: "observed" },
  });
  await runtime.close();
});

it("recreates ordinary settings when cancellation follows an acknowledged hook change", async () => {
  const abort = new AbortController();
  _setSdkQueryForTesting(scriptedCaptureSdk(() => {}));
  const runtime = await claudeConversationBackendFactory.createRuntime(input);
  const capture = runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record working state only.",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: abort.signal,
    async onTranscript() {},
  });
  abort.abort();
  expect(await capture).toMatchObject({
    submitted: false,
    omissionReason: "cancelled",
    executionSettled: true,
    continuation: { nextRuntime: "recreate_from_ref" },
  });
  await runtime.close();
});

it.each(["deadline", "cancellation", "early-close"])(
  "retains pending hook control after %s until acknowledged collection",
  async (reason) => {
    const ack = Promise.withResolvers<void>();
    const close = vi.fn();
    _setSdkQueryForTesting((args) => {
      const port = scriptedCaptureSdk(() => {})(args);
      return {
        ...port,
        applyFlagSettings: () => ack.promise,
        close() {
          close();
          port.close();
        },
      };
    });
    const runtime = await claudeConversationBackendFactory.createRuntime(input);
    const abort = new AbortController();
    const capture = runtime.captureHandoff?.({
      captureId: "capture",
      mode: "tool-disabled",
      promptText: "Record state only.",
      outputSchema: { type: "object" },
      limits: {
        ...CHECKPOINT_CAPTURE_LIMITS,
        executionMs: reason === "early-close" ? 100 : 20,
        settlementMs: 20,
      },
      signal: abort.signal,
      async onTranscript() {},
    });
    if (reason === "cancellation") abort.abort();
    if (reason === "early-close") {
      await expect(runtime.close()).rejects.toThrow();
      expect(close).not.toHaveBeenCalled();
    }
    try {
      expect(await capture).toMatchObject({
        executionSettled: false,
        cleanupFailure: { code: "cleanup_unverified" },
        continuation: { nextRuntime: "recreate_from_ref" },
      });
      await expect(
        runtime.sendTurn({
          promptText: "Ordinary work",
          imageRefs: [],
          sessionInstructions: [],
          autonomous: false,
          modelSelection: input.modelSelection,
          signal: new AbortController().signal,
          onEvent() {},
        }),
      ).rejects.toThrow("capture binding");
      await expect(runtime.close()).rejects.toThrow();
      expect(close).not.toHaveBeenCalled();
    } finally {
      ack.resolve();
      await runtime.close();
    }
    expect(close).toHaveBeenCalled();
  },
);

it.each([0, 1_048_576])(
  "drains spawned stderr (%s padding bytes) and clears a stale reference on a pre-result exit",
  async (padding) => {
    _setSdkQueryForTesting((args) => {
      const spawnChild = args.options.spawnClaudeCodeProcess;
      if (!spawnChild) throw new Error("Missing spawn observer");
      const child = spawnChild({
        command: process.execPath,
        args: [
          "-e",
          `process.stderr.write('x'.repeat(${padding})); process.stderr.write(' No conversation found with session ID: source-session'); process.exitCode=1`,
        ],
        cwd: process.cwd(),
        env: process.env,
        signal: new AbortController().signal,
      });
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      const port = scriptedCaptureSdk(() => {})(args);
      return {
        ...port,
        async *[Symbol.asyncIterator]() {
          await exited;
          throw new Error("Claude Code process exited with code 1");
        },
      };
    });
    const runtime = await claudeConversationBackendFactory.createRuntime({
      ...input,
      initialPurpose: {
        kind: "checkpoint_handoff",
        captureId: "capture",
        mode: "tool-disabled",
      },
    });
    const result = await runtime.captureHandoff?.({
      captureId: "capture",
      mode: "tool-disabled",
      promptText: "Record state only.",
      outputSchema: { type: "object" },
      limits: CHECKPOINT_CAPTURE_LIMITS,
      signal: new AbortController().signal,
      async onTranscript() {},
    });
    expect(result).toMatchObject({
      executionSettled: true,
      omissionReason: "continuity_unavailable",
      continuation: {
        disposition: "clear",
        backendRef: null,
        nextRuntime: "unavailable",
      },
    });
    await runtime.close();
  },
);

it("does not close the source when concurrent cleanup observes rejected hook suppression", async () => {
  const ack = Promise.withResolvers<void>();
  const closed = vi.fn();
  _setSdkQueryForTesting((args) => {
    const port = scriptedCaptureSdk(() => {})(args);
    return {
      ...port,
      applyFlagSettings: () => ack.promise,
      close() {
        closed();
        port.close();
      },
    };
  });
  const runtime = await claudeConversationBackendFactory.createRuntime(input);
  const capture = runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record state only.",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: new AbortController().signal,
    async onTranscript() {},
  });
  const closing = runtime.close();
  ack.reject(new Error("controls_unavailable"));
  expect(await capture).toMatchObject({
    executionSettled: true,
    continuation: { nextRuntime: "current" },
  });
  await expect(closing).rejects.toThrow();
  expect(closed).not.toHaveBeenCalled();
  await runtime.close();
});

it.each(["dormant", "replacement", "ordinary", "ordinary-slow", "unsettled"])(
  "handles %s exit-before-stderr diagnostics without premature classification",
  async (purpose) => {
    let diagnosticDrain: Promise<void> = Promise.resolve();
    let nativeDrain: Promise<void> = Promise.resolve();
    let nativeDrained = false;
    _setSdkQueryForTesting((args) => {
      if (!args.options.tools && !purpose.startsWith("ordinary"))
        return scriptedCaptureSdk(() => {})(args);
      const spawnChild = args.options.spawnClaudeCodeProcess;
      if (!spawnChild) throw new Error("Missing spawn observer");
      const writer = `process.send?.('ready'); setTimeout(() => process.stderr.write('No conversation found with session ID: source-session'), ${purpose === "ordinary-slow" ? 900 : purpose === "unsettled" ? 250 : 80})`;
      const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: ['ignore', 1, 2, 'ipc'] }); child.once('message', () => process.exit(1)); child.once('error', () => process.exit(2))`;
      const child = spawnChild({
        command: process.execPath,
        args: ["-e", parent],
        cwd: process.cwd(),
        env: process.env,
        signal: new AbortController().signal,
      });
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      diagnosticDrain = exited;
      nativeDrain = new Promise<void>((resolve) =>
        child.stdout.once("end", () => {
          nativeDrained = true;
          resolve();
        }),
      );
      child.stdout.resume();
      const port = scriptedCaptureSdk(() => {})(args);
      return {
        ...port,
        async *[Symbol.asyncIterator]() {
          await exited;
          throw new Error("Claude Code process exited with code 1");
        },
      };
    });
    const runtime = await claudeConversationBackendFactory.createRuntime({
      ...input,
      ...(["dormant", "unsettled"].includes(purpose)
        ? {
            initialPurpose: {
              kind: "checkpoint_handoff" as const,
              captureId: "capture",
              mode: "tool-disabled" as const,
            },
          }
        : {}),
    });
    if (purpose === "ordinary-slow") {
      const turn = runtime.sendTurn({
        promptText: "Ordinary work",
        imageRefs: [],
        sessionInstructions: [],
        autonomous: false,
        modelSelection: input.modelSelection,
        signal: new AbortController().signal,
        onEvent() {},
      });
      await turn.catch(() => {});
      try {
        expect(nativeDrained).toBe(false);
      } finally {
        await nativeDrain;
        await runtime.close();
      }
      return;
    }
    if (purpose === "ordinary") {
      const turn = await runtime.sendTurn({
        promptText: "Ordinary work",
        imageRefs: [],
        sessionInstructions: [],
        autonomous: false,
        modelSelection: input.modelSelection,
        signal: new AbortController().signal,
        onEvent() {},
      });
      expect(turn.failure?.kind).toBe("stale_resume_ref");
      await runtime.close();
      return;
    }
    const result = await runtime.captureHandoff?.({
      captureId: "capture",
      mode: "tool-disabled",
      promptText: "Record state only.",
      outputSchema: { type: "object" },
      limits:
        purpose === "unsettled"
          ? { ...CHECKPOINT_CAPTURE_LIMITS, executionMs: 20, settlementMs: 20 }
          : CHECKPOINT_CAPTURE_LIMITS,
      signal: new AbortController().signal,
      async onTranscript() {},
    });
    if (purpose === "unsettled") {
      expect(result).toMatchObject({
        executionSettled: false,
        candidateText: null,
        cleanupFailure: { code: "cleanup_unverified" },
      });
      await expect(runtime.close()).rejects.toThrow();
      await diagnosticDrain;
      await runtime.close();
      return;
    }
    expect(result).toMatchObject({
      executionSettled: true,
      omissionReason: "continuity_unavailable",
      continuation: {
        disposition: "clear",
        backendRef: null,
        nextRuntime: "unavailable",
      },
    });
    await runtime.close();
  },
);

it.each([
  ["deadline", "execution_limit"],
  ["cancel", "cancelled"],
  ["pre-cancel", "cancelled"],
  ["output", "output_limit"],
  ["native", "output_limit"],
  ["mode", "mode_establishment_failed"],
  ["activity", "prohibited_activity"],
  ["audit", "capture_failed"],
])(
  "clears stale continuity after %s while preserving the omission reason",
  async (stop, omissionReason) => {
    const abort = new AbortController();
    _setSdkQueryForTesting((args) => {
      const spawnChild = args.options.spawnClaudeCodeProcess;
      if (!spawnChild) throw new Error("Missing spawn observer");
      const writer =
        "setTimeout(() => process.stderr.write('No conversation found with session ID: source-session'), 80)";
      const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: ['ignore', 1, 2] }); process.exit(1)`;
      const child = spawnChild({
        command: process.execPath,
        args: ["-e", parent],
        cwd: process.cwd(),
        env: process.env,
        signal: new AbortController().signal,
      });
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.stdout.resume();
      const port = scriptedCaptureSdk((_user, emit) => {
        if (stop === "cancel") {
          abort.abort();
          return;
        }
        emit(captureInit(stop === "mode" ? ["Bash"] : []));
        if (stop === "output")
          emit(
            captureAssistant(
              "x".repeat(CHECKPOINT_CAPTURE_LIMITS.outputBytes + 1),
            ),
          );
        if (stop === "native") emit(captureMaxTokens());
        if (stop === "activity") {
          const message = captureAssistant("");
          message.message.content = [
            { type: "tool_use", id: "prohibited", name: "Bash", input: {} },
          ];
          emit(message);
        }
      })(args);
      return {
        ...port,
        async *[Symbol.asyncIterator]() {
          yield* port;
          await exited;
          throw new Error("Claude Code process exited with code 1");
        },
      };
    });
    const runtime = await claudeConversationBackendFactory.createRuntime({
      ...input,
      initialPurpose: {
        kind: "checkpoint_handoff",
        captureId: "capture",
        mode: "tool-disabled",
      },
    });
    if (stop === "pre-cancel") abort.abort();
    const result = await runtime.captureHandoff?.({
      captureId: "capture",
      mode: "tool-disabled",
      promptText: "Record state only.",
      outputSchema: { type: "object" },
      limits: {
        ...CHECKPOINT_CAPTURE_LIMITS,
        executionMs: stop === "deadline" ? 20 : 1000,
        settlementMs: 1000,
      },
      signal: abort.signal,
      async onTranscript() {
        if (stop === "audit") throw new Error("Required audit failed");
      },
    });
    expect(result).toMatchObject({
      executionSettled: stop !== "audit",
      omissionReason,
      candidateText: null,
      continuation: {
        disposition: "clear",
        backendRef: null,
        nextRuntime: "unavailable",
      },
    });
    if (stop === "audit") await expect(runtime.close()).rejects.toThrow();
    else await runtime.close();
  },
);

it("uses a buffered correlated stale-session result even after a mode stop", async () => {
  _setSdkQueryForTesting(
    scriptedCaptureSdk(
      (user, emit) => {
        emit(captureInit(["Bash"]));
        emit({
          ...captureResult(
            user.uuid,
            "No conversation found with session ID: source-session",
          ),
          is_error: true,
        });
      },
      { drainOnClose: true },
    ),
  );
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  const result = await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record state only.",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: new AbortController().signal,
    async onTranscript() {},
  });
  expect(result).toMatchObject({
    executionSettled: true,
    omissionReason: "mode_establishment_failed",
    continuation: {
      disposition: "clear",
      backendRef: null,
      nextRuntime: "unavailable",
    },
  });
  await runtime.close();
});

it("keeps the returned capture outcome stable when an owned pump drains after timeout", async () => {
  const release = Promise.withResolvers<void>();
  let uuid: string | undefined;
  _setSdkQueryForTesting((args) => {
    const port = scriptedCaptureSdk((user) => {
      uuid = user.uuid;
    })(args);
    return {
      ...port,
      async *[Symbol.asyncIterator]() {
        yield captureInit();
        await release.promise;
        yield captureResult(uuid);
      },
    };
  });
  const runtime = await claudeConversationBackendFactory.createRuntime({
    ...input,
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture",
      mode: "tool-disabled",
    },
  });
  const result = await runtime.captureHandoff?.({
    captureId: "capture",
    mode: "tool-disabled",
    promptText: "Record state only.",
    outputSchema: { type: "object" },
    limits: { ...CHECKPOINT_CAPTURE_LIMITS, executionMs: 20, settlementMs: 20 },
    signal: new AbortController().signal,
    async onTranscript() {},
  });
  expect(result).toMatchObject({
    executionSettled: false,
    correlatedCompletion: false,
  });
  const snapshot = structuredClone(result);
  release.resolve();
  await runtime.close();
  expect(result).toEqual(snapshot);
});
