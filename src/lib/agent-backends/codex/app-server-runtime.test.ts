import { mkdtemp, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHECKPOINT_CAPTURE_LIMITS } from "@/lib/conversation-checkpoints/budget";
import { captureHandoffResultSchema } from "../schemas";
import { describe, expect, it, vi } from "vitest";
import type {
  CaptureHandoffInput,
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendTurnInput,
  ConversationQueuedUserInput,
} from "../conversation";
import type {
  AppServerClient,
  AppServerClientOptions,
} from "./app-server-client";
import { InputDeliveryUncertainError } from "../errors";
import {
  AppServerRequestError,
  AppServerTransportError,
  parseAppServerFrame,
} from "./app-server-protocol";
import {
  CodexConversationRuntime,
  codexConversationBackendFactory,
  type CodexConversationRuntimeDeps,
} from "./conversation-runtime";
import type { CodexInstructionRecord } from "./instruction-state";

const modelSelection = {
  modelId: "gpt-5.4",
  parameters: { reasoning: "high", fast: "false" },
};
const createInput: ConversationBackendCreateInput = {
  executionClass: "ordinary-conversation",
  conversationId: "appserver-runtime",
  projectPath: "/repo",
  projectName: "repo",
  conversationTarget: {
    scope: "session",
    projectName: "repo",
    sessionName: "session",
    conversationId: "appserver-runtime",
  },
  worktreePath: "/repo",
  persistedRef: null,
  modelSelection,
  sessionInstructions: ["Follow the governing contract"],
  tooling: {},
};

function harness(
  overrides: Partial<ConversationBackendCreateInput> = {},
  extraDeps: Partial<CodexConversationRuntimeDeps> = {},
) {
  const requests: { method: string; params: unknown }[] = [];
  const events: ConversationBackendEvent[] = [];
  const records: CodexInstructionRecord[] = [];
  let options: AppServerClientOptions | undefined;
  let drain = Promise.resolve();
  let barrier = Promise.resolve();
  let closed = 0;
  let failed = false;
  const notify = (method: string, params: unknown) => {
    const raw = JSON.stringify({ method, params });
    const frame = parseAppServerFrame(raw, Buffer.byteLength(raw));
    if (frame.message.kind !== "notification" || !options)
      throw new Error("fixture not started");
    options.onNotification?.(frame.message);
    const target = options;
    const gate = barrier;
    drain = drain.then(async () => {
      await gate;
      if (!failed) await target.onFrame(frame);
    });
  };
  const client: AppServerClient = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === "initialize") return {};
      if (method === "thread/start" || method === "thread/resume")
        return {
          thread: { id: "thread-1" },
          model: "gpt-5.4",
          cwd: "/repo",
          approvalPolicy: "never",
          sandbox: { type: "dangerFullAccess" },
        };
      if (method === "thread/inject_items") return {};
      if (method === "turn/start") {
        notify("turn/started", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress" },
        });
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      if (method === "turn/steer") return { turnId: "turn-1" };
      if (method === "turn/interrupt") {
        finish("interrupted");
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    },
    notify() {},
    barrier() {
      const pending = Promise.withResolvers<void>();
      barrier = pending.promise;
      return {
        release: () => pending.resolve(),
        fail: (error) => {
          failed = true;
          pending.resolve();
          options?.onFailure(error);
        },
      };
    },
    flush: () => drain,
    close: async () => {
      closed += 1;
    },
    stderrTail: "",
  };
  const deps: CodexConversationRuntimeDeps = {
    inTurnDeliveryEnabled: true,
    createAppServer(input) {
      options = input;
      return client;
    },
    createInstructionStore: () => ({
      readLatest: async () => records.at(-1) ?? null,
      write: async (record) => {
        records.push(record);
      },
    }),
    buildChildEnv: () => ({ NODE_ENV: "test" }),
    toStringEnv: () => ({}),
    getServerUrl: () => null,
    getApiToken: () => null,
    getConfigDir: () => "/config",
    translatePortableMcpToCodex: () => ({ mcpServers: {}, droppedFields: [] }),
    listNativeCodexMcpServers: async () => [],
    getCodexPricingOverrides: async () => null,
    readPersistedCostBaseline: async () => null,
    ensureManagedSkillsBridge: async () => ({
      status: "linked",
      linkPath: "/repo/.agents/skills/command-center",
    }),
    now: () => 1,
  };
  const runtime = new CodexConversationRuntime(
    { ...createInput, ...overrides },
    { ...deps, ...extraDeps },
  );
  const input: ConversationBackendTurnInput = {
    promptText: "hello",
    imageRefs: [],
    sessionInstructions: [],
    modelSelection,
    autonomous: false,
    signal: new AbortController().signal,
    onEvent: (event) => {
      events.push(event);
    },
  };
  function finish(status = "completed") {
    notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status, error: null },
    });
  }
  const steer = (queued: ConversationQueuedUserInput) => {
    if (!runtime.queueUserInput) throw new Error("steering disabled in test");
    return runtime.queueUserInput(queued);
  };
  const serverRequest = async (method: string) => {
    const params = { threadId: "thread-1", turnId: "turn-1" };
    const result = await options?.onServerRequest?.({
      kind: "server_request",
      id: 77,
      method,
      params,
    });
    const raw = JSON.stringify({ id: 77, method, params });
    await options?.onFrame(parseAppServerFrame(raw, Buffer.byteLength(raw)));
    return result;
  };
  const transportFailure = (error: Error) => options?.onFailure(error);
  return {
    runtime,
    input,
    events,
    requests,
    records,
    notify,
    finish,
    client,
    steer,
    serverRequest,
    transportFailure,
    deps,
    get closed() {
      return closed;
    },
  };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i += 1) await Promise.resolve();
  expect(predicate()).toBe(true);
}

