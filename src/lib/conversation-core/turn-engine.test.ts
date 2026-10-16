import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationBackendEvent,
  ConversationBackendFactory,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
} from "@/lib/agent-backends/conversation";
import { getConversationTranscriptProjection } from "@/lib/agent-backends/conversation-policy";
import { createScriptedConversationBackend } from "@/lib/agent-backends/testing/scripted-conversation-backends";
import { makeUndeliveredPromptFailure } from "@/lib/agent-backends/testing/undelivered-prompt-fixture";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import { computeEffectiveConfigHash } from "@/lib/mcp/config-hash";
import type { ComposedTooling } from "./runtime-application-state";
import { createRuntimeHost, type HostedConversation } from "./runtime-host";
import { promptDispatchSchema } from "./schemas";
import {
  createTurnEngine,
  type TurnEngineDeps,
  type TurnRequest,
} from "./turn-engine";

vi.mock("@/lib/shared/sdk-env", () => ({}));

const silent = createCapturingLogger();
const WORKTREE = mkdtempSync(path.join(tmpdir(), "cc-turn-engine-wt-"));

function engineWith(
  factory: ConversationBackendFactory,
  timeouts = { timeoutMs: 0, stallTimeoutMs: 0 },
  overrides: Partial<TurnEngineDeps> = {},
  tooling: ComposedTooling = { overrides: { portableMcp: { servers: [] } } },
) {
  const entries: TranscriptEntry[] = [];
  const host = createRuntimeHost({
    factory: () => factory,
    instructions: async () => ({
      sessionInstructions: ["Work carefully."],
      alignmentVersion: null,
      alignmentEligible: false,
    }),
    readInstructions: async () => ({
      sessionInstructions: ["Work carefully."],
      alignmentVersion: null,
      alignmentEligible: false,
    }),
    tooling: async () => tooling,
    beginSeed: async () => ({ commit: async () => {} }),
    callbacks: () => ({}),
    index: { register: () => {}, unregister: () => {} },
    log: silent,
  });
  const engine = createTurnEngine({
    host,
    executeAgentCall,
    transcript: {
      async safeAppendTranscriptEntry(_conversationId, entry) {
        entries.push(entry);
      },
      async safeAppendTranscriptEntryOnce(_conversationId, entry) {
        if (!entries.some((existing) => existing.id === entry.id))
          entries.push(entry);
      },
    },
    projection: getConversationTranscriptProjection,
    timeouts: async () => timeouts,
    log: silent,
    ...overrides,
  });
  return { engine, entries, host };
}

function conversation(backend: "claude" | "codex"): HostedConversation {
  return {
    conversationId: "conv-1",
    projectPath: "/repo",
    projectName: "repo",
    target: sessionConversationTarget("repo", "session", "conv-1"),
    worktreePath: WORKTREE,
    backend,
    executionClass: "governed-execution",
    persistedRef: null,
  };
}

