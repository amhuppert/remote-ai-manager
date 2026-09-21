import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTaskRequest } from "../task";
import {
  createCursorTaskRunner,
  type CursorTaskRunnerDeps,
} from "./task-runner";
import {
  createScriptedTransport,
  type ScriptedWorkerOptions,
} from "./testing/scripted-worker";
import { translatePortableMcpToCursor } from "./mcp-translation";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import { decodeCursorTaskRef } from "./task-ref";
import { CURSOR_BACKGROUND_INSTRUCTIONS } from "./background-tasks";

const selection = { modelId: "composer-2.5", parameters: {} };
const request: AgentTaskRequest = {
  executionClass: "nongoverned-task",
  workingDirectory: "/repo",
  prompt: "Compute 17 times 19",
  modelSelection: selection,
  timeoutMs: 1000,
  autonomous: true,
};
function harness(
  worker: ScriptedWorkerOptions = {},
  deps: Partial<CursorTaskRunnerDeps> = {},
) {
  const transport = createScriptedTransport(worker);
  let id = 0;
  const runner = createCursorTaskRunner({
    transport,
    storePath: (id) => `/state/${id}`,
    resolveModel: async (selection) => ({ ok: true, selection }),
    translatePortableMcpToCursor,
    newRunId: () => `run-${++id}`,
    now: Date.now,
    stallTimeoutMs: 100,
    cancelSettleTimeoutMs: 5,
    ...deps,
  });
  return { runner, transport };
}
describe("Cursor task runner", () => {
  it("resumes a scoped conversation for a governed task using its original store and reference", async () => {
    const { runner, transport } = harness({ ref: "agent-conversation" });
    const resumeRef = { backend: "cursor" as const, ref: "agent-conversation" };
    const result = await runner.run({
      ...request,
      executionClass: "governed-execution",
      resumeRef,
      ccSessionScope: {
        project: "repo",
        session: "session-1",
        conversationId: "conversation-1",
      },
      fsWritePolicy: {
        mode: "allowlist",
        allowWrite: ["/scratch"],
        denyWrite: ["/repo"],
      },
    });
    expect(result.error).toBeNull();
    expect(result.backendRef).toEqual(resumeRef);
    expect(transport.startInputs[0]).toMatchObject({
      conversationId: "conversation-1",
      storePath: "/state/conversation-1",
    });
    expect(transport.workers[0]?.attachments[0]).toMatchObject({
      mode: "resume",
      ref: "agent-conversation",
    });
    expect(transport.workers[0]?.turns[0]?.input.promptText).toContain(
      '"/scratch"',
    );
  });

  it("reports cleanup failure when cancellation races worker startup", async () => {
    const controller = new AbortController();
    const transport = createScriptedTransport({
      closeOutcome: {
        kind: "cleanup_failed",
        reason: "group_survived",
        message: "worker group survived",
      },
    });
    const { runner } = harness(
      {},
      {
        transport: {
          ...transport,
          async start(input) {
            const result = await transport.start(input);
            controller.abort();
            return result;
          },
        },
      },
    );
    const result = await runner.run({ ...request, signal: controller.signal });
    expect(result.error).toMatch(/cleanup/i);
    expect(transport.workers[0]?.closeCount).toBe(1);
  });
  it("returns a failed result when isolated store deletion fails", async () => {
    const { runner } = harness(
      {},
      {
        async removeStore() {
          throw new Error("store removal denied");
        },
      },
    );
    const result = await runner.run({
      ...request,
      executionProfile: "isolated-one-shot",
    });
    expect(result.error).toContain("store removal denied");
    expect(result.backendRef).toBeNull();
  });
  it("delivers each continued task's instructions", async () => {
    const { runner, transport } = harness();
    const first = await runner.run(request);
    await runner.run({
      ...request,
      resumeRef: first.backendRef,
      systemInstructions: ["Use the SECOND_TASK convention."],
    });
    expect(transport.workers[1]?.turns[0]?.input.promptText).toContain(
      `\`\`\`\n## System Instructions\nUse the SECOND_TASK convention.\n\n${CURSOR_BACKGROUND_INSTRUCTIONS}\n\`\`\`\n\nCompute 17 times 19`,
    );
  });
  it("forwards local task images through the bounded Cursor image projection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-images-"));
    try {
      const file = path.join(root, "sample.png");
      await writeFile(file, Buffer.from("iVBORw0KGgo=", "base64"));
      const { runner, transport } = harness();
      await runner.run({ ...request, imagePaths: [file] });
      expect(transport.workers[0]?.turns[0]?.input.images).toEqual([
        { mimeType: "image/png", data: "iVBORw0KGgo=" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("bounds a silent attach even without a wall-clock task timeout", async () => {
    const { runner, transport } = harness(
      { onAttach() {} },
      { attachTimeoutMs: 10 },
    );
    const result = await runner.run({ ...request, timeoutMs: 0 });
    expect(result.failure?.kind).toBe("timeout");
    expect(transport.workers[0]?.closeCount).toBe(1);
  }, 500);
  it("removes the isolated store after the worker closes", async () => {
    const store = await mkdtemp(path.join(os.tmpdir(), "cursor-task-"));
    try {
      const { runner } = harness(
        {},
        {
          storePath: () => store,
          removeStore: () => rm(store, { recursive: true, force: true }),
        },
      );
      await runner.run({ ...request, executionProfile: "isolated-one-shot" });
      await expect(stat(store)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });
  it("clears malformed task references before opening a worker", async () => {
    const { runner, transport } = harness();
    const result = await runner.run({
      ...request,
      resumeRef: { backend: "cursor", ref: "corrupt" },
    });
    expect(result).toMatchObject({
      backendRef: null,
      continuationDisposition: "clear",
      failure: { kind: "stale_resume_ref" },
    });
    expect(transport.workers).toHaveLength(0);
  });
  it("times out a silent task when the inactivity bound is disabled", async () => {
    const { runner, transport } = harness({ onTurn() {} });
    const result = await runner.run({
      ...request,
      timeoutMs: 10,
      stallTimeoutMs: 0,
    });
    expect(result).toMatchObject({
      timedOut: true,
      failure: { kind: "timeout" },
    });
    expect(transport.workers[0]?.closeCount).toBe(1);
  });
  it("rejects incomplete model variants before starting a worker", async () => {
    const { runner, transport } = harness(
      {},
      {
        resolveModel: async () => ({
          ok: false,
          message: "missing model parameter fast",
        }),
      },
    );
    const result = await runner.run(request);
    expect(result.error).toContain("missing model parameter fast");
    expect(transport.workers).toHaveLength(0);
  });
  it("reports unverified worker cleanup as a failed task", async () => {
    const { runner } = harness({
      closeOutcome: {
        kind: "cleanup_failed",
        reason: "group_survived",
        message: "worker group survived",
      },
    });
    const result = await runner.run(request);
    expect(result.error).toMatch(/cleanup/i);
    expect(result.failure).not.toBeNull();
  });
  it("reports inactivity as a timeout and closes the worker", async () => {
    const { runner, transport } = harness({ onTurn() {} });
    const result = await runner.run({ ...request, stallTimeoutMs: 10 });
    expect(result).toMatchObject({
      timedOut: true,
      failure: { kind: "timeout" },
    });
    expect(transport.workers[0]?.closeCount).toBe(1);
  });
  it("repairs malformed structured output through a fresh isolated task", async () => {
    let count = 0;
    const { runner, transport } = harness({
      onTurn(turn, worker) {
        const text = ++count === 1 ? "bad json" : '{"answer":323}';
        worker.sendNativeEvent(turn.runId, 0, {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
        worker.settle(turn.runId, "completed");
      },
    });
    const result = await executeAgentCall(
      {
        kind: "task_run",
        backend: "cursor",
        executionClass: "nongoverned-task",
        prompt: request.prompt,
        outputSchema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
      {
        resolveTaskRunner: () => ({
          runner,
          workingDirectory: "/repo",
          modelSelection: selection,
          autonomous: true,
          capabilityView: {
            backend: "cursor",
            continuationStrength: "precise_session",
            structuredOutputEnforcement: "post_validation",
            mcpApplicationBoundary: "between_turns",
            contextMetricsAvailable: false,
            nativeMidTurnAskUser: false,
          },
        }),
      },
    );
    expect(result.outcome).toMatchObject({
      kind: "completed",
      structuredOutput: { answer: 323 },
      parse: { repaired: true, repairAttempts: 1 },
    });
    expect(
      transport.startInputs.map((input) => input.executionProfile),
    ).toEqual(["standard", "isolated-one-shot"]);
    expect(transport.startInputs[1]?.target).toBeNull();
    expect(result.backendRef).toBeTruthy();
  });
  it("resumes the same task store with a fresh worker after the runner is recreated", async () => {
    const first = harness();
    const result = await first.runner.run(request);
    expect(result.backendRef).toBeTruthy();
    if (!result.backendRef) return;
    const resumed = harness();
    await resumed.runner.run({ ...request, resumeRef: result.backendRef });
    expect(resumed.transport.startInputs[0]?.storePath).toBe(
      first.transport.startInputs[0]?.storePath,
    );
    expect(resumed.transport.workers[0]?.attachments[0]?.ref).toBe(
      decodeCursorTaskRef(result.backendRef).agentId,
    );
  });
  it("uses a fresh isolated store and drops resume, CC identity and portable tooling", async () => {
    const { runner, transport } = harness();
    const first = await runner.run(request);
    const second = await runner.run({
      ...request,
      executionProfile: "isolated-one-shot",
      resumeRef: first.backendRef,
      ccSessionScope: { project: "p", session: "s", conversationId: "c" },
      tooling: { portableMcp: { servers: [] } },
    });
    expect(second.backendRef).toBeNull();
    expect(second.continuationDisposition).toBe("clear");
    expect(transport.startInputs[1]?.storePath).not.toBe(
      transport.startInputs[0]?.storePath,
    );
    expect(transport.startInputs[1]?.target).toBeNull();
    expect(transport.workers[1]?.attachments[0]).toMatchObject({
      mode: "create",
      mcpServers: {},
    });
  });
  it.each([{ requiresPrivilegedInstructions: true }])(
    "refuses an explicitly required native instruction channel: %j",
    async (policy) => {
      const { runner, transport } = harness();
      const result = await runner.run({ ...request, ...policy });
      expect(result.error).toContain("privileged instructions");
      expect(transport.workers).toHaveLength(0);
    },
  );

  it.each([
    { executionClass: "governed-execution" as const },
    {
      fsWritePolicy: {
        mode: "allowlist" as const,
        allowWrite: ["/repo"],
        denyWrite: [],
      },
    },
    { sandboxMode: "read-only" as const },
    { networkAccessEnabled: false },
    { approvalPolicy: "on-request" as const },
    { webSearchMode: "disabled" as const },
  ])("runs with best-effort controls: %j", async (policy) => {
    const { runner, transport } = harness();
    const result = await runner.run({ ...request, ...policy });
    expect(result.error).toBeNull();
    expect(transport.workers).toHaveLength(1);
  });

  it("delivers validator path and network limits in the governed task prompt", async () => {
    const { runner, transport } = harness();
    const result = await runner.run({
      ...request,
      executionClass: "governed-execution",
      fsWritePolicy: {
        mode: "allowlist",
        allowWrite: ["/scratch"],
        denyWrite: ["/repo"],
      },
      networkAccessEnabled: false,
    });
    expect(result.error).toBeNull();
    const prompt = transport.workers[0]?.turns[0]?.input.promptText;
    expect(prompt).toContain('"/scratch"');
    expect(prompt).toContain('"/repo"');
    expect(prompt).toContain("Do not use the network");
  });
  it("cancels while waiting for attach without leaving a worker", async () => {
    const controller = new AbortController();
    const { runner, transport } = harness({
      onAttach() {
        controller.abort();
      },
    });
    const result = await runner.run({ ...request, signal: controller.signal });
    expect(result.timedOut).toBe(true);
    expect(transport.workers[0]?.closeCount).toBe(1);
  }, 500);
  it("disables the stall bound when zero is requested", async () => {
    const { runner } = harness({
      async onTurn(turn, worker) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        worker.settle(turn.runId, "completed");
      },
    });
    expect(
      (await runner.run({ ...request, stallTimeoutMs: 0 })).error,
    ).toBeNull();
  });
  it("returns the final answer and deduplicated native transcript, then closes its worker", async () => {
    const { runner, transport } = harness({
      onTurn(turn, worker) {
        const event = {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "323" }],
          },
        };
        worker.sendInputAccepted(turn.runId);
        worker.sendNativeEvent(turn.runId, 0, event);
        worker.sendNativeEvent(turn.runId, 0, event);
        worker.sendUsage(turn.runId, {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 12,
        });
        worker.settle(turn.runId, "completed");
      },
    });
    const result = await runner.run(request);
    expect(result).toMatchObject({
      text: "323",
      error: null,
      timedOut: false,
      failure: null,
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(result.backendRef?.backend).toBe("cursor");
    expect(result.transcript).toHaveLength(1);
    const started = transport.startInputs[0];
    expect(started).toBeDefined();
    if (started) expect(transport.find(started.conversationId)).toBeNull();
  });
  it("cancels a running task and closes the worker before returning", async () => {
    const signal = new AbortController();
    const { runner, transport } = harness({
      onTurn() {
        signal.abort();
      },
    });
    const result = await runner.run({ ...request, signal: signal.signal });
    expect(result.timedOut).toBe(true);
    expect(transport.workers[0]?.cancelledRunIds).toHaveLength(1);
    expect(transport.workers[0]?.closeCount).toBe(1);
  });
  it("returns provider failure classification and clears missing references", async () => {
    const { runner } = harness({
      onTurn(turn, worker) {
        worker.settle(turn.runId, "failed", {
          name: "AgentNotFoundError",
          code: "agent_not_found",
          status: 404,
          message: "missing agent",
        });
      },
    });
    const result = await runner.run(request);
    expect(result.failure?.kind).toBe("stale_resume_ref");
    expect(result.continuationDisposition).toBe("clear");
    expect(result.backendRef).toBeNull();
  });
});

describe("Cursor task billed cost", () => {
  const tokens = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    totalTokens: 120,
  };
  const priced = {
    usage: tokens,
    cost: { rawCostCents: 4, chargedCents: 4 },
    runs: [
      {
        runId: "uuid-1",
        usage: tokens,
        cost: { rawCostCents: 4, chargedCents: 4 },
      },
    ],
  };

  it("carries a cost settled at turn end on the task result", async () => {
    const { runner } = harness({
      onTurn: (turn, worker) => {
        worker.sendInputAccepted(turn.runId);
        worker.sendUsage(turn.runId, tokens);
        worker.sendBilling(turn.runId, null, priced);
        worker.settle(turn.runId, "completed");
      },
    });
    const result = await runner.run(request);
    expect(result.error).toBeNull();
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 5,
      costUsd: 0.04,
    });
  });

  it("waits within its bound for a cost the provider prices late", async () => {
    const { runner, transport } = harness(
      {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendUsage(turn.runId, tokens);
          worker.sendBilling(turn.runId, null, {
            ...priced,
            cost: null,
            runs: [{ runId: "uuid-1", usage: tokens, cost: null }],
          });
          worker.settle(turn.runId, "completed");
        },
        onUsageQuery: (queryId, worker) => {
          worker.sendBilling(null, queryId, priced);
        },
      },
      { billingSettleDelaysMs: [1, 1], billingSettleTimeoutMs: 500 },
    );
    const result = await runner.run(request);
    expect(result.usage?.costUsd).toBe(0.04);
    expect(transport.workers[0]?.usageQueries).toHaveLength(1);
  });

  it("gives up at the bound and leaves the cost unknown, never estimated", async () => {
    const { runner } = harness(
      {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendUsage(turn.runId, tokens);
          worker.sendBilling(turn.runId, null, {
            ...priced,
            cost: null,
            runs: [{ runId: "uuid-1", usage: tokens, cost: null }],
          });
          worker.settle(turn.runId, "completed");
        },
        onUsageQuery: (queryId, worker) => {
          worker.sendBilling(null, queryId, {
            ...priced,
            cost: null,
            runs: [{ runId: "uuid-1", usage: tokens, cost: null }],
          });
        },
      },
      { billingSettleDelaysMs: [1, 1], billingSettleTimeoutMs: 500 },
    );
    const result = await runner.run(request);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 5,
    });
  });

  it("does not wait at all when the provider refused billing for the account", async () => {
    const { runner, transport } = harness(
      {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendUsage(turn.runId, tokens);
          worker.sendBillingFailure(turn.runId, null, "unavailable", {
            name: "UnknownAgentError",
            code: "feature_unavailable",
            status: 403,
            message: "This feature is not available for your account",
          });
          worker.settle(turn.runId, "completed");
        },
      },
      { billingSettleDelaysMs: [1], billingSettleTimeoutMs: 500 },
    );
    const result = await runner.run(request);
    expect(result.usage?.costUsd).toBeUndefined();
    expect(transport.workers[0]?.usageQueries).toEqual([]);
  });
});
