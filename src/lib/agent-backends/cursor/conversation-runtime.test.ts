import { describe, expect, it } from "vitest";
import { elementAt } from "@/lib/shared/testing/element-at";
import { MEMORY_ADVISORY_CONTRACT } from "@/lib/memory/advisory-contract";
import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "../conversation";
import { renderStructuredOutputInstruction } from "../structured-output-prompt";
import { turnContinuationSchema } from "../errors";
import type { PortableMcpConfig } from "../portable-mcp";
import {
  CursorConversationRuntime,
  type CursorConversationRuntimeDeps,
} from "./conversation-runtime";
import { CURSOR_BACKEND_ID } from "./backend-id";
import { translatePortableMcpToCursor } from "./mcp-translation";
import { CURSOR_DEFAULT_MODEL } from "./model-policy";
import { CURSOR_IPC_CODEC_VERSION } from "./worker/ipc";
import {
  createScriptedTransport,
  type ScriptedTransport,
  type ScriptedWorkerOptions,
} from "./testing/scripted-worker";

const CONVERSATION_ID = "conv-cursor";
const MODEL_SELECTION = {
  modelId: "claude-opus-5",
  parameters: {
    context: "1m",
    cyber: "false",
    effort: "xhigh",
    fast: "false",
    thinking: "true",
  },
} as const;

function createInput(
  overrides: Partial<ConversationBackendCreateInput> = {},
): ConversationBackendCreateInput {
  return {
    executionClass: "ordinary-conversation" as const,
    conversationId: CONVERSATION_ID,
    projectPath: "/repo",
    projectName: "repo",
    conversationTarget: {
      scope: "session",
      projectName: "repo",
      sessionName: "s1",
      conversationId: CONVERSATION_ID,
    },
    worktreePath: "/repo/.worktrees/s1",
    persistedRef: null,
    modelSelection: MODEL_SELECTION,
    sessionInstructions: [],
    tooling: {},
    ...overrides,
  };
}

interface Harness {
  runtime: CursorConversationRuntime;
  transport: ScriptedTransport;
  events: ConversationBackendEvent[];
  send(
    overrides?: Partial<ConversationBackendTurnInput>,
  ): Promise<ConversationBackendTurnResult>;
  controller: AbortController;
}

function createHarness(
  options: {
    worker?: ScriptedWorkerOptions;
    create?: Partial<ConversationBackendCreateInput>;
    deps?: Partial<CursorConversationRuntimeDeps>;
  } = {},
): Harness {
  const transport = createScriptedTransport(options.worker);
  const events: ConversationBackendEvent[] = [];
  let runCounter = 0;

  const runtime = new CursorConversationRuntime(createInput(options.create), {
    transport,
    storePath: (conversationId) => `/state/cursor/${conversationId}`,
    resolveModel: async (selection) => ({
      ok: true,
      selection,
    }),
    translatePortableMcpToCursor,
    newRunId: () => `run-${++runCounter}`,
    now: () => 1_000,
    stallTimeoutMs: 50,
    cancelSettleTimeoutMs: 50,
    ...options.deps,
  });

  const controller = new AbortController();
  return {
    runtime,
    transport,
    events,
    controller,
    send: (overrides = {}) =>
      runtime.sendTurn({
        promptText: "do the thing",
        imageRefs: [],
        sessionInstructions: [],
        modelSelection: MODEL_SELECTION,
        autonomous: false,
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
        },
        ...overrides,
      }),
  };
}

const ASSISTANT_TEXT = {
  type: "assistant",
  agent_id: "agent-1",
  run_id: "run-1",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
};

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
  const signal = Promise.withResolvers<void>();
  return { promise: signal.promise, resolve: () => signal.resolve() };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((settle) => setTimeout(settle, 1));
  }
}

// ============================================================
// Acceptance timing (D6)
// ============================================================

