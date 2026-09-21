import { describe, expect, it } from "vitest";
import type {
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import type { ConversationBackendTurnInput } from "@/lib/agent-backends/conversation";
import {
  executeAgentCall,
  type AgentCallFacadeDeps,
} from "./agent-call-facade";
import type {
  AgentCallRequest,
  BackendCapabilityView,
} from "./agent-call-vocabulary";

const schema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};
const selection = {
  modelId: "gpt-5.2",
  parameters: { reasoning: "high", fast: "false" },
};
const view: BackendCapabilityView = {
  backend: "codex",
  continuationStrength: "synthetic_thread",
  structuredOutputEnforcement: "post_validation",
  mcpApplicationBoundary: "per_request",
  contextMetricsAvailable: true,
  nativeMidTurnAskUser: false,
};
const scope = {
  project: "example",
  session: "session",
  conversationId: "conversation",
};
const target = {
  scope: "session" as const,
  projectName: "example",
  sessionName: "session",
  conversationId: "conversation",
};
const request: Extract<AgentCallRequest, { kind: "task_run" }> = {
  kind: "task_run",
  backend: "codex",
  executionClass: "nongoverned-task",
  prompt: "Investigate the worktree and explain the result",
  outputSchema: schema,
  structuredOutputTurns: "work_then_format",
  systemInstructions: "Preserve the project rules",
  tooling: { servers: [] },
  imageRefs: [
    {
      index: 1,
      path: "/tmp/image.png",
      mediaType: "image/png",
      base64Data: "image",
    },
  ],
};
function turn(
  text: string,
  ref: string | null,
  extra: Partial<AgentTaskResult> = {},
): AgentTaskResult {
  return {
    text,
    backendRef: ref === null ? null : { backend: "codex", ref },
    usage: { inputTokens: 10, outputTokens: 3, costUsd: 0.1 },
    error: null,
    failure: null,
    timedOut: false,
    continuationDisposition: "retain",
    transcript: [{ backend: "codex", seq: 0, type: "message", raw: { text } }],
    ...extra,
  };
}
function tasks(results: AgentTaskResult[]) {
  const calls: AgentTaskRequest[] = [];
  const deps: AgentCallFacadeDeps = {
    resolveTaskRunner: () => ({
      runner: {
        backend: "codex",
        async run(input) {
          calls.push(input);
          const result = results.shift();
          if (!result) throw new Error("Unexpected extra turn");
          return result;
        },
      },
      capabilityView: view,
      workingDirectory: "/tmp/worktree",
      modelSelection: selection,
      ccSessionScope: scope,
      conversationTarget: target,
      artifacts: [{ kind: "report", relativePath: "report.md" }],
    }),
  };
  return { calls, deps };
}
describe("facade structured-output protocol", () => {
  it("defaults new structured callers to work then format", async () => {
    const { calls, deps } = tasks([
      turn("work", "work"),
      turn('{"summary":"formatted"}', "format"),
    ]);
    const result = await executeAgentCall(
      {
        kind: "task_run",
        backend: "codex",
        executionClass: "nongoverned-task",
        prompt: "Investigate",
        outputSchema: schema,
      },
      deps,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.outputSchema).toBeUndefined();
    expect(result.outcome.kind).toBe("completed");
  });

  it("does schema-free work, formats on its continuation, and repairs on the latest continuation", async () => {
    const results = [
      turn("I found the answer", "work"),
      turn('{"summary":3}', "format"),
      turn('{"summary":"answer"}', "repair"),
    ];
    const transcripts = results.flatMap((result) => result.transcript ?? []);
    const { calls, deps } = tasks([...results]);
    const result = await executeAgentCall(request, deps);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.outputSchema).toBeUndefined();
    expect(calls[0]?.prompt).toContain(request.prompt);
    expect(calls[1]?.resumeRef).toEqual({ backend: "codex", ref: "work" });
    expect(calls[2]?.resumeRef).toEqual({ backend: "codex", ref: "format" });
    for (const call of calls.slice(1)) {
      expect(call.outputSchema).toEqual(schema);
      expect(call.executionProfile).not.toBe("isolated-one-shot");
      expect(call.ccSessionScope).toEqual(scope);
      expect(call.conversationTarget).toEqual(target);
      expect(call.systemInstructions).toEqual([request.systemInstructions]);
      expect(call.tooling).toBeUndefined();
      expect(call.imagePaths).toBeUndefined();
      expect(call.prompt).toContain("Do not run tools");
    }
    expect(calls[2]?.prompt).toContain("$.summary");
    expect(result.backendRef).toEqual({ backend: "codex", ref: "repair" });
    expect(result.artifacts).toEqual([
      { kind: "report", relativePath: "report.md" },
    ]);
    expect(result.usage.inputTokens).toBe(30);
    expect(result.usage.costUsd).toBeCloseTo(0.3);
    expect(result.outcome).toMatchObject({
      kind: "completed",
      text: '{"summary":"answer"}',
      structuredOutput: { summary: "answer" },
      transcript: transcripts,
      parse: { repaired: true, repairAttempts: 1 },
    });
  });
  it("formats even when the work turn happened to produce valid JSON", async () => {
    const { calls, deps } = tasks([
      turn('{"summary":"work"}', "work"),
      turn('{"summary":"formatted"}', "format"),
    ]);
    const result = await executeAgentCall(request, deps);
    expect(calls).toHaveLength(2);
    expect(result.outcome).toMatchObject({
      kind: "completed",
      structuredOutput: { summary: "formatted" },
      parse: { source: "raw_json" },
    });
  });
  it.each(["missing", "clear"])(
    "refuses formatting after completed work with %s continuity",
    async (continuity) => {
      const { calls, deps } = tasks([
        turn("work", continuity === "missing" ? null : "invalid", {
          continuationDisposition: continuity === "clear" ? "clear" : "retain",
        }),
      ]);
      const result = await executeAgentCall(request, deps);
      expect(calls).toHaveLength(1);
      expect(result.outcome).toMatchObject({
        kind: "failed",
        error: { failureKind: "capability_unavailable" },
      });
    },
  );
  it("rejects isolated two-turn calls before dispatch", async () => {
    const { calls, deps } = tasks([turn("work", null)]);
    const result = await executeAgentCall(
      { ...request, executionProfile: "isolated-one-shot" as const },
      deps,
    );
    expect(calls).toHaveLength(0);
    expect(result.outcome).toMatchObject({
      kind: "failed",
      error: { failureKind: "capability_unavailable" },
    });
  });
  it("does not repair isolated single-turn output", async () => {
    const { calls, deps } = tasks([turn("bad", null)]);
    const result = await executeAgentCall(
      {
        ...request,
        structuredOutputTurns: "single",
        executionProfile: "isolated-one-shot" as const,
      },
      deps,
    );
    expect(calls).toHaveLength(1);
    expect(result.outcome).toMatchObject({
      kind: "failed",
      error: {
        failureKind: "schema_validation",
        backendDetails: { repairAttempts: 0 },
      },
    });
  });
  it("returns the last refused output and continuation with the complete transcript", async () => {
    const turns = [
      turn("work", "work"),
      turn("bad format", "format"),
      turn("bad repair", "repair", { continuationDisposition: "clear" }),
    ];
    const { calls, deps } = tasks([...turns]);
    const result = await executeAgentCall(request, deps);
    expect(calls).toHaveLength(3);
    expect(result.backendRef).toEqual({ backend: "codex", ref: "repair" });
    expect(result.continuationDisposition).toBe("clear");
    expect(result.outcome).toMatchObject({
      kind: "failed",
      transcript: turns.flatMap((item) => item.transcript ?? []),
      contentBlocks: [{ type: "text", text: "bad repair" }],
      error: {
        failureKind: "schema_validation",
        backendDetails: { repairAttempts: 1 },
      },
    });
  });
  it("returns failed work without formatting", async () => {
    const { calls, deps } = tasks([
      turn("partial", "work", { timedOut: true, error: "timeout" }),
    ]);
    const result = await executeAgentCall(request, deps);
    expect(calls).toHaveLength(1);
    expect(result.outcome).toMatchObject({
      kind: "failed",
      error: { failureKind: "timeout" },
    });
  });
  it("parks a question-ending conversation without formatting or validation", async () => {
    const calls: ConversationBackendTurnInput[] = [];
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        backend: "codex",
        executionClass: "ordinary-conversation",
        prompt: request.prompt,
        outputSchema: schema,
        structuredOutputTurns: "work_then_format",
      },
      {
        resolveConversationRuntime: () => ({
          runtime: {
            backend: "codex",
            status: "alive",
            modelSelection: selection,
            async sendTurn(input) {
              calls.push(input);
              return {
                backendRef: { backend: "codex", ref: "work" },
                costUsd: null,
                durationMs: 1,
                numTurns: 1,
                contextTokens: null,
                contextWindowMax: null,
                contentBlocks: [{ type: "text", text: "I asked a question" }],
                aborted: false,
                compacted: false,
                failure: null,
                continuationDisposition: "retain",
              };
            },
            async close() {},
          },
          capabilityView: view,
          modelSelection: selection,
          signal: new AbortController().signal,
          hasPendingQuestion: () => true,
        }),
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.outputFormat).toBeUndefined();
    expect(result.outcome.kind).toBe("completed");
  });
});
