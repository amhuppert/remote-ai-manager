import { ManagedConversationRuntime } from "@/lib/workflows/conversation/runtime-binding";
import { describe, expect, it } from "vitest";
import type {
  CaptureHandoffInput,
  ConversationBackendCreateInput,
} from "../conversation";
import { captureHandoffResultSchema } from "../schemas";
import { CursorConversationRuntime } from "./conversation-runtime";
import { translatePortableMcpToCursor } from "./mcp-translation";
import { createScriptedTransport } from "./testing/scripted-worker";
import type { ScriptedWorkerOptions } from "./testing/scripted-worker";

const selection = { modelId: "composer-2.5", parameters: {} };
const sourceRef = { backend: "cursor" as const, ref: "source-agent" };

function createInput(): ConversationBackendCreateInput {
  return {
    executionClass: "ordinary-conversation",
    conversationId: "capture-conversation",
    projectPath: "/repo",
    projectName: "repo",
    conversationTarget: {
      scope: "session",
      projectName: "repo",
      sessionName: "s1",
      conversationId: "capture-conversation",
    },
    worktreePath: "/repo/.worktrees/s1",
    persistedRef: sourceRef,
    modelSelection: selection,
    sessionInstructions: [],
    tooling: {},
    initialPurpose: {
      kind: "checkpoint_handoff",
      captureId: "capture-1",
      mode: "tool-disabled",
    },
  };
}

function captureInput(
  signal = new AbortController().signal,
): CaptureHandoffInput {
  return {
    captureId: "capture-1",
    mode: "tool-disabled",
    promptText: "Summarize the current task without tools",
    outputSchema: { type: "object" },
    limits: {
      maxSubmissions: 1,
      executionMs: 5000,
      settlementMs: 5000,
      inputBytes: 8192,
      outputBytes: 6144,
      nativeInspectionBytes: 65536,
      nativeInspectionMs: 5000,
    },
    signal,
    onTranscript: async () => {},
  };
}

function createRuntime(options: ScriptedWorkerOptions, input = createInput()) {
  const transport = createScriptedTransport(options);
  let run = 0;
  const runtime = new CursorConversationRuntime(input, {
    transport,
    storePath: (id) => `/state/cursor/${id}`,
    resolveModel: async (value) => ({ ok: true, selection: value }),
    translatePortableMcpToCursor,
    newRunId: () => `capture-run-${++run}`,
    now: () => Date.now(),
    stallTimeoutMs: 5000,
    cancelSettleTimeoutMs: 100,
  });
  return { runtime, transport };
}