describe("input acceptance", () => {
  it("emits input_accepted only when the worker reports the first run-correlated event", async () => {
    const release = deferredSignal();
    const harness = createHarness({
      worker: {
        onTurn: async (turn, worker) => {
          await release.promise;
          worker.sendInputAccepted(turn.runId);
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const pending = harness.send();
    // Wait until the prompt has provably been handed to the worker: dispatch
    // has happened, acknowledgement has not.
    await waitFor(() => harness.transport.workers[0]?.turns.length === 1);
    expect(harness.events.map((e) => e.type)).not.toContain("input_accepted");

    release.resolve();
    await pending;
    expect(harness.events.map((e) => e.type)).toContain("input_accepted");
  });

  it("leaves the prompt undelivered when the worker dies before its first event", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (_turn, worker) => {
          worker.die();
        },
      },
    });

    const result = await harness.send();
    expect(harness.events.map((e) => e.type)).not.toContain("input_accepted");
    expect(result.failure?.kind).toBe("session_died");
  });
});

// ============================================================
// Eager ref persistence (D8)
// ============================================================

describe("eager ref persistence", () => {
  it("emits backend_init with the opaque ref before the turn settles", async () => {
    const orderedTypes: string[] = [];
    const harness = createHarness({
      worker: {
        onAttach: (_input, worker) => {
          worker.send({
            v: CURSOR_IPC_CODEC_VERSION,
            type: "attachResult",
            outcome: "attached",
            ref: null,
            error: null,
          });
        },
        onTurn: async (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendRefIssued("agent-mid-turn", turn.runId);
          await settleMicrotasks();
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const pending = harness.send({
      onEvent: (event) => {
        orderedTypes.push(event.type);
        harness.events.push(event);
      },
    });
    const result = await pending;

    const initIndex = orderedTypes.indexOf("backend_init");
    expect(initIndex).toBeGreaterThanOrEqual(0);
    const init = harness.events.find((e) => e.type === "backend_init");
    expect(init).toEqual({
      type: "backend_init",
      backendRef: { backend: "cursor", ref: "agent-mid-turn" },
    });
    expect(result.backendRef).toEqual({
      backend: "cursor",
      ref: "agent-mid-turn",
    });
  });

  it("resumes from the persisted ref on a runtime created with one", async () => {
    const harness = createHarness({
      create: {
        persistedRef: { backend: CURSOR_BACKEND_ID, ref: "agent-prior" },
      },
    });
    await harness.send();

    expect(
      elementAt(harness.transport.workers, 0).attachments[0],
    ).toMatchObject({
      mode: "resume",
      ref: "agent-prior",
      recoverAbandonedRun: true,
    });
  });
});

// ============================================================
// Streaming and event identity (D5, D7, D21)
// ============================================================

describe("native event streaming", () => {
  it("persists the envelope before projecting content, in arrival order", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT_TEXT);
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const result = await harness.send();
    const types = harness.events.map((e) => e.type);
    expect(types.indexOf("transcript_entry")).toBeLessThan(
      types.indexOf("content"),
    );
    expect(result.contentBlocks).toEqual([{ type: "text", text: "done" }]);
  });

  it("stamps every transcript entry with its run-scoped id", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 3, ASSISTANT_TEXT);
          worker.settle(turn.runId, "completed");
        },
      },
    });

    await harness.send();
    const entryEvent = harness.events.find(
      (e) => e.type === "transcript_entry",
    );
    expect(entryEvent).toBeDefined();
    if (entryEvent?.type !== "transcript_entry") return;
    const frame = entryEvent.entry.raw as { id?: string };
    expect(frame.id).toBe(`cursor:${CONVERSATION_ID}:run-1:3`);
  });

  it("turns a refused native payload into a bounded error without echoing content", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendRejectedEvent(turn.runId, 0, "max_bytes");
          worker.sendNativeEvent(turn.runId, 1, ASSISTANT_TEXT);
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const result = await harness.send();
    const errors = harness.events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    if (errors[0]?.type !== "error") return;
    expect(errors[0].message).toContain("max_bytes");
    // The turn still completes and later valid events still project.
    expect(result.failure).toBeNull();
    expect(result.contentBlocks).toEqual([{ type: "text", text: "done" }]);
  });
});

