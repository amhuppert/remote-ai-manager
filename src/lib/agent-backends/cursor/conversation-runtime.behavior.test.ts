import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { elementAt } from "@/lib/shared/testing/element-at";
import { z } from "zod";
import type { SSEEvent } from "@/lib/api/sse-events";
import {
  _resetTranscriptDepsForTesting,
  safeAppendTranscriptEntry,
  safeAppendTranscriptEntryOnce,
  setTranscriptDeps,
  type TranscriptEntry,
} from "@/lib/prompt/transcript";
import type {
  ConversationBackgroundActivity,
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendTurnResult,
} from "../conversation";
import { conversationTranscriptFrame } from "../transcript";
import { buildStructuredOutputRepairPrompt } from "../structured-output-repair";
import { validateStructuredOutput } from "../structured-output";
import { createCursorTaskStore } from "./background-task-store";
import { applyCursorTaskEvent } from "./background-tasks";
import { CURSOR_BACKEND_ID } from "./backend-id";
import {
  CursorConversationRuntime,
  type CursorConversationRuntimeDeps,
} from "./conversation-runtime";
import { translatePortableMcpToCursor } from "./mcp-translation";
import {
  createScriptedTransport,
  type ScriptedTransport,
  type ScriptedWorkerOptions,
} from "./testing/scripted-worker";
import { CURSOR_IPC_CODEC_VERSION } from "./worker/ipc";

/**
 * Behavior suite for the Cursor conversation runtime, driven by scripted fake
 * workers through the injected transport port (spec D19).
 *
 * Where a criterion is about persistence — exactly-once, transcript integrity,
 * eager ref durability — the runtime's events are routed through the SAME
 * append path the conversation actor uses, so the assertion is about the real
 * boundary rather than about the runtime's own bookkeeping.
 */

const TEST_DIR = path.resolve(".cc/temp", `cc-cursor-behavior-${process.pid}`);
const CONVERSATION_ID = "conv-behavior";
const BROADCAST_META = { projectName: "repo", storeSessionName: "s1" };
const MODEL_SELECTION = {
  modelId: "composer-2.5",
  parameters: { fast: "true" },
} as const;

const broadcasts: SSEEvent[] = [];

beforeEach(async () => {
  broadcasts.length = 0;
  await mkdir(path.join(TEST_DIR, "transcripts"), { recursive: true });
  setTranscriptDeps({
    broadcast: (event: SSEEvent) => {
      broadcasts.push(event);
      return { delivered: true as const };
    },
    indexMarkdownDocuments: async () => {},
  });
});

afterEach(async () => {
  _resetTranscriptDepsForTesting();
  await rm(TEST_DIR, { recursive: true, force: true });
});

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

/**
 * The actor's persistence rule, reproduced exactly: an entry whose producer
 * stamped an id goes through the idempotent append; one without an id takes
 * the ordinary path. Nothing here decides anything the actor does not.
 */
async function persistBackendEvent(entry: TranscriptEntry): Promise<void> {
  if (entry.id !== undefined) {
    await safeAppendTranscriptEntryOnce(
      CONVERSATION_ID,
      { ...entry, id: entry.id },
      undefined,
      TEST_DIR,
      BROADCAST_META,
    );
    return;
  }
  await safeAppendTranscriptEntry(
    CONVERSATION_ID,
    entry,
    undefined,
    TEST_DIR,
    BROADCAST_META,
  );
}

interface PersistingHarness {
  runtime: CursorConversationRuntime;
  transport: ScriptedTransport;
  events: ConversationBackendEvent[];
  /** Ref the "machine" persisted, updated the moment backend_init arrives. */
  persistedRef: { value: string | null };
  send(overrides?: {
    promptText?: string;
  }): Promise<ConversationBackendTurnResult>;
  transcriptLines(): Promise<Record<string, unknown>[]>;
}