describe("Cursor handoff capture", () => {
  it("resumes the source in a restricted worker and returns a separate answer", async () => {
    const transcript: string[] = [];
    const { runtime, transport } = createRuntime({
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        worker.sendNativeEvent(turn.runId, 0, {
          type: "assistant",
          agent_id: sourceRef.ref,
          run_id: turn.runId,
          message: {
            role: "assistant",
            content: [{ type: "text", text: '{"plan":[]}' }],
          },
        });
        worker.settle(turn.runId, "completed");
      },
    });
    const input = captureInput();
    input.onTranscript = async (entry) => {
      transcript.push(entry.type);
    };

    expect(typeof runtime.captureHandoff).toBe("function");
    const result = await runtime.captureHandoff(input);

    expect(captureHandoffResultSchema.safeParse(result).success).toBe(true);
    expect(transport.startInputs[0]?.executionProfile).toBe(
      "isolated-one-shot",
    );
    expect(transport.workers[0]?.attachments[0]).toMatchObject({
      mode: "resume",
      ref: sourceRef.ref,
      mcpServers: {},
      agents: {},
    });
    expect(transport.workers[0]?.turns[0]?.input).toMatchObject({
      allowQuestions: false,
      mcpServers: {},
      images: [],
    });
    expect(transcript).toContain("assistant");
    expect(result).toMatchObject({
      modeEstablished: true,
      submitted: true,
      correlatedCompletion: true,
      candidateText: '{"plan":[]}',
      omissionReason: null,
      executionSettled: true,
      continuation: {
        disposition: "retain",
        backendRef: sourceRef,
        nextRuntime: "recreate_from_ref",
      },
      activity: {
        transport: "complete",
        native: "complete",
        prohibited: "not_observed",
      },
    });
    expect(runtime.status).toBe("dead");
    expect(transport.workers[0]?.closeCount).toBe(1);
  });

  it("retires an ordinary worker before resuming its source ref with restrictions", async () => {
    const { runtime, transport } = createRuntime(
      {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendNativeEvent(turn.runId, 0, {
            type: "assistant",
            agent_id: sourceRef.ref,
            run_id: turn.runId,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "state" }],
            },
          });
          worker.settle(turn.runId, "completed");
        },
      },
      { ...createInput(), initialPurpose: undefined },
    );
    await runtime.sendTurn({
      promptText: "ordinary turn",
      imageRefs: [],
      sessionInstructions: [],
      modelSelection: selection,
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: async () => {},
    });
    const result = await runtime.captureHandoff(captureInput());
    expect(transport.workers).toHaveLength(2);
    expect(transport.workers[0]?.closeCount).toBe(1);
    expect(transport.startInputs[1]?.executionProfile).toBe(
      "isolated-one-shot",
    );
    expect(transport.workers[1]?.attachments[0]).toMatchObject({
      mode: "resume",
      ref: sourceRef.ref,
      mcpServers: {},
      agents: {},
    });
    expect(result.continuation).toMatchObject({
      disposition: "retain",
      backendRef: sourceRef,
      nextRuntime: "recreate_from_ref",
    });
  });

  it("omits capture on native tool activity while retaining the source", async () => {
    const { runtime } = createRuntime({
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        worker.sendNativeEvent(turn.runId, 0, {
          type: "tool_call",
          call_id: "call-1",
          name: "shell",
          status: "started",
        });
        worker.settle(turn.runId, "completed");
      },
    });
    const result = await runtime.captureHandoff(captureInput());
    expect(captureHandoffResultSchema.safeParse(result).success).toBe(true);
    expect(result.candidateText).toBeNull();
    expect(result.omissionReason).toBe("prohibited_activity");
    expect(result.activity.prohibited).toBe("observed");
    expect(result.continuation.backendRef).toEqual(sourceRef);
  });

  it("cancels the capture run, collects its worker, and keeps the source ref", async () => {
    const started = Promise.withResolvers<{
      runId: string;
      settle(): void;
    }>();
    const { runtime, transport } = createRuntime({
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        started.resolve({
          runId: turn.runId,
          settle: () => worker.settle(turn.runId, "aborted"),
        });
      },
    });
    const controller = new AbortController();
    const pending = runtime.captureHandoff(captureInput(controller.signal));
    const run = await started.promise;
    controller.abort("cancelled");
    run.settle();
    const result = await pending;
    expect(captureHandoffResultSchema.safeParse(result).success).toBe(true);
    expect(result.candidateText).toBeNull();
    expect(result.omissionReason).toBe("cancelled");
    expect(result.continuation.backendRef).toEqual(sourceRef);
    expect(transport.workers[0]?.cancelledRunIds).toContain(run.runId);
    expect(transport.workers[0]?.closeCount).toBe(1);
  });

  it("does not charge model waiting time to the native inspection budget", async () => {
    const { runtime } = createRuntime({
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        worker.sendNativeEvent(turn.runId, 0, {
          type: "status",
          status: "RUNNING",
        });
        setTimeout(() => {
          worker.sendNativeEvent(turn.runId, 1, {
            type: "assistant",
            agent_id: sourceRef.ref,
            run_id: turn.runId,
            message: {
              role: "assistant",
              content: [{ type: "text", text: '{"plan":[]}' }],
            },
          });
          worker.settle(turn.runId, "completed");
        }, 100);
      },
    });
    const input = captureInput();
    input.limits.nativeInspectionMs = 50;
    const result = await runtime.captureHandoff(input);
    expect(result.omissionReason).toBeNull();
    expect(result.candidateText).toBe('{"plan":[]}');
    expect(result.activity.native).toBe("complete");
  });

  it("rejects an answer that crosses the output byte limit", async () => {
    const { runtime } = createRuntime({
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        worker.sendNativeEvent(turn.runId, 0, {
          type: "assistant",
          agent_id: sourceRef.ref,
          run_id: turn.runId,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "12345" }],
          },
        });
        worker.settle(turn.runId, "completed");
      },
    });
    const input = captureInput();
    input.limits.outputBytes = 4;
    const result = await runtime.captureHandoff(input);
    expect(captureHandoffResultSchema.safeParse(result).success).toBe(true);
    expect(result.omissionReason).toBe("output_limit");
    expect(result.candidateText).toBeNull();
  });

  it("omits capture when native evidence exceeds its inspection budget", async () => {
    const { runtime } = createRuntime({
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        worker.sendNativeEvent(turn.runId, 0, {
          type: "assistant",
          agent_id: sourceRef.ref,
          run_id: turn.runId,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
          },
        });
        worker.settle(turn.runId, "completed");
      },
    });
    const input = captureInput();
    input.limits.nativeInspectionBytes = 1;
    const result = await runtime.captureHandoff(input);
    expect(captureHandoffResultSchema.safeParse(result).success).toBe(true);
    expect(result.omissionReason).toBe("native_inspection_incomplete");
    expect(result.candidateText).toBeNull();
    expect(result.activity.native).toBe("incomplete");
    expect(result.activity.prohibited).toBe("unknown");
  });

  it("reports cleanup as unverified when the supervised worker cannot be collected", async () => {
    const { runtime } = createRuntime({
      closeOutcome: {
        kind: "cleanup_failed",
        reason: "group_survived",
        message: "worker group survived",
      },
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        worker.sendNativeEvent(turn.runId, 0, {
          type: "assistant",
          agent_id: sourceRef.ref,
          run_id: turn.runId,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
          },
        });
        worker.settle(turn.runId, "completed");
      },
    });
    const result = await runtime.captureHandoff(captureInput());
    expect(captureHandoffResultSchema.safeParse(result).success).toBe(true);
    expect(result.candidateText).toBeNull();
    expect(result.omissionReason).toBe("cleanup_unverified");
    expect(result.executionSettled).toBe(false);
    expect(result.cleanupFailure?.code).toBe("cleanup_unverified");

    const owner = new ManagedConversationRuntime("capture-conversation");
    let registered = false;
    owner.install(
      owner.beginCreation(),
      runtime,
      {
        backend: "cursor",
        modelSelection: selection,
        alignmentVersion: null,
        repeatableInstructions: [],
        instructionSelection: { autonomous: false },
      },
      {
        register() {
          registered = true;
        },
        unregister() {
          registered = false;
        },
      },
    );
    await expect(owner.close()).rejects.toThrow("cleanup failed");
    owner.reconcileClose();
    await expect(owner.close()).rejects.toThrow("cleanup failed");
    expect(owner.backend).toBe(runtime);
    expect(registered).toBe(true);
  });
});