// ============================================================
// Terminal outcomes, usage, cost (D12, D17)
// ============================================================

describe("turn settlement", () => {
  it("reports exactly one final token usage record and never a cost", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendUsage(turn.runId, {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 5,
            cacheWriteTokens: 2,
            totalTokens: 120,
            reasoningTokens: 7,
          });
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const result = await harness.send();
    expect(result.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 120,
      reasoningTokens: 7,
    });
    expect(result.costUsd).toBeNull();
  });

  it("reports no usage when the worker never sent one", async () => {
    const harness = createHarness();
    const result = await harness.send();
    expect(result.tokenUsage).toBeNull();
    expect(result.costUsd).toBeNull();
  });

  it("resolves a cancelled turn as aborted with no fabricated failure or usage", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT_TEXT);
        },
      },
    });

    const pending = harness.send();
    await settleMicrotasks();
    harness.controller.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.tokenUsage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(elementAt(harness.transport.workers, 0).cancelledRunIds).toEqual([
      "run-1",
    ]);
  });

  it("classifies a typed SDK failure once and keeps the ref for a retryable class", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.settle(turn.runId, "failed", {
            name: "RateLimitError",
            code: "rate_limit",
            status: 429,
            message: "slow down",
          });
        },
      },
    });

    const result = await harness.send();
    expect(result.failure?.kind).toBe("quota_exhausted");
    expect(result.continuationDisposition).toBe("retain");
    expect(result.aborted).toBe(false);
    expect(
      turnContinuationSchema.safeParse({
        backendRef: result.backendRef,
        continuationDisposition: result.continuationDisposition,
      }).success,
    ).toBe(true);
  });

  it("clears the ref for a genuinely invalid session", async () => {
    const harness = createHarness({
      create: {
        persistedRef: { backend: CURSOR_BACKEND_ID, ref: "agent-gone" },
      },
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.settle(turn.runId, "failed", {
            name: "AgentNotFoundError",
            code: "agent_not_found",
            status: 404,
            message: "no such agent",
          });
        },
      },
    });

    const result = await harness.send();
    expect(result.failure?.kind).toBe("stale_resume_ref");
    expect(result.continuationDisposition).toBe("clear");
    expect(result.backendRef).toBeNull();
  });

  it("recovers a wedged persisted run once through the SDK's force-expiry send option", async () => {
    let attempt = 0;
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          attempt += 1;
          worker.sendInputAccepted(turn.runId);
          if (attempt === 1) {
            worker.settle(turn.runId, "failed", {
              name: "AgentBusyError",
              code: "agent_busy",
              status: 409,
              message: "a run is already active",
            });
            return;
          }
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const result = await harness.send();
    const dispatched = elementAt(harness.transport.workers, 0).turns;
    expect(dispatched).toHaveLength(2);
    expect(elementAt(dispatched, 0).input.forceExpirePersistedRun).toBe(false);
    expect(elementAt(dispatched, 1).input.forceExpirePersistedRun).toBe(true);
    expect(result.failure).toBeNull();
  });

  it("reports acceptance once per prompt even when the run is re-dispatched", async () => {
    let attempt = 0;
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          attempt += 1;
          // Both runs acknowledge; the prompt was still delivered once.
          worker.sendInputAccepted(turn.runId);
          if (attempt === 1) {
            worker.settle(turn.runId, "failed", {
              name: "AgentBusyError",
              code: "agent_busy",
              status: 409,
              message: "a run is already active",
            });
            return;
          }
          worker.settle(turn.runId, "completed");
        },
      },
    });

    await harness.send();
    expect(elementAt(harness.transport.workers, 0).turns).toHaveLength(2);
    expect(
      harness.events.filter((event) => event.type === "input_accepted"),
    ).toHaveLength(1);
  });

  it("does not retry a busy agent more than once", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.settle(turn.runId, "failed", {
            name: "AgentBusyError",
            code: "agent_busy",
            status: 409,
            message: "a run is already active",
          });
        },
      },
    });

    const result = await harness.send();
    expect(elementAt(harness.transport.workers, 0).turns).toHaveLength(2);
    expect(result.failure?.kind).toBe("backend_error");
    expect(result.continuationDisposition).toBe("retain");
  });

  it("settles the open turn when the worker reports a run-less fatal fault", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.send({
            v: CURSOR_IPC_CODEC_VERSION,
            type: "fatal",
            code: "ipc_protocol_error",
            message: "the worker received an undecodable frame",
          });
        },
      },
    });

    const result = await harness.send();
    expect(result.failure).not.toBeNull();
    expect(result.failure?.message).toContain("undecodable frame");
    expect(result.continuationDisposition).toBe("retain");
  });

  it("reports a bounded typed failure when the run goes silent past its bound", async () => {
    const harness = createHarness({
      deps: { stallTimeoutMs: 20 },
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
        },
      },
    });

    const result = await harness.send();
    expect(result.failure?.kind).toBe("timeout");
    expect(result.continuationDisposition).toBe("retain");
    expect(result.aborted).toBe(false);
  });
});