function createPersistingHarness(
  options: {
    worker?: ScriptedWorkerOptions;
    create?: Partial<ConversationBackendCreateInput>;
    deps?: Partial<CursorConversationRuntimeDeps>;
  } = {},
): PersistingHarness {
  const transport = createScriptedTransport(options.worker);
  const events: ConversationBackendEvent[] = [];
  const persistedRef: { value: string | null } = { value: null };
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
    persistedRef,
    send: (overrides = {}) =>
      runtime.sendTurn({
        promptText: overrides.promptText ?? "do the thing",
        imageRefs: [],
        sessionInstructions: [],
        modelSelection: MODEL_SELECTION,
        autonomous: false,
        signal: controller.signal,
        onEvent: async (event) => {
          events.push(event);
          if (event.type === "backend_init") {
            // The conversation machine's BACKEND_INIT action: assign the ref
            // and persist the snapshot, mid-turn.
            persistedRef.value = event.backendRef.ref;
          }
          if (event.type === "transcript_entry") {
            await persistBackendEvent(conversationTranscriptFrame(event.entry));
          }
        },
      }),
    async transcriptLines() {
      const filePath = path.join(
        TEST_DIR,
        "transcripts",
        `${CONVERSATION_ID}.jsonl`,
      );
      const raw = await readFile(filePath, "utf-8");
      return raw
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
  const signal = Promise.withResolvers<void>();
  return { promise: signal.promise, resolve: () => signal.resolve() };
}

const ASSISTANT = (text: string) => ({
  type: "assistant",
  agent_id: "agent-1",
  run_id: "run-1",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

// ============================================================
// Exactly-once at the persistence boundary (D21)
// ============================================================

describe("exactly-once event identity", () => {
  it("persists and broadcasts a re-delivered frame exactly once", async () => {
    const harness = createPersistingHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT("hello"));
          // The same {runId, eventIndex} arrives again — a resumed stream or a
          // retried forward. Identity, not content, has to catch it.
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT("hello"));
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const result = await harness.send();

    // 1. The durable line, deduplicated by the derived entry id.
    const lines = await harness.transcriptLines();
    const assistantLines = lines.filter((line) => line.role === "assistant");
    expect(assistantLines).toHaveLength(1);
    expect(elementAt(assistantLines, 0).id).toBe(
      `cursor:${CONVERSATION_ID}:run-1:0`,
    );

    // 2. The append-boundary broadcast.
    expect(
      broadcasts.filter((event) => event.type === "message-appended"),
    ).toHaveLength(1);

    // 3. The LIVE content stream, which never passes through the append
    //    boundary — the actor forwards every content event straight to SSE.
    expect(
      harness.events.filter((event) => event.type === "content"),
    ).toHaveLength(1);
    expect(
      harness.events.filter((event) => event.type === "transcript_entry"),
    ).toHaveLength(1);

    // 4. The turn's own answer, which a duplicate would otherwise double.
    expect(result.contentBlocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("keeps genuinely distinct events with identical content", async () => {
    const harness = createPersistingHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT("same"));
          worker.sendNativeEvent(turn.runId, 1, ASSISTANT("same"));
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const result = await harness.send();
    const lines = await harness.transcriptLines();
    expect(lines.filter((line) => line.role === "assistant")).toHaveLength(2);
    expect(result.contentBlocks).toEqual([{ type: "text", text: "samesame" }]);
  });
});

// ============================================================
// Eager ref durability (D8)
// ============================================================

describe("eager ref persistence", () => {
  it("lands the ref before the turn settles", async () => {
    const observed: { refAtSettle: string | null } = { refAtSettle: null };
    const harness = createPersistingHarness({
      worker: {
        onTurn: async (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendRefIssued("agent-eager", turn.runId);
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT("working"));
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const pending = harness.send();
    // Captured the instant the turn resolves, before any post-turn write.
    const result = await pending;
    observed.refAtSettle = harness.persistedRef.value;

    expect(observed.refAtSettle).toBe("agent-eager");
    expect(result.backendRef).toEqual({
      backend: CURSOR_BACKEND_ID,
      ref: "agent-eager",
    });
  });
});

// ============================================================
// Adversarial native input (D7)
// ============================================================

describe("malformed and oversized native input", () => {
  it.each([
    ["cyclic", "cycle" as const],
    ["oversized", "max_bytes" as const],
    ["too deep", "max_depth" as const],
  ])(
    "turns a %s payload into a bounded error and keeps the transcript readable",
    async (_label, violation) => {
      const harness = createPersistingHarness({
        worker: {
          onTurn: (turn, worker) => {
            worker.sendInputAccepted(turn.runId);
            worker.sendRejectedEvent(turn.runId, 0, violation);
            worker.sendNativeEvent(turn.runId, 1, ASSISTANT("still here"));
            worker.settle(turn.runId, "completed");
          },
        },
      });

      const result = await harness.send();
      const errors = harness.events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      if (errors[0]?.type !== "error") return;
      expect(errors[0].message).toContain(violation);

      // The refused event corrupted nothing: every persisted line still parses
      // and the later valid event is there.
      const lines = await harness.transcriptLines();
      expect(lines.filter((line) => line.role === "assistant")).toHaveLength(1);
      expect(result.failure).toBeNull();
      expect(result.contentBlocks).toEqual([
        { type: "text", text: "still here" },
      ]);
    },
  );

  it("survives an undecodable payload and still runs later turns", async () => {
    let turnIndex = 0;
    const harness = createPersistingHarness({
      worker: {
        onTurn: (turn, worker) => {
          turnIndex += 1;
          worker.sendInputAccepted(turn.runId);
          if (turnIndex === 1) {
            // Well-formed frame, unparsable payload: the decode boundary, not
            // the encode boundary.
            worker.send({
              v: CURSOR_IPC_CODEC_VERSION,
              type: "nativeEvent",
              runId: turn.runId,
              eventIndex: 0,
              eventType: "assistant",
              payload: "{not json",
            });
            worker.settle(turn.runId, "completed");
            return;
          }
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT("second turn"));
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const first = await harness.send();
    expect(first.failure).toBeNull();
    expect(harness.events.some((event) => event.type === "error")).toBe(true);

    const second = await harness.send();
    expect(second.failure).toBeNull();
    expect(second.contentBlocks).toEqual([
      { type: "text", text: "second turn" },
    ]);
  });
});

// ============================================================
// Failure classes and dispositions (D12)
// ============================================================

describe("failure classification matrix", () => {
  it.each([
    [
      "authentication",
      { name: "AuthenticationError", status: 401 },
      "backend_error",
      "retain",
    ],
    [
      "rate limit",
      { name: "RateLimitError", status: 429 },
      "quota_exhausted",
      "retain",
    ],
    [
      "configuration",
      { name: "ConfigurationError", status: 400 },
      "backend_error",
      "retain",
    ],
    [
      "network",
      { name: "NetworkError", status: 503 },
      "backend_error",
      "retain",
    ],
    [
      "not found",
      { name: "AgentNotFoundError", status: 404 },
      "stale_resume_ref",
      "clear",
    ],
    [
      "unknown agent",
      { name: "UnknownAgentError", status: null },
      "backend_error",
      "retain",
    ],
  ])(
    "maps a %s failure to one terminal outcome with its designed disposition",
    async (_label, error, expectedKind, expectedDisposition) => {
      const harness = createPersistingHarness({
        create: {
          persistedRef: { backend: CURSOR_BACKEND_ID, ref: "agent-prior" },
        },
        worker: {
          onTurn: (turn, worker) => {
            worker.sendInputAccepted(turn.runId);
            worker.settle(turn.runId, "failed", {
              name: error.name,
              code: null,
              status: error.status,
              message: "the provider refused",
            });
          },
        },
      });

      const result = await harness.send();
      expect(result.failure?.kind).toBe(expectedKind);
      expect(result.continuationDisposition).toBe(expectedDisposition);
      expect(result.aborted).toBe(false);
      expect(result.tokenUsage).toBeNull();
      expect(result.costUsd).toBeNull();
      // "clear" forces the ref to null; "retain" keeps it resumable.
      expect(result.backendRef).toEqual(
        expectedDisposition === "clear"
          ? null
          : { backend: CURSOR_BACKEND_ID, ref: "agent-prior" },
      );
    },
  );

  it("discards the stalled worker and resumes the next prompt from a fresh one", async () => {
    let turnIndex = 0;
    const harness = createPersistingHarness({
      create: {
        persistedRef: { backend: CURSOR_BACKEND_ID, ref: "agent-prior" },
      },
      deps: { stallTimeoutMs: 20 },
      worker: {
        onTurn: (turn, worker) => {
          turnIndex += 1;
          if (turnIndex === 1) {
            // Acknowledged, then silent: a wedged run, not a dead worker.
            worker.sendInputAccepted(turn.runId);
            return;
          }
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT("recovered"));
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const stalled = await harness.send();
    expect(stalled.failure?.kind).toBe("timeout");
    expect(stalled.continuationDisposition).toBe("retain");
    expect(stalled.backendRef).toEqual({
      backend: CURSOR_BACKEND_ID,
      ref: "agent-prior",
    });
    // The wedged worker is torn down rather than left installed.
    expect(elementAt(harness.transport.workers, 0).closeCount).toBe(1);

    const recovered = await harness.send();
    expect(recovered.failure).toBeNull();
    expect(recovered.contentBlocks).toEqual([
      { type: "text", text: "recovered" },
    ]);
    // A genuinely FRESH worker, resumed from the persisted ref.
    expect(harness.transport.workers).toHaveLength(2);
    expect(
      elementAt(harness.transport.workers, 1).attachments[0],
    ).toMatchObject({
      mode: "resume",
      ref: "agent-prior",
    });
  });

  it("does not reuse the discarded worker when the next prompt races its teardown", async () => {
    // The real supervisor keeps a worker registered for the WHOLE teardown
    // ladder and returns `already_active` for it until `onSettled` runs. A
    // prompt arriving in that window must not be attached to the wedged
    // worker — it must wait for teardown and then get a fresh one.
    const teardown = deferredSignal();
    const teardownStarted = deferredSignal();
    let turnIndex = 0;
    const harness = createPersistingHarness({
      create: {
        persistedRef: { backend: CURSOR_BACKEND_ID, ref: "agent-prior" },
      },
      deps: { stallTimeoutMs: 20 },
      worker: {
        closeGate: () => {
          teardownStarted.resolve();
          return teardown.promise;
        },
        onTurn: (turn, worker) => {
          turnIndex += 1;
          if (turnIndex === 1) {
            worker.sendInputAccepted(turn.runId);
            return;
          }
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT("recovered"));
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const stalled = harness.send();
    await teardownStarted.promise;

    // Teardown is still in flight, so the wedged worker is still registered.
    const racing = harness.send();
    await settleMicrotasks();
    expect(harness.transport.workers).toHaveLength(1);
    expect(elementAt(harness.transport.workers, 0).turns).toHaveLength(1);

    teardown.resolve();
    expect((await stalled).failure?.kind).toBe("timeout");
    const recovered = await racing;

    expect(recovered.failure).toBeNull();
    expect(recovered.contentBlocks).toEqual([
      { type: "text", text: "recovered" },
    ]);
    expect(harness.transport.workers).toHaveLength(2);
    // The turn ran on the FRESH worker, not the one being torn down.
    expect(elementAt(harness.transport.workers, 0).turns).toHaveLength(1);
    expect(elementAt(harness.transport.workers, 1).turns).toHaveLength(1);
    expect(
      elementAt(harness.transport.workers, 1).attachments[0],
    ).toMatchObject({
      mode: "resume",
      ref: "agent-prior",
    });
  });

  it("holds close() open until a discarded worker's teardown has settled", async () => {
    // Lifecycle callers order worktree removal behind close(); a worker still
    // in its ladder is still sitting in that worktree as its cwd.
    const teardown = deferredSignal();
    const teardownStarted = deferredSignal();
    const harness = createPersistingHarness({
      deps: { stallTimeoutMs: 20 },
      worker: {
        closeGate: () => {
          teardownStarted.resolve();
          return teardown.promise;
        },
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
        },
      },
    });

    const sending = harness.send();
    await teardownStarted.promise;
    let closed = false;
    const closing = harness.runtime.close().then(() => {
      closed = true;
    });

    await settleMicrotasks();
    expect(closed).toBe(false);

    teardown.resolve();
    await Promise.all([closing, sending]);
    expect(closed).toBe(true);
  });

  it("retains the ref after a locally killed worker and resumes on the next prompt", async () => {
    let turnIndex = 0;
    const harness = createPersistingHarness({
      create: {
        persistedRef: { backend: CURSOR_BACKEND_ID, ref: "agent-prior" },
      },
      worker: {
        onTurn: (turn, worker) => {
          turnIndex += 1;
          if (turnIndex === 1) {
            worker.sendInputAccepted(turn.runId);
            worker.die(137, "SIGKILL");
            return;
          }
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT("resumed"));
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const killed = await harness.send();
    expect(killed.failure?.kind).toBe("session_died");
    expect(killed.continuationDisposition).toBe("retain");
    expect(killed.backendRef).toEqual({
      backend: CURSOR_BACKEND_ID,
      ref: "agent-prior",
    });

    const recovered = await harness.send();
    expect(recovered.failure).toBeNull();
    expect(harness.transport.workers).toHaveLength(2);
    expect(
      elementAt(harness.transport.workers, 1).attachments[0],
    ).toMatchObject({
      mode: "resume",
      ref: "agent-prior",
    });
  });
});

// ============================================================
// Usage honesty (D17)
// ============================================================

const COMPLETE_USAGE = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 2,
  totalTokens: 120,
};

describe("token usage accounting", () => {
  it("maps a complete usage frame onto the neutral record", async () => {
    const harness = createPersistingHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendUsage(turn.runId, {
            ...COMPLETE_USAGE,
            reasoningTokens: 7,
          });
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const result = await harness.send();
    expect(result.tokenUsage).toEqual({
      ...COMPLETE_USAGE,
      reasoningTokens: 7,
    });
    expect(result.costUsd).toBeNull();
  });

  it.each([
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
  ] as const)(
    "reports usage unavailable rather than zero when %s is null on the wire",
    async (missingField) => {
      const harness = createPersistingHarness({
        worker: {
          onTurn: (turn, worker) => {
            worker.sendInputAccepted(turn.runId);
            worker.sendUsage(turn.runId, {
              ...COMPLETE_USAGE,
              [missingField]: null,
            });
            worker.settle(turn.runId, "completed");
          },
        },
      });

      const result = await harness.send();
      // A gap filled with zero reads downstream as a measured fact ("used no
      // input tokens"), not a missing one. The neutral schema makes a
      // partially-known record unrepresentable for exactly this reason.
      expect(result.tokenUsage).toBeNull();
      expect(result.costUsd).toBeNull();
    },
  );

  it("keeps an absent reasoningTokens optional rather than unavailable", async () => {
    // `reasoningTokens` is optional, not nullable: the SDK simply reported
    // none, which is a complete record.
    const harness = createPersistingHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendUsage(turn.runId, COMPLETE_USAGE);
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const result = await harness.send();
    expect(result.tokenUsage).toEqual(COMPLETE_USAGE);
  });
});

// ============================================================
// Shared structured output (D16)
// ============================================================

const REPORT_SCHEMA = z.object({ verdict: z.string() });
const REPORT_JSON_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};

function validateTurn(result: ConversationBackendTurnResult) {
  return validateStructuredOutput(REPORT_SCHEMA, {
    native: result.structuredOutput,
    text: result.finalText ?? null,
  });
}

describe("structured output through the shared post-validation path", () => {
  it("accepts a valid final response with no Cursor-specific pipeline", async () => {
    const harness = createPersistingHarness({
      create: {
        outputFormat: { type: "json_schema", schema: REPORT_JSON_SCHEMA },
      },
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(
            turn.runId,
            0,
            ASSISTANT('{"verdict":"pass"}'),
          );
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const result = await harness.send();
    // The adapter forwards no native structured value — the shared extractor
    // is the only thing that reads the output.
    expect(result.structuredOutput).toBeUndefined();
    expect(validateTurn(result)).toEqual({
      ok: true,
      value: { verdict: "pass" },
      source: "raw_json",
    });
  });

  it("repairs an invalid response in one bounded repair turn", async () => {
    let turnIndex = 0;
    const harness = createPersistingHarness({
      create: {
        outputFormat: { type: "json_schema", schema: REPORT_JSON_SCHEMA },
      },
      worker: {
        onTurn: (turn, worker) => {
          turnIndex += 1;
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(
            turn.runId,
            0,
            ASSISTANT(turnIndex === 1 ? "sorry, no JSON" : '{"verdict":"ok"}'),
          );
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const first = await harness.send();
    const firstValidation = validateTurn(first);
    expect(firstValidation.ok).toBe(false);
    if (firstValidation.ok) return;

    const repairPrompt = buildStructuredOutputRepairPrompt({
      schema: REPORT_JSON_SCHEMA,
      priorOutputText: first.finalText ?? "",
      issues: [firstValidation.error],
    });
    const repaired = await harness.send({ promptText: repairPrompt });

    expect(validateTurn(repaired)).toMatchObject({
      ok: true,
      value: { verdict: "ok" },
    });
    // One repair, not a loop: exactly two dispatches reached the worker.
    expect(elementAt(harness.transport.workers, 0).turns).toHaveLength(2);
    expect(
      elementAt(elementAt(harness.transport.workers, 0).turns, 1).input
        .promptText,
    ).toContain(repairPrompt);
  });

  it("reports a bounded validation failure when the repair turn also fails", async () => {
    const harness = createPersistingHarness({
      create: {
        outputFormat: { type: "json_schema", schema: REPORT_JSON_SCHEMA },
      },
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, ASSISTANT("still not JSON"));
          worker.settle(turn.runId, "completed");
        },
      },
    });

    const first = await harness.send();
    const repaired = await harness.send({ promptText: "repair please" });
    const validation = validateTurn(repaired);

    expect(validateTurn(first).ok).toBe(false);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    // A failed contract is a neutral error, not a Cursor one.
    expect(typeof validation.error).toBe("string");
    expect(repaired.failure).toBeNull();
  });
});

describe("provider task activity and continuation", () => {
  const task = {
    type: "tool_call",
    name: "task",
    call_id: "child-call",
    status: "running",
    args: { description: "Compute result" },
  };
  it("persists task progress and completes once in the caller turn", async () => {
    const activities: Array<ConversationBackgroundActivity | null> = [];
    const taskStore = createCursorTaskStore(path.join(TEST_DIR, "task-store"));
    const harness = createPersistingHarness({
      deps: { taskStore: () => taskStore, stallTimeoutMs: 1000 },
      create: { onBackgroundActivity: (value) => activities.push(value) },
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, task);
          worker.sendNativeEvent(turn.runId, 0, task);
          worker.sendNativeEvent(turn.runId, 1, {
            type: "cursor_task_delta",
            update: {
              type: "tool-call-delta",
              callId: "child-call",
              taskUpdate: {
                type: "tool-call-started",
                toolCall: { type: "shell" },
              },
            },
          });
          worker.sendNativeEvent(turn.runId, 2, {
            ...task,
            status: "completed",
            result: { status: "success", value: { isBackground: false } },
          });
          worker.sendNativeEvent(
            turn.runId,
            3,
            ASSISTANT("TASK122_RESULT_847"),
          );
          worker.settle(turn.runId, "completed");
        },
      },
    });
    const result = await harness.send();
    expect(
      activities.some(
        (value) => value?.tasks[0]?.taskId === "cursor:run-1:child-call",
      ),
    ).toBe(true);
    expect(
      activities.some((value) => value?.tasks[0]?.lastToolName === "shell"),
    ).toBe(true);
    expect(activities.at(-1)).toBeNull();
    expect(result).toMatchObject({
      numTurns: 1,
      finalText: "TASK122_RESULT_847",
      costUsd: null,
    });
    expect(
      harness.events.filter((event) => event.type === "external_turn_started"),
    ).toEqual([]);
    expect(await taskStore.load()).toMatchObject([{ status: "completed" }]);
    const lines = await harness.transcriptLines();
    expect(
      lines.filter((line) => line.id === `cursor:${CONVERSATION_ID}:run-1:0`),
    ).toHaveLength(1);
    await harness.runtime.close();
  });
  it("cleans up unobservable background work and persists an honest loss notice", async () => {
    const taskStore = createCursorTaskStore(path.join(TEST_DIR, "task-store"));
    const harness = createPersistingHarness({
      deps: { taskStore: () => taskStore, stallTimeoutMs: 1000 },
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, {
            ...task,
            status: "completed",
            result: { status: "success", value: { isBackground: true } },
          });
          worker.settle(turn.runId, "completed");
        },
      },
    });
    await harness.send();
    expect(await taskStore.load()).toMatchObject([{ status: "lost" }]);
    const notices = (await harness.transcriptLines()).filter(
      (line) => line.type === "notice",
    );
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).toContain("outcome is unknown");
    expect(harness.transport.workers[0]?.closeCount).toBe(1);
    await harness.runtime.close();
  });
  it("recovers interrupted tasks on the next runtime and tells the agent without replaying work", async () => {
    const taskStore = createCursorTaskStore(path.join(TEST_DIR, "task-store"));
    await taskStore.save(
      applyCursorTaskEvent(
        [],
        task,
        "abandoned-run",
        "2026-09-14T00:00:00.000Z",
      ),
    );
    let prompt = "";
    const harness = createPersistingHarness({
      deps: { taskStore: () => taskStore, stallTimeoutMs: 1000 },
      create: { persistedRef: { backend: "cursor", ref: "existing-agent" } },
      worker: {
        onTurn: (turn, worker) => {
          prompt = turn.input.promptText;
          worker.sendInputAccepted(turn.runId);
          worker.settle(turn.runId, "completed");
        },
      },
    });
    await harness.send();
    expect(prompt).toContain("abandoned-run:child-call");
    expect(prompt).toContain("outcome is unknown");
    expect(
      (await harness.transcriptLines()).filter(
        (line) => line.type === "notice",
      ),
    ).toHaveLength(1);
    expect(await taskStore.load()).toEqual([]);
    await harness.runtime.close();
  });
});

it("records task loss and retracts activity when an owned runtime is stopped mid-task", async () => {
  const taskStore = createCursorTaskStore(path.join(TEST_DIR, "task-store"));
  const running = deferredSignal();
  const activities: Array<ConversationBackgroundActivity | null> = [];
  const harness = createPersistingHarness({
    deps: { taskStore: () => taskStore, stallTimeoutMs: 5000 },
    create: {
      onBackgroundActivity: (activity) => {
        activities.push(activity);
        if (activity) running.resolve();
      },
    },
    worker: {
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        worker.sendNativeEvent(turn.runId, 0, {
          type: "tool_call",
          name: "task",
          call_id: "cancelled-child",
          status: "running",
        });
      },
    },
  });
  const result = harness.send();
  await running.promise;
  expect(
    (await createCursorTaskStore(path.join(TEST_DIR, "task-store")).load())[0]
      ?.status,
  ).toBe("running");
  await harness.runtime.close();
  await result;
  expect(activities.at(-1)).toBeNull();
  expect((await taskStore.load())[0]?.status).toBe("lost");
  expect(
    (await harness.transcriptLines()).filter((line) => line.type === "notice"),
  ).toHaveLength(1);
});

it("preserves native transcript and reports accounting failure when the task ledger cannot be saved", async () => {
  const harness = createPersistingHarness({
    deps: {
      taskStore: () => ({
        async load() {
          return [];
        },
        async save() {
          throw new Error("disk full");
        },
      }),
    },
    worker: {
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        worker.sendNativeEvent(turn.runId, 0, {
          type: "tool_call",
          name: "task",
          call_id: "child",
          status: "running",
        });
        worker.sendNativeEvent(turn.runId, 1, {
          type: "tool_call",
          name: "task",
          call_id: "child",
          status: "completed",
          result: { status: "success", value: { isBackground: false } },
        });
        worker.sendNativeEvent(
          turn.runId,
          2,
          ASSISTANT("LEDGER_FAILURE_RESULT"),
        );
        worker.settle(turn.runId, "completed");
      },
    },
  });
  await harness.send();
  const lines = await harness.transcriptLines();
  expect(
    lines.filter((line) =>
      line.id?.toString().startsWith(`cursor:${CONVERSATION_ID}:run-1:`),
    ),
  ).toHaveLength(3);
  expect(
    harness.events.filter((event) => event.type === "input_accepted"),
  ).toHaveLength(1);
  expect(
    JSON.stringify(lines.filter((line) => line.type === "notice")),
  ).toContain("Task recovery after restart is unavailable");
  await harness.runtime.close();
});

describe("live input archive barrier", () => {
  it.each([false, true])(
    "awaits one acceptance callback before fast output (failure: %s)",
    async (archiveFails) => {
      const archive = Promise.withResolvers<void>();
      const ready = deferredSignal();
      let callbacks = 0;
      const harness = createPersistingHarness({
        deps: { stallTimeoutMs: 10_000 },
        worker: {
          onTurn: (turn, worker) => {
            worker.sendInputAccepted(turn.runId);
            ready.resolve();
          },
          onSteer: (input, worker) => {
            const frame = {
              v: CURSOR_IPC_CODEC_VERSION,
              type: "steerResult",
              runId: input.runId,
              requestId: input.requestId,
              outcome: "complete_delivered",
            } as const;
            worker.send(frame);
            worker.send(frame);
            worker.sendNativeEvent(input.runId, 0, ASSISTANT("after steering"));
            worker.settle(input.runId, "completed");
          },
        },
      });
      let completed = false;
      const turn = harness.send().then((result) => {
        completed = true;
        return result;
      });
      await ready.promise;
      const delivery = harness.runtime.queueUserInput({
        content: [{ type: "text", text: "steer" }],
        onAccepted: async () => {
          callbacks += 1;
          await archive.promise;
        },
      });
      await settleMicrotasks();
      expect(callbacks).toBe(1);
      expect(harness.events.some((event) => event.type === "content")).toBe(
        false,
      );
      expect(completed).toBe(false);
      if (archiveFails) {
        archive.reject(new Error("archive unavailable"));
        await expect(delivery).rejects.toThrow("could not be archived");
      } else {
        archive.resolve();
        await delivery;
      }
      const result = await turn;
      expect(callbacks).toBe(1);
      expect(harness.events.some((event) => event.type === "content")).toBe(
        !archiveFails,
      );
      if (archiveFails) {
        expect(harness.runtime.status).toBe("dead");
        expect(result.contentBlocks).toEqual([]);
        expect(result.failure).toMatchObject({ retryable: false });
      }
      await harness.runtime.close();
    },
  );
});
