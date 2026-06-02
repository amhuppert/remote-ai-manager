import { describe, expect, it } from "vitest";

import { createCollaborationProductionCallAgent } from "./agent-caller-production";
import {
  COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA,
  type CollaborationInitialDraftOutput,
} from "./types";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import type {
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import type {
  ConversationBackendFactory,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import type { AgentCallRequest } from "@/lib/workflows/primitives/agent-call-vocabulary";

function draftOutput(round: number): CollaborationInitialDraftOutput {
  return {
    kind: "initial_draft",
    agent: "agent_one",
    narrative: `# Round ${round} draft`,
    report: `memory-bank/collaboration/round-${round}/report.md`,
    supporting: [],
    assumptions: [],
    keyClaims: [
      {
        id: `claim-${round}`,
        claim: `round ${round} key claim`,
      },
    ],
  };
}

describe("createCollaborationProductionCallAgent", () => {
  it("passes the originating conversationId to the Claude runtime as mcpScopeConversationId so the session MCP server resolves to a real CC conversation", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-mcp-scope",
      laneId: "claude",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "claude" },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const createRuntimeInputs: Array<
      Parameters<ConversationBackendFactory["createRuntime"]>[0]
    > = [];
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input): Promise<ConversationBackendRuntime> {
        createRuntimeInputs.push(input);
        const runtime: ConversationBackendRuntime = {
          backend: "claude",
          status: "alive",
          capabilities: {
            queueWhileRunning: true,
            askUserQuestion: true,
            preciseFork: true,
            portableMcpAtStart: true,
            portableMcpBetweenTurns: true,
            contextWindowMetrics: true,
          },
          modelId: undefined,
          reasoningEffort: undefined,
          outputFormat: undefined,
          applyPortableMcpConfig: async () => ({
            disposition: "applied_now",
            droppedServerIds: [],
            droppedFields: [],
            errors: {},
          }),
          async sendTurn(): Promise<ConversationBackendTurnResult> {
            const structuredOutput = draftOutput(1);
            return {
              backendRef: { backend: "claude", sessionId: "real-session-1" },
              costUsd: null,
              durationMs: 10,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [
                { type: "text", text: structuredOutput.narrative },
              ],
              structuredOutput,
              aborted: false,
              error: null,
            };
          },
          close: () => undefined,
        };
        return runtime;
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-mcp-scope",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "real-conv-uuid-1",
      laneService,
      getConversationBackendFactory: () => factory,
    });

    await callAgent({
      kind: "conversation_turn",
      backend: "claude",
      prompt: "round 1",
      laneRef: { workflowId: "wf-mcp-scope", laneId: "claude" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    expect(createRuntimeInputs[0]?.mcpScopeConversationId).toBe(
      "real-conv-uuid-1",
    );
  });

  it("starts a fresh Claude conversation on the first lane call and resumes the SDK-returned session later", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-claude-continuity",
      laneId: "claude",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "claude" },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const persistedRefs: unknown[] = [];
    let callCount = 0;
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input): Promise<ConversationBackendRuntime> {
        persistedRefs.push(input.persistedRef);
        const runtime: ConversationBackendRuntime = {
          backend: "claude",
          status: "alive",
          capabilities: {
            queueWhileRunning: true,
            askUserQuestion: true,
            preciseFork: true,
            portableMcpAtStart: true,
            portableMcpBetweenTurns: true,
            contextWindowMetrics: true,
          },
          modelId: undefined,
          reasoningEffort: undefined,
          outputFormat: undefined,
          applyPortableMcpConfig: async () => ({
            disposition: "applied_now",
            droppedServerIds: [],
            droppedFields: [],
            errors: {},
          }),
          async sendTurn(
            _turn: ConversationBackendTurnInput,
          ): Promise<ConversationBackendTurnResult> {
            callCount += 1;
            const structuredOutput: CollaborationInitialDraftOutput =
              draftOutput(callCount);
            return {
              backendRef: {
                backend: "claude",
                sessionId: `real-session-${callCount}`,
              },
              costUsd: null,
              durationMs: 10,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [
                { type: "text", text: structuredOutput.narrative },
              ],
              structuredOutput,
              aborted: false,
              error: null,
            };
          },
          close: () => undefined,
        };
        return runtime;
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-claude-continuity",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      getConversationBackendFactory: () => factory,
    });

    const request = (round: number): AgentCallRequest => ({
      kind: "conversation_turn",
      backend: "claude",
      prompt: `round ${round}`,
      laneRef: { workflowId: "wf-claude-continuity", laneId: "claude" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    await callAgent(request(1));
    await callAgent(request(2));

    expect(persistedRefs[0]).toBeNull();
    expect(persistedRefs[1]).toEqual({
      backend: "claude",
      sessionId: "real-session-1",
    });
  });

  it("passes the lane outputSchema to the Claude runtime factory as SDK outputFormat", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-claude-output-format",
      laneId: "claude",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "claude" },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const outputFormats: unknown[] = [];
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input): Promise<ConversationBackendRuntime> {
        outputFormats.push(input.outputFormat);
        const runtime: ConversationBackendRuntime = {
          backend: "claude",
          status: "alive",
          capabilities: {
            queueWhileRunning: true,
            askUserQuestion: true,
            preciseFork: true,
            portableMcpAtStart: true,
            portableMcpBetweenTurns: true,
            contextWindowMetrics: true,
          },
          modelId: undefined,
          reasoningEffort: undefined,
          outputFormat: input.outputFormat,
          applyPortableMcpConfig: async () => ({
            disposition: "applied_now",
            droppedServerIds: [],
            droppedFields: [],
            errors: {},
          }),
          async sendTurn(): Promise<ConversationBackendTurnResult> {
            const structuredOutput: CollaborationInitialDraftOutput =
              draftOutput(1);
            return {
              backendRef: {
                backend: "claude",
                sessionId: "real-session-output-format",
              },
              costUsd: null,
              durationMs: 10,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [
                { type: "text", text: structuredOutput.narrative },
              ],
              structuredOutput,
              aborted: false,
              error: null,
            };
          },
          close: () => undefined,
        };
        return runtime;
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-claude-output-format",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      getConversationBackendFactory: () => factory,
    });

    const schema =
      COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >;

    await callAgent({
      kind: "conversation_turn",
      backend: "claude",
      prompt: "round 1",
      laneRef: { workflowId: "wf-claude-output-format", laneId: "claude" },
      writeCapability: "write_capable",
      outputSchema: schema,
    });

    expect(outputFormats[0]).toEqual({
      type: "json_schema",
      schema,
    });
  });

  it("starts a fresh Codex thread on the first lane call and resumes the SDK-returned thread later when the lane has continuity enabled (collaboration mode default)", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-codex-continuity",
      laneId: "codex",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "codex" },
      metrics: { backend: "codex", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const taskRequests: AgentTaskRequest[] = [];
    let callCount = 0;
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        taskRequests.push(request);
        callCount += 1;
        const structuredOutput = draftOutput(callCount);
        return {
          backendRef: {
            backend: "codex",
            threadId: `real-thread-${callCount}`,
          },
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage: null,
          error: null,
          timedOut: false,
        };
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-codex-continuity",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      getTaskRunner: () => runner,
    });

    const request = (round: number): AgentCallRequest => ({
      kind: "task_run",
      backend: "codex",
      prompt: `round ${round}`,
      laneRef: { workflowId: "wf-codex-continuity", laneId: "codex" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    await callAgent(request(1));
    await callAgent(request(2));

    expect(taskRequests[0]?.resumeRef).toBeUndefined();
    expect(taskRequests[1]?.resumeRef).toEqual({
      backend: "codex",
      threadId: "real-thread-1",
    });
    expect(taskRequests[1]?.prompt).toBe("round 2");
  });

  it("does NOT pass a Codex resumeRef when the lane policy disables continuity, even if a prior threadId is recorded", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-codex-no-continuity",
      laneId: "codex",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: false },
      backendState: { backend: "codex" },
      metrics: { backend: "codex", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const taskRequests: AgentTaskRequest[] = [];
    let callCount = 0;
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        taskRequests.push(request);
        callCount += 1;
        const structuredOutput = draftOutput(callCount);
        return {
          backendRef: {
            backend: "codex",
            threadId: `real-thread-${callCount}`,
          },
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage: null,
          error: null,
          timedOut: false,
        };
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-codex-no-continuity",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      getTaskRunner: () => runner,
    });

    const request = (round: number): AgentCallRequest => ({
      kind: "task_run",
      backend: "codex",
      prompt: `round ${round}`,
      laneRef: { workflowId: "wf-codex-no-continuity", laneId: "codex" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    await callAgent(request(1));
    await callAgent(request(2));

    expect(taskRequests[0]?.resumeRef).toBeUndefined();
    expect(taskRequests[1]?.resumeRef).toBeUndefined();
  });

  it("retries a stale Claude resume once with a fresh runtime", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-claude-stale",
      laneId: "claude",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "claude" },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const persistedRefs: unknown[] = [];
    let sendTurnCount = 0;
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input): Promise<ConversationBackendRuntime> {
        persistedRefs.push(input.persistedRef);
        const runtime: ConversationBackendRuntime = {
          backend: "claude",
          status: "alive",
          capabilities: {
            queueWhileRunning: true,
            askUserQuestion: true,
            preciseFork: true,
            portableMcpAtStart: true,
            portableMcpBetweenTurns: true,
            contextWindowMetrics: true,
          },
          modelId: undefined,
          reasoningEffort: undefined,
          outputFormat: undefined,
          applyPortableMcpConfig: async () => ({
            disposition: "applied_now",
            droppedServerIds: [],
            droppedFields: [],
            errors: {},
          }),
          async sendTurn(): Promise<ConversationBackendTurnResult> {
            sendTurnCount += 1;
            if (sendTurnCount === 2) {
              return {
                backendRef: { backend: "claude", sessionId: "stale-session" },
                costUsd: null,
                durationMs: 10,
                numTurns: 1,
                contextTokens: null,
                contextWindowMax: null,
                contentBlocks: [],
                aborted: false,
                error: "resume session not found",
              };
            }
            const structuredOutput: CollaborationInitialDraftOutput =
              draftOutput(sendTurnCount);
            return {
              backendRef: {
                backend: "claude",
                sessionId:
                  sendTurnCount === 1 ? "stale-session" : "fresh-session",
              },
              costUsd: null,
              durationMs: 10,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [
                { type: "text", text: structuredOutput.narrative },
              ],
              structuredOutput,
              aborted: false,
              error: null,
            };
          },
          close: () => undefined,
        };
        return runtime;
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-claude-stale",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      getConversationBackendFactory: () => factory,
    });

    const request = (round: number): AgentCallRequest => ({
      kind: "conversation_turn",
      backend: "claude",
      prompt: `round ${round}`,
      laneRef: { workflowId: "wf-claude-stale", laneId: "claude" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    await callAgent(request(1));
    const result = await callAgent(request(2));

    expect(result.backendRef).toEqual({
      backend: "claude",
      sessionId: "fresh-session",
    });
    expect(persistedRefs).toEqual([
      null,
      { backend: "claude", sessionId: "stale-session" },
      null,
    ]);
  });

  it("applies the configured codex model and reasoning effort to a codex task_run request that carries none", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-codex-model",
      laneId: "codex",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "codex" },
      metrics: { backend: "codex", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const taskRequests: AgentTaskRequest[] = [];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        taskRequests.push(request);
        const structuredOutput = draftOutput(1);
        return {
          backendRef: { backend: "codex", threadId: "real-thread-1" },
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage: null,
          error: null,
          timedOut: false,
        };
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-codex-model",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      getTaskRunner: () => runner,
      codexModel: "gpt-5.5",
      codexReasoningEffort: "high",
    });

    await callAgent({
      kind: "task_run",
      backend: "codex",
      prompt: "round 1",
      laneRef: { workflowId: "wf-codex-model", laneId: "codex" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    expect(taskRequests[0]?.modelId).toBe("gpt-5.5");
    expect(taskRequests[0]?.reasoningEffort).toBe("high");
  });

  it("prefers an explicit request modelId over the configured codex model", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-codex-model-override",
      laneId: "codex",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "codex" },
      metrics: { backend: "codex", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const taskRequests: AgentTaskRequest[] = [];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        taskRequests.push(request);
        const structuredOutput = draftOutput(1);
        return {
          backendRef: { backend: "codex", threadId: "real-thread-1" },
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage: null,
          error: null,
          timedOut: false,
        };
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-codex-model-override",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      getTaskRunner: () => runner,
      codexModel: "gpt-5.5",
    });

    await callAgent({
      kind: "task_run",
      backend: "codex",
      prompt: "round 1",
      modelId: "gpt-5.4",
      laneRef: { workflowId: "wf-codex-model-override", laneId: "codex" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    expect(taskRequests[0]?.modelId).toBe("gpt-5.4");
  });
});