// ============================================================
// Model, images, structured output, queueing (D10, D15, D16)
// ============================================================

describe("turn configuration", () => {
  it("classifies a worker model-binding mismatch as a non-retryable backend failure", async () => {
    const harness = createHarness({
      worker: {
        startResult: () => ({
          kind: "binding_mismatch",
          message:
            "A Cursor worker is already active under a different model selection.",
        }),
      },
    });

    const result = await harness.send();

    expect(result.failure).toMatchObject({
      kind: "backend_error",
      retryable: false,
      message: expect.stringContaining("different model selection"),
    });
    expect(result.continuationDisposition).toBe("retain");
    expect(harness.transport.workers).toHaveLength(0);
  });

  it("passes the complete model selection through start, attach, and send", async () => {
    const harness = createHarness();

    await harness.send();

    expect(harness.transport.startInputs[0]?.modelSelection).toEqual(
      MODEL_SELECTION,
    );
    expect(
      harness.transport.workers[0]?.attachments[0]?.modelSelection,
    ).toEqual(MODEL_SELECTION);
    expect(
      harness.transport.workers[0]?.turns[0]?.input.modelSelection,
    ).toEqual(MODEL_SELECTION);
  });

  it.each([null, { backend: "cursor" as const, ref: "persisted-agent" }])(
    "refuses a filesystem policy during runtime construction for ref %j",
    (persistedRef) => {
      expect(() =>
        createHarness({
          create: {
            persistedRef,
            fsWritePolicy: { mode: "allowlist", allowWrite: [], denyWrite: [] },
          },
        }),
      ).toThrow("cannot enforce an exact filesystem write policy");
    },
  );

  it("refuses governed execution at direct runtime construction", () => {
    expect(() =>
      createHarness({ create: { executionClass: "governed-execution" } }),
    ).toThrow("not eligible for governed-execution");
  });

  it("refuses an unsupported model before starting a worker", async () => {
    const harness = createHarness({
      deps: {
        resolveModel: async () => ({
          ok: false,
          code: "model_not_supported",
          message: 'Cursor model "nope" is not in this project\'s list.',
          supportedModels: [CURSOR_DEFAULT_MODEL],
        }),
      },
    });

    const result = await harness.send({
      modelSelection: { modelId: "nope", parameters: {} },
    });
    expect(result.failure?.kind).toBe("backend_error");
    expect(harness.transport.startInputs).toHaveLength(0);
  });

  it("refuses an out-of-bounds image before starting a worker", async () => {
    const harness = createHarness();
    const result = await harness.send({
      imageRefs: [
        {
          index: 1,
          mediaType: "image/tiff",
          path: "/tmp/a.tiff",
          base64Data: "AAAA",
        },
      ],
    });

    expect(result.failure?.kind).toBe("backend_error");
    expect(result.failure?.message).not.toContain("AAAA");
    expect(harness.transport.startInputs).toHaveLength(0);
  });

  it("passes bounded images through to the worker turn", async () => {
    const harness = createHarness();
    await harness.send({
      imageRefs: [
        {
          index: 1,
          mediaType: "image/png",
          path: "/tmp/a.png",
          base64Data: "AAAA",
        },
      ],
    });

    expect(
      elementAt(elementAt(harness.transport.workers, 0).turns, 0).input.images,
    ).toEqual([{ data: "AAAA", mimeType: "image/png" }]);
  });

  it("appends the shared structured-output instruction and surfaces no native value", async () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const harness = createHarness({
      create: { outputFormat: { type: "json_schema", schema } },
    });

    const result = await harness.send();
    const dispatched = elementAt(
      elementAt(harness.transport.workers, 0).turns,
      0,
    ).input.promptText;
    expect(dispatched).toContain(renderStructuredOutputInstruction(schema));
    expect(result.structuredOutput).toBeUndefined();
  });

  // Spec `memory` R5.4/D4: the static advisory contract rides Cursor's
  // privileged channel — the first-turn governing-instructions block — and
  // the changing block — a full <memory-index> on the first turn, a
  // <memory-index-delta> on later ones — rides the prompt outside it.
  it("delivers the memory advisory contract in the first-turn governing block and keeps the per-turn index outside it", async () => {
    const harness = createHarness({
      create: { sessionInstructions: [MEMORY_ADVISORY_CONTRACT] },
    });
    const indexTurnOne = [
      "<memory-index>",
      "visibility: global + project",
      "- first-lesson [project, just now] The first turn's hook",
      "showing 1 of 1 hooks",
      "</memory-index>",
    ].join("\n");
    const indexTurnTwo = [
      "<memory-index-delta>",
      "since: 2026-09-04T00:00:00.000Z",
      "- second-lesson [project, just now] A hook written in another session",
      "</memory-index-delta>",
    ].join("\n");

    await harness.send({ promptText: `${indexTurnOne}\n\nDo the thing` });
    await harness.send({ promptText: `${indexTurnTwo}\n\nDo the next thing` });

    const dispatched = harness.transport.workers
      .flatMap((worker) => worker.turns)
      .map((turn) => turn.input.promptText);
    expect(dispatched).toHaveLength(2);
    const first = elementAt(dispatched, 0);
    const instructionsStart = first.indexOf("## System Instructions");
    const instructionsEnd = first.indexOf("\n```", instructionsStart);
    expect(instructionsStart).toBeGreaterThanOrEqual(0);
    expect(first.slice(instructionsStart, instructionsEnd)).toContain(
      MEMORY_ADVISORY_CONTRACT,
    );
    expect(first.slice(instructionsStart, instructionsEnd)).not.toContain(
      "first-lesson",
    );
    expect(
      first.indexOf("- first-lesson [project, just now]", instructionsEnd),
    ).toBeGreaterThan(instructionsEnd);

    const second = elementAt(dispatched, 1);
    expect(second).not.toContain("## System Instructions");
    expect(second).not.toContain(MEMORY_ADVISORY_CONTRACT);
    expect(second).toContain("- second-lesson [project, just now]");
  });

  it("declares next-turn queueing by exposing no live delivery method", () => {
    const harness = createHarness();
    expect(
      (harness.runtime as { queueUserInput?: unknown }).queueUserInput,
    ).toBeUndefined();
  });
});