describe("Codex app-server conversation runtime", () => {
  it("uses privileged creation instructions and deduplicates start acceptance", async () => {
    const h = harness();
    const turn = h.runtime.sendTurn(h.input);
    await until(() =>
      h.requests.some((request) => request.method === "turn/start"),
    );
    h.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer",
        type: "agentMessage",
        text: "done",
        phase: "final_answer",
      },
    });
    h.finish();
    const result = await turn;
    expect(result.backendRef).toEqual({ backend: "codex", ref: "thread-1" });
    expect(result.finalText).toBe("done");
    expect(
      h.requests.find((request) => request.method === "thread/start")?.params,
    ).toMatchObject({
      developerInstructions: expect.stringContaining(
        "Follow the governing contract",
      ),
    });
    expect(
      h.requests.find((request) => request.method === "turn/start")?.params,
    ).toMatchObject({ input: [{ type: "text", text: "hello" }] });
    expect(
      h.events.filter((event) => event.type === "input_accepted"),
    ).toHaveLength(1);
    expect(h.records.at(-1)?.unresolved).toBe(false);
    expect(h.closed).toBe(1);
  });
  it("waits for initial accepted-input archival when the start reply precedes notifications", async () => {
    const h = harness();
    const archive = Promise.withResolvers<void>();
    const request = h.client.request;
    h.client.request = async (method, params) => {
      if (method === "turn/start")
        return { turn: { id: "turn-1", status: "inProgress" } };
      return request(method, params);
    };
    let accepting = false;
    const turn = h.runtime.sendTurn({
      ...h.input,
      onEvent: async (event) => {
        h.events.push(event);
        if (event.type === "input_accepted") {
          accepting = true;
          await archive.promise;
        }
      },
    });
    await until(() => accepting);
    h.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer",
        type: "agentMessage",
        text: "response",
        phase: "final_answer",
      },
    });
    for (let count = 0; count < 20; count += 1) await Promise.resolve();
    const contentBeforeArchive = h.events.filter(
      (event) => event.type === "content",
    );
    archive.resolve();
    h.finish();
    await turn;
    expect(contentBeforeArchive).toEqual([]);
    expect(h.events.filter((event) => event.type === "content")).toHaveLength(
      1,
    );
  });

  it("accepts cwd as an implicit writable root in the native sandbox response", async () => {
    const h = harness({
      fsWritePolicy: {
        mode: "allowlist",
        allowWrite: ["/repo", "/tmp/runtime"],
        denyWrite: [],
      },
    });
    const request = h.client.request;
    h.client.request = async (method, params) => {
      if (method === "thread/start")
        return {
          thread: { id: "thread-1" },
          model: "gpt-5.4",
          cwd: "/repo",
          approvalPolicy: "never",
          sandbox: {
            type: "workspaceWrite",
            writableRoots: ["/tmp/runtime"],
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        };
      const response = await request(method, params);
      if (method === "turn/start") h.finish();
      return response;
    };
    const result = await h.runtime.sendTurn(h.input);
    expect(result.failure).toBeNull();
    expect(h.requests.some((entry) => entry.method === "turn/start")).toBe(
      true,
    );
  });

  it("injects changed legacy instructions before user input and excludes hydrated history", async () => {
    const h = harness({ persistedRef: { backend: "codex", ref: "thread-1" } });
    const turn = h.runtime.sendTurn(h.input);
    await until(() =>
      h.requests.some((request) => request.method === "turn/start"),
    );
    h.finish();
    await turn;
    expect(h.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/resume",
      "thread/inject_items",
      "turn/start",
    ]);
    expect(
      h.requests.find((request) => request.method === "thread/resume")?.params,
    ).toMatchObject({ excludeTurns: true });
    expect(h.records.map((record) => record.unresolved)).toEqual([true, false]);
  });

  it("archives steering once before exposing fast output and terminal completion", async () => {
    const h = harness();
    let finished = false;
    const turn = h.runtime.sendTurn(h.input).then((result) => {
      finished = true;
      return result;
    });
    await until(() =>
      h.events.some((event) => event.type === "input_accepted"),
    );
    const archived = Promise.withResolvers<void>();
    let accepted = 0;
    const delivery = h.steer({
      content: [{ type: "text", text: "steer" }],
      onAccepted: async () => {
        accepted += 1;
        await archived.promise;
      },
    });
    await until(() => accepted === 1);
    h.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer",
        type: "agentMessage",
        text: "steered",
        phase: "final_answer",
      },
    });
    h.finish();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(h.events.some((event) => event.type === "content")).toBe(false);
    archived.resolve();
    await delivery;
    expect((await turn).finalText).toBe("steered");
    expect(accepted).toBe(1);
    expect(
      h.events.filter((event) => event.type === "input_accepted"),
    ).toHaveLength(1);
  });

  it("holds lost steering acknowledgement uncertain and releases terminal drain", async () => {
    const h = harness();
    const request = h.client.request;
    h.client.request = async (method, params) => {
      if (method === "turn/steer") {
        h.finish();
        throw new AppServerRequestError("ack lost", true);
      }
      return request(method, params);
    };
    const turn = h.runtime.sendTurn(h.input);
    await until(() =>
      h.events.some((event) => event.type === "input_accepted"),
    );
    let accepted = false;
    await expect(
      h.steer({
        content: [{ type: "text", text: "steer" }],
        onAccepted: async () => {
          accepted = true;
        },
      }),
    ).rejects.toBeInstanceOf(InputDeliveryUncertainError);
    await turn;
    expect(accepted).toBe(false);
  });

  it("rejects a measured expected-active-turn mismatch without uncertainty", async () => {
    const h = harness();
    const request = h.client.request;
    h.client.request = async (method, params) => {
      if (method === "turn/steer")
        throw new AppServerRequestError("rejected", true, {
          code: -32600,
          message: "expected active turn id `old` but found `current`",
        });
      return request(method, params);
    };
    const turn = h.runtime.sendTurn(h.input);
    await until(() =>
      h.events.some((event) => event.type === "input_accepted"),
    );
    await expect(
      h.steer({ content: [{ type: "text", text: "steer" }] }),
    ).rejects.not.toBeInstanceOf(InputDeliveryUncertainError);
    h.finish();
    await turn;
  });

  it("does not accept initialize/thread replies as user-input acceptance", async () => {
    const h = harness();
    const request = h.client.request;
    h.client.request = async (method, params) => {
      if (method === "turn/start")
        throw new AppServerRequestError("start refused", false);
      return request(method, params);
    };
    const result = await h.runtime.sendTurn(h.input);
    expect(result.failure).not.toBeNull();
    expect(h.events.filter((event) => event.type === "input_accepted")).toEqual(
      [],
    );
  });

  it("uses process usage for turn cost while an unknown resumed ledger remains unknown", async () => {
    const h = harness({ persistedRef: { backend: "codex", ref: "thread-1" } });
    const turn = h.runtime.sendTurn(h.input);
    await until(() =>
      h.events.some((event) => event.type === "input_accepted"),
    );
    h.notify("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          inputTokens: 100,
          cachedInputTokens: 10,
          outputTokens: 20,
          reasoningOutputTokens: 0,
          totalTokens: 120,
        },
      },
    });
    h.finish();
    const result = await turn;
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.cumulativeCostUsd).toBeNull();
    expect(result.contextTokens).toBeNull();
  });

  it("returns sticky cleanup failure even on a cancelled turn and refuses reuse", async () => {
    const h = harness();
    h.client.close = async () => {
      throw new AppServerTransportError("cleanup_unverified", "still alive");
    };
    const controller = new AbortController();
    const turn = h.runtime.sendTurn({ ...h.input, signal: controller.signal });
    await until(() =>
      h.events.some((event) => event.type === "input_accepted"),
    );
    controller.abort();
    const result = await turn;
    expect(result.aborted).toBe(true);
    expect(result.cleanupFailure?.kind).toBe("cleanup_unverified");
    expect(result.failure?.retryable).toBe(false);
    await expect(h.runtime.close()).rejects.toThrow("still alive");
    expect((await h.runtime.sendTurn(h.input)).cleanupFailure?.kind).toBe(
      "cleanup_unverified",
    );
  });

  it("retains a created thread when the written start acknowledgement is lost", async () => {
    const h = harness();
    const request = h.client.request;
    h.client.request = async (method, params) => {
      if (method === "turn/start")
        throw new AppServerRequestError("start acknowledgement lost", true);
      return request(method, params);
    };
    const result = await h.runtime.sendTurn(h.input);
    expect(result.backendRef).toEqual({ backend: "codex", ref: "thread-1" });
    expect(result.continuationDisposition).toBe("retain");
  });

  it("does not infer acceptance from unrelated thread notifications before start refusal", async () => {
    const h = harness();
    const request = h.client.request;
    h.client.request = async (method, params) => {
      if (method === "turn/start") {
        h.notify("thread/status/changed", {
          threadId: "thread-1",
          status: { type: "idle" },
        });
        await h.client.flush();
        throw new AppServerRequestError("start refused", false);
      }
      return request(method, params);
    };
    await h.runtime.sendTurn(h.input);
    expect(h.events.filter((event) => event.type === "input_accepted")).toEqual(
      [],
    );
  });

  it("subtracts a scoped pre-start usage baseline inside the same process", async () => {
    const h = harness({ persistedRef: { backend: "codex", ref: "thread-1" } });
    const request = h.client.request;
    const usage = (inputTokens: number) => ({
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          inputTokens,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: inputTokens,
        },
      },
    });
    h.client.request = async (method, params) => {
      if (method === "thread/resume")
        h.notify("thread/tokenUsage/updated", usage(100));
      return request(method, params);
    };
    const turn = h.runtime.sendTurn(h.input);
    await until(() =>
      h.events.some((event) => event.type === "input_accepted"),
    );
    h.notify("thread/tokenUsage/updated", usage(150));
    h.finish();
    expect((await turn).costUsd).toBeCloseTo((50 * 2.5) / 1_000_000, 10);
  });

  it("invalidates instruction settlement when compaction races its acknowledgement", async () => {
    const h = harness({ persistedRef: { backend: "codex", ref: "thread-1" } });
    const request = h.client.request;
    h.client.request = async (method, params) => {
      if (method === "thread/inject_items") {
        h.notify("thread/compacted", { threadId: "thread-1" });
        await h.client.flush();
      }
      return request(method, params);
    };
    let settled = false;
    const turn = h.runtime.sendTurn(h.input).then((result) => {
      settled = true;
      return result;
    });
    await until(
      () =>
        settled ||
        h.requests.some((request) => request.method === "turn/start"),
    );
    if (!settled) h.finish();
    const result = await turn;
    expect(result.failure).not.toBeNull();
    expect(h.requests.some((request) => request.method === "turn/start")).toBe(
      false,
    );
    expect(h.records.at(-1)?.unresolved).toBe(true);
  });

  it.each([
    ["item/commandExecution/requestApproval", { decision: "decline" }],
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["mcpServer/elicitation/request", { action: "decline" }],
  ])(
    "denies unexpected server request %s explicitly",
    async (method, result) => {
      const h = harness();
      const turn = h.runtime.sendTurn(h.input);
      await until(() =>
        h.events.some((event) => event.type === "input_accepted"),
      );
      expect(await h.serverRequest(String(method))).toEqual({ result });
      h.finish();
      await turn;
    },
  );

  it("classifies native resume refusal instead of its generic transport wrapper", async () => {
    const h = harness({ persistedRef: { backend: "codex", ref: "thread-1" } });
    const request = h.client.request;
    h.client.request = async (method, params) => {
      if (method === "thread/resume")
        throw new AppServerRequestError(
          "Codex app-server rejected the request",
          true,
          { code: -32600, message: "thread not found: thread-1" },
        );
      return request(method, params);
    };
    const result = await h.runtime.sendTurn(h.input);
    expect(result.failure?.kind).toBe("stale_resume_ref");
    expect(result.backendRef).toBeNull();
    expect(result.continuationDisposition).toBe("clear");
  });

  it("does not release close before an accepted archive callback finishes", async () => {
    const h = harness();
    const turn = h.runtime.sendTurn(h.input);
    await until(() =>
      h.events.some((event) => event.type === "input_accepted"),
    );
    const archive = Promise.withResolvers<void>();
    let accepted = false;
    const delivery = h.steer({
      content: [{ type: "text", text: "steer" }],
      onAccepted: async () => {
        accepted = true;
        await archive.promise;
      },
    });
    await until(() => accepted);
    h.finish();
    let closed = false;
    const close = h.runtime.close().then(() => {
      closed = true;
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(closed).toBe(false);
    archive.resolve();
    await Promise.all([delivery, close, turn]);
  });

  it.each(["close", "transport failure"] as const)(
    "stops the process but retains ownership of pending accepted archival after %s",
    async (cause) => {
      vi.useFakeTimers();
      const h = harness();
      const archive = Promise.withResolvers<void>();
      let completed = false;
      let accepted = false;
      const turn = h.runtime.sendTurn(h.input).then((result) => {
        completed = true;
        return result;
      });
      let close: Promise<void> = Promise.resolve();
      let delivery: Promise<unknown> = Promise.resolve();
      try {
        await until(() =>
          h.events.some((event) => event.type === "input_accepted"),
        );
        delivery = h
          .steer({
            content: [{ type: "text", text: "steer" }],
            onAccepted: async () => {
              accepted = true;
              await archive.promise;
            },
          })
          .catch((error: unknown) => error);
        await until(() => accepted);
        if (cause === "transport failure")
          h.transportFailure(
            new AppServerTransportError(
              "queue_limit",
              "archive consumer stalled",
            ),
          );
        close = h.runtime.close();
        await vi.advanceTimersByTimeAsync(5_001);
        expect(h.closed).toBeGreaterThan(0);
        expect(completed).toBe(false);
        expect(h.events.some((event) => event.type === "content")).toBe(false);
        archive.resolve();
        await Promise.all([delivery, close]);
        const result = await turn;
        if (cause === "transport failure")
          expect(result.failure).toMatchObject({ retryable: false });
      } finally {
        archive.resolve();
        await Promise.all([turn, delivery, close]);
        vi.useRealTimers();
      }
    },
  );

  it("cannot spawn after close during preparation", async () => {
    const preparing = Promise.withResolvers<void>();
    const h = harness();
    const runtime = new CodexConversationRuntime(createInput, {
      ...h.deps,
      ensureManagedSkillsBridge: async () => {
        await preparing.promise;
        return { status: "skipped", reason: "no_bundle" };
      },
    });
    const turn = runtime.sendTurn(h.input);
    const close = runtime.close();
    preparing.resolve();
    await Promise.all([turn, close]);
    expect(h.requests).toEqual([]);
  });

  it("surfaces an unsupported native question after returning its protocol error", async () => {
    const h = harness();
    const turn = h.runtime.sendTurn(h.input);
    await until(() =>
      h.events.some((event) => event.type === "input_accepted"),
    );
    expect(await h.serverRequest("item/tool/requestUserInput")).toMatchObject({
      error: { code: -32601 },
    });
    const result = await turn;
    expect(result.failure).toMatchObject({
      kind: "backend_error",
      retryable: false,
      message: expect.stringContaining("Unsupported Codex operation"),
    });
    expect(
      h.requests.some((request) => request.method === "turn/interrupt"),
    ).toBe(true);
  });

  it("fails after accepted-input archival rejection and suppresses following content", async () => {
    const h = harness();
    const turn = h.runtime.sendTurn(h.input);
    await until(() =>
      h.events.some((event) => event.type === "input_accepted"),
    );
    const archived = Promise.withResolvers<void>();
    let accepted = false;
    const delivery = h.steer({
      content: [{ type: "text", text: "steer" }],
      onAccepted: async () => {
        accepted = true;
        await archived.promise;
      },
    });
    await until(() => accepted);
    h.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "post-steer",
        type: "agentMessage",
        text: "must not appear",
        phase: "final_answer",
      },
    });
    const rejected = expect(delivery).rejects.toBeInstanceOf(
      InputDeliveryUncertainError,
    );
    archived.reject(new Error("archive unavailable"));
    await rejected;
    const result = await turn;
    expect(result.failure).toMatchObject({
      kind: "backend_error",
      retryable: false,
    });
    expect(h.events.filter((event) => event.type === "content")).toEqual([]);
  });
});