function request(
  backend: "claude" | "codex",
  overrides: Partial<TurnRequest> = {},
): TurnRequest {
  return {
    conversation: conversation(backend),
    requirements: {
      modelSelection:
        backend === "claude"
          ? { modelId: "sonnet", parameters: { effort: "medium" } }
          : {
              modelId: "gpt-5.4",
              parameters: { reasoning: "medium", fast: "false" },
            },
      instructionSelection: {
        autonomous: true,
        askUserQuestionsEnabled: false,
      },
    },
    broadcast: { projectName: "repo", storeSessionName: "session" },
    promptText: "Review the candidate.",
    userEntry: {
      timestamp: "2026-10-03T10:00:00.000Z",
      type: "user",
      role: "user",
      content: [{ type: "text", text: "Review the candidate." }],
    },
    writeCapability: "write_capable",
    autonomous: true,
    waitForBackgroundTasks: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const VERDICT = { verdict: "pass", findings: [], advisories: [] };

const DOCS_MCP: PortableMcpConfig = {
  servers: [{ id: "docs", transport: "stdio", command: "/bin/true" }],
};
const DELIVERED: Record<"claude" | "codex", ResolvedCapabilityCascade> = {
  claude: {
    backend: "claude",
    kinds: [
      {
        kind: "skills",
        items: [
          { itemId: "review", enabled: false, originLayer: "conversation" },
        ],
      },
    ],
  },
  codex: {
    backend: "codex",
    kinds: [
      {
        kind: "plugins",
        items: [
          { itemId: "tools", enabled: false, originLayer: "conversation" },
        ],
      },
    ],
  },
};
type InputAccepted = Extract<
  ConversationBackendEvent,
  { type: "input_accepted" }
>;

describe("core turn engine", () => {
  it("records the dispatched work, format and repair prompts without adding user messages", async () => {
    const { engine, entries } = engineWith(
      completingFactory({
        responses: ["The review passed.", "{}", JSON.stringify(VERDICT)],
      }),
    );
    const outcome = await engine.runTurn(
      request("claude", {
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            required: ["verdict"],
            properties: { verdict: { type: "string" } },
          },
        },
      }),
    );

    expect(outcome.kind).toBe("call_result");
    const dispatches = entries.filter(
      (entry) => entry.type === "prompt_dispatch",
    );
    expect(dispatches.map((entry) => entry.promptDispatch)).toEqual([
      expect.objectContaining({
        phase: "work",
        promptText: expect.stringContaining(
          "Answer in prose, do not emit JSON",
        ),
        outputSchema: null,
      }),
      expect.objectContaining({
        phase: "format",
        promptText: expect.stringContaining("Convert your previous response"),
      }),
      expect.objectContaining({
        phase: "repair",
        promptText: expect.stringContaining("Validation issues:"),
      }),
    ]);
    expect(dispatches.every((entry) => entry.role === undefined)).toBe(true);
    expect(entries.filter((entry) => entry.role === "user")).toEqual([
      request("claude").userEntry,
    ]);
  });

  it.each(["claude", "codex"] as const)(
    "runs a %s turn through the real adapter, recording the user turn first and returning structured output",
    async (backend) => {
      const provider = createScriptedConversationBackend({
        backend,
        responseText: JSON.stringify(VERDICT),
      });
      const { engine, entries } = engineWith(provider.factory);
      const outcome = await engine.runTurn(
        request(backend, {
          outputFormat: {
            type: "json_schema",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["verdict", "findings", "advisories"],
              properties: {
                verdict: { type: "string" },
                findings: { type: "array", items: { type: "object" } },
                advisories: { type: "array", items: { type: "object" } },
              },
            },
          },
          structuredOutputTurns: "work_then_format",
        }),
      );

      expect(outcome.kind).toBe("call_result");
      if (outcome.kind !== "call_result") throw new Error("unreachable");
      expect(outcome.result.outcome).toMatchObject({
        kind: "completed",
        structuredOutput: VERDICT,
      });
      expect(entries[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "Review the candidate." }],
      });
      expect(provider.turns[0]?.prompt).toContain("Review the candidate.");
      const dispatches = entries
        .filter((entry) => entry.type === "prompt_dispatch")
        .map((entry) => promptDispatchSchema.parse(entry.promptDispatch));
      expect(dispatches.map((dispatch) => dispatch.phase)).toEqual([
        "work",
        "format",
      ]);
      expect(dispatches.map((dispatch) => dispatch.promptText)).toEqual(
        provider.turns.map((turn) => turn.prompt),
      );
    },
  );

  it.each(["claude", "codex"] as const)(
    "records the configuration a %s runtime accepted the input under: its MCP config and delivered capabilities",
    async (backend) => {
      const provider = createScriptedConversationBackend({
        backend,
        responseText: JSON.stringify(VERDICT),
      });
      const receipts: Array<{ conversationId: string; event: InputAccepted }> =
        [];
      const { engine } = engineWith(
        provider.factory,
        undefined,
        {
          async recordAccepted(hosted, event) {
            receipts.push({ conversationId: hosted.conversationId, event });
          },
        },
        {
          overrides: {
            portableMcp: DOCS_MCP,
            capabilities: DELIVERED[backend],
          },
        },
      );
      const outcome = await engine.runTurn(request(backend));

      expect(outcome).toMatchObject({
        kind: "call_result",
        result: { outcome: { kind: "completed" } },
      });
      expect(receipts).toEqual([
        {
          conversationId: "conv-1",
          event: expect.objectContaining({
            type: "input_accepted",
            mcpConfigHash: computeEffectiveConfigHash(DOCS_MCP),
            capabilities: DELIVERED[backend],
          }),
        },
      ]);
    },
  );

  it("completes a turn whose configuration receipt cannot be recorded, and reports the failure", async () => {
    const provider = createScriptedConversationBackend({
      backend: "claude",
      responseText: JSON.stringify(VERDICT),
    });
    const log = createCapturingLogger();
    const { engine } = engineWith(provider.factory, undefined, {
      async recordAccepted() {
        throw new Error("database is locked");
      },
      log,
    });
    const outcome = await engine.runTurn(request("claude"));

    expect(outcome).toMatchObject({
      kind: "call_result",
      result: { outcome: { kind: "completed" } },
    });
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "conversation_core.application_receipt_failed",
        fields: expect.objectContaining({
          conversationId: "conv-1",
          error: "database is locked",
        }),
      }),
    );
  });

  it("times out a turn that never answers and reports the interruption", async () => {
    const hanging = hangingFactory();
    const { engine, entries } = engineWith(hanging.factory, {
      timeoutMs: 20,
      stallTimeoutMs: 0,
    });
    const outcome = await engine.runTurn(request("claude"));

    expect(outcome.interruption).toEqual({ reason: "timeout", timeoutMs: 20 });
    expect(hanging.sawAbort()).toBe(true);
    expect(
      entries.filter((e) => e.role !== undefined).map((e) => e.role),
    ).toEqual(["user"]);
  });

  it("keeps a turn whose runtime reports background progress from being taken for stalled", async () => {
    const quiet = hangingFactory();
    const { engine } = engineWith(quiet.factory, {
      timeoutMs: 0,
      stallTimeoutMs: 40,
    });
    const controller = new AbortController();
    const pending = engine.runTurn(
      request("claude", { signal: controller.signal }),
    );
    // A background task's progress, which reaches the runtime outside the turn's event stream.
    const progress = setInterval(() => engine.notifyActivity("conv-1"), 10);
    await new Promise((resolve) => setTimeout(resolve, 120));
    clearInterval(progress);
    expect(quiet.sawAbort()).toBe(false);
    controller.abort();
    expect((await pending).interruption?.reason).toBe("user");
  });

  it("stops a turn when its caller cancels it", async () => {
    const hanging = hangingFactory();
    const { engine } = engineWith(hanging.factory);
    const controller = new AbortController();
    const pending = engine.runTurn(
      request("claude", { signal: controller.signal }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const outcome = await pending;

    expect(hanging.sawAbort()).toBe(true);
    expect(outcome.interruption?.reason).toBe("user");
  });

  it("hands the backend's announced continuation to the caller as soon as it arrives", async () => {
    const announced: string[] = [];
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input) {
        const runtime: ConversationBackendRuntime = {
          backend: "claude",
          status: "alive",
          modelSelection: input.modelSelection,
          async sendTurn(turn: ConversationBackendTurnInput) {
            await turn.onEvent?.({
              type: "backend_init",
              backendRef: { backend: "claude", ref: "sdk-early" },
            });
            expect(announced).toEqual(["sdk-early"]);
            return {
              backendRef: { backend: "claude", ref: "sdk-early" },
              costUsd: null,
              durationMs: null,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [],
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
          async close() {},
        };
        return runtime;
      },
    };
    const { engine } = engineWith(factory);
    await engine.runTurn(
      request("claude", {
        async onBackendInit(ref) {
          announced.push(ref.ref);
        },
      }),
    );
    expect(announced).toEqual(["sdk-early"]);
  });

  it("keeps a finished turn when resetting memory delivery after compaction fails", async () => {
    const { engine } = engineWith(
      completingFactory({ compacted: true }),
      undefined,
      {
        async onCompacted() {
          throw new Error("telemetry store unavailable");
        },
      },
    );
    const outcome = await engine.runTurn(request("claude"));
    expect(outcome).toMatchObject({
      kind: "call_result",
      result: { outcome: { kind: "completed" } },
    });
  });

  it("reports a turn whose timeouts cannot be read as not started, sending nothing", async () => {
    const deaf = deafFactory();
    const { engine } = engineWith(deaf.factory, undefined, {
      async timeouts() {
        throw new Error("config unreadable");
      },
    });
    expect(await engine.runTurn(request("claude"))).toMatchObject({
      kind: "not_started",
      reason: "configuration",
    });
    expect(deaf.sent()).toBe(0);
  });

  it("blocks a conversation whose turn could not verify its child processes stopped, and reports it", async () => {
    const unverified: string[] = [];
    const factory = completingFactory({
      cleanupFailure: "tool child processes may still be running",
    });
    const { engine, host } = engineWith(factory, undefined, {
      onCleanupUnverified(conversation, message) {
        unverified.push(`${conversation.conversationId}: ${message}`);
      },
    });
    await engine.runTurn(request("claude"));

    expect(unverified).toEqual([
      "conv-1: tool child processes may still be running",
    ]);
    await expect(host.release("conv-1")).rejects.toThrow(
      /may still be running/,
    );
    await expect(
      host.obtain(conversation("claude"), request("claude").requirements),
    ).rejects.toThrow();
  });

  it("closes a runtime that ignores the abort signal, so a timed-out turn really stops", async () => {
    const deaf = deafFactory();
    const { engine } = engineWith(deaf.factory, {
      timeoutMs: 20,
      stallTimeoutMs: 0,
    });
    const outcome = await engine.runTurn(request("claude"));

    expect(deaf.closed()).toBe(true);
    expect(outcome.interruption).toEqual({ reason: "timeout", timeoutMs: 20 });
  });

  it("honours a cancellation that arrived before the turn started", async () => {
    const deaf = deafFactory();
    const { engine } = engineWith(deaf.factory);
    const controller = new AbortController();
    controller.abort();
    const outcome = await engine.runTurn(
      request("claude", { signal: controller.signal }),
    );

    expect(outcome).toMatchObject({ kind: "not_started", reason: "cancelled" });
    expect(deaf.sent()).toBe(0);
  });

  it("reports a shutdown that arrives before the turn starts as an interruption", async () => {
    const deaf = deafFactory();
    const { engine } = engineWith(deaf.factory);
    const controller = new AbortController();
    controller.abort("shutdown");
    expect(
      await engine.runTurn(request("claude", { signal: controller.signal })),
    ).toMatchObject({
      kind: "not_started",
      interruption: { reason: "shutdown" },
    });
  });

  it("reports a server shutdown as its own interruption, not a user cancellation", async () => {
    const hanging = hangingFactory();
    const { engine } = engineWith(hanging.factory);
    const controller = new AbortController();
    const pending = engine.runTurn(
      request("claude", { signal: controller.signal }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort("shutdown");

    expect((await pending).interruption?.reason).toBe("shutdown");
  });

  it("delivers the user's own text and the turn's context separately and reports the send to its observer", async () => {
    const inputs: ConversationBackendTurnInput[] = [];
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input) {
        const runtime: ConversationBackendRuntime = {
          backend: "claude",
          status: "alive",
          modelSelection: input.modelSelection,
          async sendTurn(turn: ConversationBackendTurnInput) {
            inputs.push(turn);
            return {
              backendRef: null,
              costUsd: null,
              durationMs: null,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [],
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
          async close() {},
        };
        return runtime;
      },
    };
    const sent: string[] = [];
    const { engine } = engineWith(factory);
    await engine.runTurn(
      request("claude", {
        promptText: "<memory-index>…</memory-index>\n\nFix the notice",
        userPromptText: "Fix the notice",
        promptContext: "<memory-index>…</memory-index>",
        observe: {
          sending: () => sent.push("sending"),
          failed: () => sent.push("failed"),
        },
      }),
    );

    expect(inputs[0]).toMatchObject({
      userPromptText: "Fix the notice",
      promptContext: "<memory-index>…</memory-index>",
    });
    expect(sent).toEqual(["sending"]);
  });

  it("hands the backend the turn's images, and leaves a deferred user entry to its caller", async () => {
    const inputs: ConversationBackendTurnInput[] = [];
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input) {
        const runtime: ConversationBackendRuntime = {
          backend: "claude",
          status: "alive",
          modelSelection: input.modelSelection,
          async sendTurn(turn: ConversationBackendTurnInput) {
            inputs.push(turn);
            return {
              backendRef: null,
              costUsd: null,
              durationMs: null,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [],
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
          async close() {},
        };
        return runtime;
      },
    };
    const image = {
      index: 1,
      mediaType: "image/png",
      path: "/t/images/1.png",
      base64Data: "aGk=",
    };
    const { engine, entries } = engineWith(factory);
    await engine.runTurn(
      request("claude", {
        promptText: "[Image #1] What is this?",
        imageRefs: [image],
        userEntry: null,
      }),
    );

    expect(inputs[0]?.imageRefs).toEqual([image]);
    expect(entries.filter((entry) => entry.role === "user")).toEqual([]);
  });

  it("replaces a runtime that died before the prompt reached it and sends the prompt once more", async () => {
    let creations = 0;
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input) {
        creations += 1;
        const first = creations === 1;
        let status: "alive" | "dead" = "alive";
        const runtime: ConversationBackendRuntime = {
          backend: "claude",
          get status() {
            return status;
          },
          modelSelection: input.modelSelection,
          async sendTurn(turn: ConversationBackendTurnInput) {
            if (first) {
              status = "dead";
              throw makeUndeliveredPromptFailure();
            }
            await turn.onEvent?.({
              type: "content",
              block: { type: "text", text: "Delivered." },
            });
            return {
              backendRef: { backend: "claude", ref: "sdk-2" },
              costUsd: null,
              durationMs: null,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [{ type: "text", text: "Delivered." }],
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
          async close() {
            status = "dead";
          },
        };
        return runtime;
      },
    };
    const { engine } = engineWith(factory);
    const outcome = await engine.runTurn(request("claude"));

    expect(creations).toBe(2);
    expect(outcome.kind).toBe("call_result");
    if (outcome.kind !== "call_result") throw new Error("unreachable");
    expect(outcome.result.backendRef).toEqual({
      backend: "claude",
      ref: "sdk-2",
    });
  });
});

function hangingFactory() {
  let aborted = false;
  const factory: ConversationBackendFactory = {
    backend: "claude",
    async createRuntime(input) {
      const runtime: ConversationBackendRuntime = {
        backend: "claude",
        status: "alive",
        modelSelection: input.modelSelection,
        sendTurn(turn: ConversationBackendTurnInput) {
          return new Promise((_resolve, reject) => {
            turn.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          });
        },
        async close() {},
      };
      return runtime;
    },
  };
  return { factory, sawAbort: () => aborted };
}

/** Like Claude's adapter mid-turn: ignores the abort signal; only closing the runtime ends the turn. */
function deafFactory() {
  let closed = false;
  let sent = 0;
  let reject: (error: Error) => void = () => {};
  const factory: ConversationBackendFactory = {
    backend: "claude",
    async createRuntime(input) {
      const runtime: ConversationBackendRuntime = {
        backend: "claude",
        get status() {
          return closed ? "dead" : "alive";
        },
        modelSelection: input.modelSelection,
        sendTurn() {
          sent += 1;
          return new Promise((_resolve, rejectTurn) => {
            reject = rejectTurn;
          });
        },
        async close() {
          closed = true;
          reject(new Error("runtime closed"));
        },
      };
      return runtime;
    },
  };
  return { factory, closed: () => closed, sent: () => sent };
}

function completingFactory(
  extra: {
    compacted?: boolean;
    cleanupFailure?: string;
    responses?: string[];
  } = {},
): ConversationBackendFactory {
  return {
    backend: "claude",
    async createRuntime(input) {
      let responseIndex = 0;
      const runtime: ConversationBackendRuntime = {
        backend: "claude",
        status: "alive",
        modelSelection: input.modelSelection,
        async sendTurn() {
          return {
            backendRef: { backend: "claude", ref: "sdk-1" },
            costUsd: null,
            durationMs: null,
            numTurns: 1,
            contextTokens: null,
            contextWindowMax: null,
            contentBlocks: [
              {
                type: "text",
                text: extra.responses?.[responseIndex++] ?? "Done.",
              },
            ],
            aborted: false,
            compacted: extra.compacted ?? false,
            failure: null,
            continuationDisposition: "retain",
            ...(extra.cleanupFailure !== undefined
              ? {
                  cleanupFailure: {
                    kind: "cleanup_unverified" as const,
                    message: extra.cleanupFailure,
                  },
                }
              : {}),
          };
        },
        async close() {},
      };
      return runtime;
    },
  };
}