// ============================================================
// Lifecycle (D9, D20)
// ============================================================

describe("runtime lifecycle", () => {
  it("keeps cancellation unsettled until the worker has stopped", async () => {
    const started = deferredSignal();
    const stopped = deferredSignal();
    const harness = createHarness({
      worker: {
        onTurn: () => started.resolve(),
        closeGate: () => stopped.promise,
      },
    });
    let settled = false;
    const turn = harness.send().then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    harness.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);
    stopped.resolve();
    expect((await turn).aborted).toBe(true);
    expect(elementAt(harness.transport.workers, 0).closeCount).toBe(1);
  });

  it("every concurrent close waits for the same worker teardown", async () => {
    const stopped = deferredSignal();
    const harness = createHarness({
      worker: { closeGate: () => stopped.promise },
    });
    await harness.send();
    const first = harness.runtime.close();
    let secondSettled = false;
    const second = harness.runtime.close().then(() => {
      secondSettled = true;
    });
    await settleMicrotasks();
    expect(secondSettled).toBe(false);
    stopped.resolve();
    await Promise.all([first, second]);
    expect(elementAt(harness.transport.workers, 0).closeCount).toBe(1);
  });

  it("awaits the worker's verified teardown on close", async () => {
    const harness = createHarness();
    await harness.send();
    await harness.runtime.close();

    expect(elementAt(harness.transport.workers, 0).closeCount).toBe(1);
    expect(harness.runtime.status).toBe("dead");
  });

  it("resumes the next prompt from a fresh worker after an unexpected exit", async () => {
    let turnIndex = 0;
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          turnIndex += 1;
          if (turnIndex === 1) {
            worker.sendInputAccepted(turn.runId);
            worker.sendRefIssued("agent-live", turn.runId);
            worker.die();
            return;
          }
          worker.sendInputAccepted(turn.runId);
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const first = await harness.send();
    expect(first.failure?.kind).toBe("session_died");
    expect(first.continuationDisposition).toBe("retain");
    expect(first.backendRef).toEqual({ backend: "cursor", ref: "agent-live" });

    const second = await harness.send();
    expect(second.failure).toBeNull();
    expect(harness.transport.workers).toHaveLength(2);
    expect(
      elementAt(harness.transport.workers, 1).attachments[0],
    ).toMatchObject({
      mode: "resume",
      ref: "agent-live",
    });
  });
});