const captureInput = (): CaptureHandoffInput => ({
  captureId: "capture-1",
  mode: "instruction-only",
  promptText: "Record current working state only. No tools.",
  outputSchema: { type: "object", required: ["capturePlan"] },
  limits: CHECKPOINT_CAPTURE_LIMITS,
  signal: new AbortController().signal,
  onTranscript: async () => {},
});
const captureSource = {
  persistedRef: { backend: "codex", ref: "thread-1" },
} as const;
function answerCapture(h: ReturnType<typeof harness>) {
  h.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "answer",
      type: "agentMessage",
      phase: "final_answer",
      text: '{"plan":[]}',
    },
  });
  h.finish();
}

describe("Codex instruction-only capture", () => {
  it("exposes the operation through the registered factory and binds initialPurpose", async () => {
    const runtime = await codexConversationBackendFactory.createRuntime({
      ...createInput,
      ...captureSource,
      initialPurpose: {
        kind: "checkpoint_handoff",
        captureId: "bound-id",
        mode: "instruction-only",
      },
    });
    expect(runtime.captureHandoff).toBeTypeOf("function");
    expect(await runtime.captureHandoff?.(captureInput())).toMatchObject({
      submitted: false,
      omissionReason: "mode_changed",
    });
    await runtime.close();
  });
  it("resumes selected continuity with stable callable tools and one submission", async () => {
    const h = harness({
      ...captureSource,
      initialPurpose: {
        kind: "checkpoint_handoff",
        captureId: "capture-1",
        mode: "instruction-only",
      },
    });
    const archive: unknown[] = [];
    const pending = h.runtime.captureHandoff({
      ...captureInput(),
      onTranscript: async (entry) => {
        archive.push(entry);
      },
    });
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    answerCapture(h);
    const result = await pending;
    expect(result.candidateText).toBe('{"plan":[]}');
    expect(result.activity).toMatchObject({
      native: "unavailable",
      prohibited: "not_observed",
    });
    expect(result).toMatchObject({
      modeEstablished: true,
      submitted: true,
      correlatedCompletion: true,
      executionSettled: true,
    });
    expect(captureHandoffResultSchema.safeParse(result).success).toBe(true);
    expect(h.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(
      h.requests.find((r) => r.method === "initialize")?.params,
    ).toMatchObject({ capabilities: { experimentalApi: false } });
    expect(
      h.requests.find((r) => r.method === "thread/resume")?.params,
    ).toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.4",
      approvalPolicy: "never",
    });
    expect(h.requests.some((r) => r.method === "thread/start")).toBe(false);
    expect(
      JSON.stringify(h.requests.find((r) => r.method === "turn/start")?.params),
    ).toContain("capturePlan");
    expect(h.requests.some((r) => r.method === "thread/inject_items")).toBe(
      false,
    );
    expect(archive.length).toBeGreaterThan(0);
    expect(h.events).toEqual([]);
    expect((await h.runtime.captureHandoff(captureInput())).submitted).toBe(
      false,
    );
  });
  it.each([null, { backend: "claude", ref: "other" }] as const)(
    "refuses missing or wrong continuity %s",
    async (persistedRef) => {
      const h = harness({ persistedRef });
      expect(await h.runtime.captureHandoff(captureInput())).toMatchObject({
        submitted: false,
        omissionReason: "continuity_unavailable",
      });
      expect(h.requests).toEqual([]);
    },
  );
  it("refuses mode mismatch before allocation", async () => {
    const h = harness(captureSource);
    expect(
      await h.runtime.captureHandoff({
        ...captureInput(),
        mode: "tool-disabled",
      }),
    ).toMatchObject({ submitted: false, omissionReason: "mode_changed" });
    expect(h.requests).toEqual([]);
  });
  it("does not substitute a different resumed thread", async () => {
    const h = harness({
      ...captureSource,
      persistedRef: { backend: "codex", ref: "wrong-thread" },
    });
    expect(await h.runtime.captureHandoff(captureInput())).toMatchObject({
      submitted: false,
      omissionReason: "continuity_unavailable",
    });
    expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
  });
  it("declines approval and reports transport activity without ordinary questions", async () => {
    const h = harness(captureSource);
    const pending = h.runtime.captureHandoff(captureInput());
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    expect(await h.serverRequest("mcpServer/elicitation/request")).toEqual({
      result: { action: "decline" },
    });
    h.finish();
    expect(await pending).toMatchObject({
      candidateText: null,
      omissionReason: "prohibited_activity",
      activity: { prohibited: "observed" },
    });
  });
  it.each([
    "custom_tool_call",
    "local_shell_call",
    "tool_search_call",
    "image_generation_call",
    "malformed",
    "unreadable",
    "clean",
  ])("inspects supplied native interval: %s", async (kind) => {
    const dir = await mkdtemp(path.join(tmpdir(), "cc-capture-native-"));
    const nativePath = path.join(dir, "native.jsonl");
    await appendFile(nativePath, '"old history"\n');
    try {
      const h = harness(captureSource);
      const original = h.client.request;
      h.client.request = async (method, params) => {
        if (method === "thread/resume")
          return {
            thread: { id: "thread-1", path: nativePath },
            model: "gpt-5.4",
            cwd: "/repo",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
          };
        if (method === "turn/start")
          await appendFile(
            nativePath,
            JSON.stringify({
              type: "event_msg",
              payload: { type: "task_started", turn_id: "turn-1" },
            }) + "\n",
          );
        return original(method, params);
      };
      const pending = h.runtime.captureHandoff(captureInput());
      await vi.waitFor(() =>
        expect(h.requests.some((r) => r.method === "turn/start")).toBe(true),
      );
      await appendFile(
        nativePath,
        kind.endsWith("_call")
          ? JSON.stringify({
              type: "response_item",
              payload: { type: kind, name: "exec" },
            }) + "\n"
          : kind === "malformed"
            ? "bad\n"
            : "",
      );
      await appendFile(
        nativePath,
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }) + "\n",
      );
      if (kind === "unreadable") await rm(nativePath);
      answerCapture(h);
      const result = await pending;
      expect(result).toMatchObject(
        kind === "clean"
          ? { candidateText: '{"plan":[]}', activity: { native: "complete" } }
          : kind.endsWith("_call")
            ? {
                candidateText: null,
                omissionReason: "prohibited_activity",
                activity: { prohibited: "observed", native: "complete" },
              }
            : {
                candidateText: null,
                omissionReason: "native_inspection_incomplete",
                activity: { native: "incomplete" },
              },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex bounded capture settlement and usage", () => {
  it("allows terminal completion before the turn/start acknowledgement", async () => {
    const h = harness(captureSource);
    const ack = Promise.withResolvers<void>();
    let acknowledged = false;
    const original = h.client.request;
    h.client.request = async (method, params) => {
      const result = await original(method, params);
      if (method === "turn/start") {
        await ack.promise;
        acknowledged = true;
      }
      return result;
    };
    const close = h.client.close;
    h.client.close = async () => {
      if (!acknowledged) throw new Error("closed before start acknowledgement");
      await close();
    };
    const pending = h.runtime.captureHandoff(captureInput());
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    answerCapture(h);
    ack.resolve();
    expect(await pending).toMatchObject({
      candidateText: '{"plan":[]}',
      executionSettled: true,
    });
  });

  it("waits for child close after turn completion and retains cleanup uncertainty", async () => {
    const h = harness(captureSource);
    const held = Promise.withResolvers<void>();
    h.client.close = () => held.promise;
    let done = false;
    const pending = h.runtime.captureHandoff(captureInput()).then((r) => {
      done = true;
      return r;
    });
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    answerCapture(h);
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    held.reject(new Error("unaccounted child"));
    expect(await pending).toMatchObject({
      executionSettled: false,
      candidateText: null,
      omissionReason: "cleanup_unverified",
      cleanupFailure: { code: "cleanup_unverified" },
    });
  });
  it("preserves known cleanup uncertainty on a repeated capture call", async () => {
    const h = harness(captureSource);
    h.client.close = async () => {
      throw new Error("unaccounted child");
    };
    const pending = h.runtime.captureHandoff(captureInput());
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    answerCapture(h);
    await pending;
    expect(await h.runtime.captureHandoff(captureInput())).toMatchObject({
      submitted: false,
      executionSettled: false,
      omissionReason: "cleanup_unverified",
      cleanupFailure: { code: "cleanup_unverified" },
    });
  });
  it.each(["skip", "cancel"])(
    "interrupts once for %s and keeps normal recreation usable",
    async (reason) => {
      const h = harness(captureSource);
      const controller = new AbortController();
      const pending = h.runtime.captureHandoff({
        ...captureInput(),
        signal: controller.signal,
      });
      await until(() => h.requests.some((r) => r.method === "turn/start"));
      controller.abort(reason);
      const result = await pending;
      expect(result).toMatchObject({
        omissionReason: reason === "skip" ? "skipped" : "cancelled",
        executionSettled: true,
        continuation: { nextRuntime: "recreate_from_ref" },
      });
      expect(
        h.requests.filter((r) => r.method === "turn/interrupt"),
      ).toHaveLength(1);
      const recreated = harness({
        persistedRef: result.continuation.backendRef,
      });
      const ordinary = recreated.runtime.sendTurn(recreated.input);
      await until(() =>
        recreated.requests.some((r) => r.method === "turn/start"),
      );
      recreated.finish();
      expect((await ordinary).failure).toBeNull();
    },
  );
  it("bounds execution and submits only one interrupt", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(captureSource);
      const pending = h.runtime.captureHandoff({
        ...captureInput(),
        limits: { ...CHECKPOINT_CAPTURE_LIMITS, executionMs: 10 },
      });
      await until(() => h.requests.some((r) => r.method === "turn/start"));
      await vi.advanceTimersByTimeAsync(11);
      expect(await pending).toMatchObject({
        omissionReason: "execution_limit",
        candidateText: null,
        executionSettled: true,
      });
      expect(
        h.requests.filter((r) => r.method === "turn/interrupt"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("counts streamed and completed answer bytes once, but sums distinct messages", async () => {
    const h = harness(captureSource);
    const pending = h.runtime.captureHandoff({
      ...captureInput(),
      limits: { ...CHECKPOINT_CAPTURE_LIMITS, outputBytes: 4 },
    });
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    h.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "a",
      delta: "🙂",
    });
    h.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "a",
        type: "agentMessage",
        phase: "final_answer",
        text: "🙂",
      },
    });
    h.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "a",
        type: "agentMessage",
        phase: "final_answer",
        text: "🙂",
      },
    });
    await h.client.flush();
    expect(
      h.requests.filter((r) => r.method === "turn/interrupt"),
    ).toHaveLength(0);
    h.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "b",
      delta: "x",
    });
    await h.client.flush();
    h.finish();
    expect(await pending).toMatchObject({
      omissionReason: "output_limit",
      candidateText: null,
    });
    expect(
      h.requests.filter((r) => r.method === "turn/interrupt"),
    ).toHaveLength(1);
  });
  it("differences available counters and labels estimated pricing", async () => {
    const h = harness(captureSource);
    const original = h.client.request;
    const counters = (
      inputTokens: number,
      cachedInputTokens: number,
      outputTokens: number,
    ) => ({
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens: 0,
          totalTokens: inputTokens + outputTokens,
        },
      },
    });
    h.client.request = async (method, params) => {
      const result = await original(method, params);
      if (method === "thread/resume")
        h.notify("thread/tokenUsage/updated", counters(100, 20, 10));
      return result;
    };
    const pending = h.runtime.captureHandoff(captureInput());
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    h.notify("thread/tokenUsage/updated", counters(140, 30, 20));
    answerCapture(h);
    expect((await pending).usage).toMatchObject({
      inputTokens: 40,
      cachedInputTokens: 10,
      outputTokens: 10,
      costBasis: "pricing_estimate",
      costUsd: expect.any(Number),
    });
  });
  it("keeps counters absent when no baseline can establish a difference", async () => {
    const h = harness(captureSource);
    const pending = h.runtime.captureHandoff(captureInput());
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    answerCapture(h);
    expect((await pending).usage).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
      costBasis: null,
    });
  });
});

it("omits a timed-out native read after execution and archive are known collected", async () => {
  vi.useFakeTimers();
  const held = Promise.withResolvers<void>();
  try {
    const h = harness(captureSource, {
      inspectNativeWindow: async () => {
        await held.promise;
        return { coverage: "incomplete", observedToolActivity: false };
      },
    });
    const pending = h.runtime.captureHandoff({
      ...captureInput(),
      limits: { ...CHECKPOINT_CAPTURE_LIMITS, settlementMs: 10 },
    });
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    answerCapture(h);
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({
      executionSettled: true,
      cleanupFailure: null,
      candidateText: null,
      omissionReason: "native_inspection_incomplete",
    });
  } finally {
    held.resolve();
    vi.useRealTimers();
  }
});

it("retains a hold when a capture transcript callback rejects", async () => {
  const h = harness(captureSource);
  const original = h.client.request;
  h.client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === "thread/resume")
      h.notify("future/additive", { threadId: "thread-1" });
    return result;
  };
  const result = await h.runtime.captureHandoff({
    ...captureInput(),
    onTranscript: async () => {
      throw new Error("required write rejected");
    },
  });
  expect(result).toMatchObject({
    candidateText: null,
    executionSettled: false,
    cleanupFailure: { code: "cleanup_unverified" },
    omissionReason: "cleanup_unverified",
  });
});

it.each([true, false])(
  "excludes commentary bytes from the final-answer limit (early phase=%s)",
  async (earlyPhase) => {
    const h = harness(captureSource);
    const pending = h.runtime.captureHandoff({
      ...captureInput(),
      limits: { ...CHECKPOINT_CAPTURE_LIMITS, outputBytes: 12 },
    });
    await until(() => h.requests.some((r) => r.method === "turn/start"));
    if (earlyPhase)
      h.notify("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "comment", type: "agentMessage", phase: "commentary" },
      });
    const commentary = earlyPhase
      ? "commentary exceeds the answer budget"
      : "commentary";
    h.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "comment",
      delta: commentary,
    });
    h.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "comment",
        type: "agentMessage",
        phase: "commentary",
        text: commentary,
      },
    });
    answerCapture(h);
    expect(await pending).toMatchObject({
      candidateText: '{"plan":[]}',
      omissionReason: null,
    });
    expect(
      h.requests.filter((r) => r.method === "turn/interrupt"),
    ).toHaveLength(0);
  },
);