// ============================================================
// Inline stdio MCP configuration (D18)
// ============================================================

const FIXTURE_MCP: PortableMcpConfig = {
  servers: [
    {
      id: "fixture",
      transport: "stdio",
      command: "node",
      args: ["fixture-server.mjs"],
      env: { FIXTURE_MARKER: "marker-1" },
    },
    { id: "disabled", transport: "stdio", command: "never", enabled: false },
  ],
};

const EXPECTED_FIXTURE_MAP = {
  fixture: {
    command: "node",
    args: ["fixture-server.mjs"],
    env: { FIXTURE_MARKER: "marker-1" },
  },
};

describe("inline MCP configuration", () => {
  it("attaches a created agent with the cascade's servers and passes them on every turn", async () => {
    const harness = createHarness({
      create: { tooling: { portableMcp: FIXTURE_MCP } },
    });

    await harness.send();
    await harness.send();

    const worker = elementAt(harness.transport.workers, 0);
    expect(worker.attachments[0]).toMatchObject({
      mode: "create",
      mcpServers: EXPECTED_FIXTURE_MAP,
    });
    expect(worker.turns.map((turn) => turn.input.mcpServers)).toEqual([
      EXPECTED_FIXTURE_MAP,
      EXPECTED_FIXTURE_MAP,
    ]);
  });

  it("never passes a server the cascade disabled", async () => {
    const harness = createHarness({
      create: { tooling: { portableMcp: FIXTURE_MCP } },
    });

    await harness.send();

    const worker = elementAt(harness.transport.workers, 0);
    expect(Object.keys(elementAt(worker.attachments, 0).mcpServers)).toEqual([
      "fixture",
    ]);
    expect(Object.keys(elementAt(worker.turns, 0).input.mcpServers)).toEqual([
      "fixture",
    ]);
  });

  it("re-passes the same map when a restarted runtime resumes the persisted ref", async () => {
    const harness = createHarness({
      create: {
        tooling: { portableMcp: FIXTURE_MCP },
        persistedRef: { backend: CURSOR_BACKEND_ID, ref: "agent-persisted" },
      },
    });

    await harness.send();

    expect(
      elementAt(harness.transport.workers, 0).attachments[0],
    ).toMatchObject({
      mode: "resume",
      ref: "agent-persisted",
      mcpServers: EXPECTED_FIXTURE_MAP,
    });
  });

  it("applies a config change to the next turn rather than the running agent", async () => {
    const harness = createHarness({
      create: { tooling: { portableMcp: FIXTURE_MCP } },
    });
    await harness.send();

    const applied = await harness.runtime.applyPortableMcpConfig({
      servers: [{ id: "replacement", transport: "stdio", command: "other" }],
    });
    expect(applied).toEqual({
      disposition: "deferred_to_next_turn",
      droppedServerIds: [],
      droppedFields: [],
      errors: {},
    });

    await harness.send();
    const worker = elementAt(harness.transport.workers, 0);
    expect(elementAt(worker.turns, 0).input.mcpServers).toEqual(
      EXPECTED_FIXTURE_MAP,
    );
    expect(elementAt(worker.turns, 1).input.mcpServers).toEqual({
      replacement: { command: "other", args: [], env: {} },
    });
  });

  it("rejects a config the inline path cannot express and keeps the previous one in force", async () => {
    const harness = createHarness({
      create: { tooling: { portableMcp: FIXTURE_MCP } },
    });
    await harness.send();

    const applied = await harness.runtime.applyPortableMcpConfig({
      servers: [
        {
          id: "remote",
          transport: "streamable-http",
          url: "https://x.test/mcp",
        },
      ],
    });
    expect(applied.disposition).toBe("rejected");
    expect(applied.droppedServerIds).toEqual(["remote"]);
    expect(applied.errors.remote).toContain("streamable-http");

    await harness.send();
    expect(
      elementAt(elementAt(harness.transport.workers, 0).turns, 1).input
        .mcpServers,
    ).toEqual(EXPECTED_FIXTURE_MAP);
  });

  it("refuses to stage a config once the runtime is closed", async () => {
    const harness = createHarness();
    await harness.runtime.close();

    const applied = await harness.runtime.applyPortableMcpConfig({
      servers: [{ id: "late", transport: "stdio", command: "late" }],
    });

    expect(applied.disposition).toBe("rejected");
    expect(applied.errors).not.toEqual({});
  });
});

it("delivers synthetic fork history once before the first user prompt", async () => {
  const harness = createHarness();
  await harness.send({
    syntheticForkSeed: "anchored history",
    promptText: "edited prompt",
  });
  await harness.send({
    promptText: "follow-up",
  });
  const worker = elementAt(harness.transport.workers, 0);
  expect(worker.turns[0]?.input.promptText).toBe(
    "anchored history\n\nedited prompt",
  );
  expect(worker.turns[1]?.input.promptText).toBe("follow-up");
  await harness.runtime.close();
});

it("delivers an unaccepted synthetic seed to an eagerly created agent", async () => {
  const harness = createHarness({
    create: {
      persistedRef: { backend: "cursor", ref: "agent-created-before-send" },
    },
  });
  await harness.send({
    syntheticForkSeed: "anchored history",
    promptText: "retry first prompt",
  });
  expect(
    elementAt(harness.transport.workers, 0).turns[0]?.input.promptText,
  ).toBe("anchored history\n\nretry first prompt");
  await harness.runtime.close();
});

describe("Cursor capability delivery", () => {
  it("delivers the skill index once and preserves explicit agents across worker attachments", async () => {
    const snapshot = {
      catalog: "<cc-skills>CAPABILITY_INDEX</cc-skills>",
      commands: [],
      agents: { auditor: { description: "Audit", prompt: "Review carefully" } },
      delivered: false,
      capabilities: { backend: "cursor" as const, kinds: [] },
    };
    const harness = createHarness({
      deps: {
        capabilityDelivery: {
          snapshot,
          async markDelivered() {
            snapshot.delivered = true;
          },
        },
      },
    });
    await harness.send();
    await harness.send();
    const worker = elementAt(harness.transport.workers, 0);
    expect(elementAt(worker.turns, 0).input.promptText).toContain(
      "CAPABILITY_INDEX",
    );
    expect(elementAt(worker.turns, 1).input.promptText).not.toContain(
      "CAPABILITY_INDEX",
    );
    expect(snapshot.delivered).toBe(true);
    expect(worker.attachments[0]).toMatchObject({ agents: snapshot.agents });
    await harness.runtime.close();
  });
});
