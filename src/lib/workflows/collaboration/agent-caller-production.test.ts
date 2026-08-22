import { describe, expect, it, vi } from "vitest";

import {
  createCollaborationProductionCallAgent,
  type CollaborationLaneAgentConfig,
  type CollaborationLaneAgentsInput,
} from "./agent-caller-production";
import {
  COLLABORATION_FORMAT_TURN_INSTRUCTION,
  COLLABORATION_PROSE_TURN_INSTRUCTION,
  COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
} from "./prompt-builders";
import {
  COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA,
  type CollaborationInitialDraftContent,
} from "./types";
import {
  buildLaneSystemInstructions,
  prefixPromptWithTicketBlock,
  CHARTER_SUPERSEDES_NOTICE,
  type CollaborationSessionContext,
} from "./session-context";
import { createEnvCapturingCodexTaskRunner } from "@/lib/agent-backends/testing/fake-codex-provider";
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

/**
 * Both flow agents' lane configs with the default backend pairing
 * (agent_one=claude, agent_two=codex) and concrete models — the production
 * caller requires a resolved model per lane. Per-test overrides layer the
 * settings the test asserts on.
 */
function collabAgents(
  overrides: {
    agent_one?: Partial<CollaborationLaneAgentConfig>;
    agent_two?: Partial<CollaborationLaneAgentConfig>;
  } = {},
): CollaborationLaneAgentsInput {
  return {
    agent_one: {
      backend: "claude",
      model: "claude-lane-model",
      ...overrides.agent_one,
    },
    agent_two: {
      backend: "codex",
      model: "codex-lane-model",
      ...overrides.agent_two,
    },
  };
}

// The format turn emits model-authored content only — the orchestrator owns
// kind/agent/round and each artifact's round/agent/phase and injects them after
// parsing, so they are absent here (and would fail the trimmed json_schema).
function draftOutput(round: number): CollaborationInitialDraftContent {
  return {
    summary: `# Round ${round} draft`,
    artifacts: [
      {
        id: "main",
        artifact_type: "main_response",
        path: `memory-bank/collaboration/wf-fixture/round-0/agent_one/initial_draft/main.md`,
        summary: `Round ${round} draft artifact.`,
      },
    ],
    assumptions: [],
    key_claims: [
      {
        id: `claim-${round}`,
        claim: `round ${round} key claim`,
      },
    ],
  };
}

/**
 * Claude conversation factory double that records every `createRuntime` input
 * into the provided sink and replies with a valid initial draft, so tests can
 * assert how the production caller resolves the runtime's model/effort.
 */
function makeRecordingClaudeFactory(
  createRuntimeInputs: Array<
    Parameters<ConversationBackendFactory["createRuntime"]>[0]
  >,
): ConversationBackendFactory {
  return {
    backend: "claude",
    async createRuntime(input): Promise<ConversationBackendRuntime> {
      createRuntimeInputs.push(input);
      return {
        backend: "claude",
        status: "alive",
        modelId: input.modelId,
        reasoningEffort: input.reasoningEffort,
        outputFormat: input.outputFormat,
        alignmentVersion: input.alignmentVersion ?? null,
        applyPortableMcpConfig: async () => ({
          disposition: "applied_now",
          droppedServerIds: [],
          droppedFields: [],
          errors: {},
        }),
        async sendTurn(): Promise<ConversationBackendTurnResult> {
          const structuredOutput = draftOutput(1);
          return {
            backendRef: { backend: "claude", ref: "real-session-1" },
            costUsd: null,
            durationMs: 10,
            numTurns: 1,
            contextTokens: null,
            contextWindowMax: null,
            contentBlocks: [{ type: "text", text: structuredOutput.summary }],
            structuredOutput,
            aborted: false,
            compacted: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
        close: async () => {},
      };
    },
  };
}

describe("createCollaborationProductionCallAgent", () => {
  it("passes the originating conversationId to the Claude runtime as ccScopeConversationId so cctl inside the lane resolves a real CC conversation", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-mcp-scope",
      laneId: "agent_one",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
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
          modelId: undefined,
          reasoningEffort: undefined,
          outputFormat: undefined,
          alignmentVersion: null,
          applyPortableMcpConfig: async () => ({
            disposition: "applied_now",
            droppedServerIds: [],
            droppedFields: [],
            errors: {},
          }),
          async sendTurn(): Promise<ConversationBackendTurnResult> {
            const structuredOutput = draftOutput(1);
            return {
              backendRef: { backend: "claude", ref: "real-session-1" },
              costUsd: null,
              durationMs: 10,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [{ type: "text", text: structuredOutput.summary }],
              structuredOutput,
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
          close: async () => {},
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
      agents: collabAgents(),
      getConversationBackendFactory: () => factory,
    });

    await callAgent({
      kind: "conversation_turn",
      backend: "claude",
      prompt: "round 1",
      laneRef: { workflowId: "wf-mcp-scope", laneId: "agent_one" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    expect(createRuntimeInputs[0]?.ccScopeConversationId).toBe(
      "real-conv-uuid-1",
    );
    // …and carries no conversation capability, so the lane holds no launch
    // authority (D7 D11/D12). The redirect above is exactly what makes this
    // runtime indistinguishable from its origin by id alone, which is why
    // authority is minted at spawn and never derived from that id.
    expect(createRuntimeInputs[0]?.conversationCapability).toBe(undefined);
  });

  it("starts a fresh Claude conversation on the first lane call and resumes the SDK-returned session later", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-claude-continuity",
      laneId: "agent_one",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
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
          modelId: undefined,
          reasoningEffort: undefined,
          outputFormat: undefined,
          alignmentVersion: null,
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
            const structuredOutput: CollaborationInitialDraftContent =
              draftOutput(callCount);
            return {
              backendRef: {
                backend: "claude",
                ref: `real-session-${callCount}`,
              },
              costUsd: null,
              durationMs: 10,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [{ type: "text", text: structuredOutput.summary }],
              structuredOutput,
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
          close: async () => {},
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
      agents: collabAgents(),
      getConversationBackendFactory: () => factory,
    });

    const request = (round: number): AgentCallRequest => ({
      kind: "conversation_turn",
      backend: "claude",
      prompt: `round ${round}`,
      laneRef: { workflowId: "wf-claude-continuity", laneId: "agent_one" },
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
      ref: "real-session-1",
    });
  });

  it("passes the lane outputSchema to the Claude runtime contract on the format turn, leaving the prose work turn unconstrained", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-claude-output-format",
      laneId: "agent_one",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
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
          modelId: undefined,
          reasoningEffort: undefined,
          outputFormat: input.outputFormat,
          alignmentVersion: input.alignmentVersion ?? null,
          applyPortableMcpConfig: async () => ({
            disposition: "applied_now",
            droppedServerIds: [],
            droppedFields: [],
            errors: {},
          }),
          async sendTurn(): Promise<ConversationBackendTurnResult> {
            const structuredOutput: CollaborationInitialDraftContent =
              draftOutput(1);
            return {
              backendRef: {
                backend: "claude",
                ref: "real-session-output-format",
              },
              costUsd: null,
              durationMs: 10,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [{ type: "text", text: structuredOutput.summary }],
              structuredOutput,
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
          close: async () => {},
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
      agents: collabAgents(),
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
      laneRef: { workflowId: "wf-claude-output-format", laneId: "agent_one" },
      writeCapability: "write_capable",
      outputSchema: schema,
    });

    // The prose work turn runs without a schema contract; the format turn
    // carries the provider-neutral json_schema outputFormat.
    expect(outputFormats[0]).toBeUndefined();
    expect(outputFormats[1]).toEqual({
      type: "json_schema",
      schema,
    });
  });

  it("starts a fresh Codex thread on the first lane call and resumes the SDK-returned thread later when the lane has continuity enabled (collaboration mode default)", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-codex-continuity",
      laneId: "agent_two",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
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
            ref: `real-thread-${callCount}`,
          },
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
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
      agents: collabAgents(),
      getTaskRunner: () => runner,
    });

    const request = (round: number): AgentCallRequest => ({
      kind: "task_run",
      backend: "codex",
      prompt: `round ${round}`,
      laneRef: { workflowId: "wf-codex-continuity", laneId: "agent_two" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    await callAgent(request(1));
    await callAgent(request(2));

    // Each schema-bearing call is two turns (prose work + JSON format), so two
    // rounds produce four task runs. Continuity threads the resume ref through
    // all of them.
    expect(taskRequests).toHaveLength(4);
    // Round 1 work turn starts a fresh thread.
    expect(taskRequests[0]?.resumeRef).toBeUndefined();
    expect(taskRequests[0]?.prompt).toBe("round 1");
    // Round 1 format turn resumes the work turn's thread.
    expect(taskRequests[1]?.resumeRef).toEqual({
      backend: "codex",
      ref: "real-thread-1",
    });
    expect(taskRequests[1]?.prompt).toBe(COLLABORATION_FORMAT_TURN_INSTRUCTION);
    // Round 2 work turn resumes the latest recorded thread.
    expect(taskRequests[2]?.resumeRef).toEqual({
      backend: "codex",
      ref: "real-thread-2",
    });
    expect(taskRequests[2]?.prompt).toBe("round 2");
  });

  it("does NOT pass a Codex resumeRef when the lane policy disables continuity, even if a prior threadId is recorded", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-codex-no-continuity",
      laneId: "agent_two",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: false },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
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
            ref: `real-thread-${callCount}`,
          },
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
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
      agents: collabAgents(),
      getTaskRunner: () => runner,
    });

    const request = (round: number): AgentCallRequest => ({
      kind: "task_run",
      backend: "codex",
      prompt: `round ${round}`,
      laneRef: { workflowId: "wf-codex-no-continuity", laneId: "agent_two" },
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
      laneId: "agent_one",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
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
          modelId: undefined,
          reasoningEffort: undefined,
          outputFormat: undefined,
          alignmentVersion: null,
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
                backendRef: { backend: "claude", ref: "stale-session" },
                costUsd: null,
                durationMs: 10,
                numTurns: 1,
                contextTokens: null,
                contextWindowMax: null,
                contentBlocks: [],
                aborted: false,
                compacted: false,
                failure: {
                  kind: "stale_resume_ref",
                  message: "resume session not found",
                  retryable: true,
                },
                continuationDisposition: "retain",
              };
            }
            const structuredOutput: CollaborationInitialDraftContent =
              draftOutput(sendTurnCount);
            return {
              backendRef: {
                backend: "claude",
                ref: sendTurnCount === 1 ? "stale-session" : "fresh-session",
              },
              costUsd: null,
              durationMs: 10,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [{ type: "text", text: structuredOutput.summary }],
              structuredOutput,
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
          close: async () => {},
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
      agents: collabAgents(),
      getConversationBackendFactory: () => factory,
    });

    const request = (round: number): AgentCallRequest => ({
      kind: "conversation_turn",
      backend: "claude",
      prompt: `round ${round}`,
      laneRef: { workflowId: "wf-claude-stale", laneId: "agent_one" },
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
      ref: "fresh-session",
    });
    // Round 1 work turn creates fresh (null); the format turn resumes that
    // session (stale-session), the resume fails as stale, and the caller
    // recovers once with a fresh runtime (null) → fresh-session. Round 2
    // resumes the recovered session for both of its turns.
    expect(persistedRefs).toEqual([
      null,
      { backend: "claude", ref: "stale-session" },
      null,
      { backend: "claude", ref: "fresh-session" },
      { backend: "claude", ref: "fresh-session" },
    ]);
  });

  it("applies the configured codex model and reasoning effort to a codex task_run request that carries none", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-codex-model",
      laneId: "agent_two",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const taskRequests: AgentTaskRequest[] = [];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        taskRequests.push(request);
        const structuredOutput = draftOutput(1);
        return {
          backendRef: { backend: "codex", ref: "real-thread-1" },
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
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
      agents: collabAgents({
        agent_two: {
          model: "gpt-5.5",
          reasoningEffort: "high",
          timeoutMs: 75_000,
          stallTimeoutMs: 25_000,
        },
      }),
      getTaskRunner: () => runner,
    });

    await callAgent({
      kind: "task_run",
      backend: "codex",
      prompt: "round 1",
      laneRef: { workflowId: "wf-codex-model", laneId: "agent_two" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    expect(taskRequests[0]?.modelId).toBe("gpt-5.5");
    expect(taskRequests[0]?.reasoningEffort).toBe("high");
    expect(taskRequests[0]?.timeoutMs).toBe(75_000);
    expect(taskRequests[0]?.stallTimeoutMs).toBe(25_000);
  });

  it.each([false, true])(
    "applies the codex lane's configured fast-mode choice of %s to every Codex collaboration task turn",
    async (codexFastMode) => {
      const laneService = createLaneService({
        store: createInMemoryLaneStore(),
      });
      await laneService.initialize({
        workflowId: "wf-codex-fast-mode",
        laneId: "agent_two",
        backend: "codex",
        writeCapability: "write_capable",
        policy: { continuityEnabled: true },
        ref: null,
        metrics: { rotateBeforeNextTurn: false },
        lastUsedAt: "2026-04-28T10:00:00.000Z",
      });

      const taskRequests: AgentTaskRequest[] = [];
      const runner: AgentTaskRunner = {
        backend: "codex",
        async run(request): Promise<AgentTaskResult> {
          taskRequests.push(request);
          const structuredOutput = draftOutput(taskRequests.length);
          return {
            backendRef: {
              backend: "codex",
              ref: `real-thread-${taskRequests.length}`,
            },
            text: JSON.stringify(structuredOutput),
            structuredOutput,
            usage: null,
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      };

      const callAgent = createCollaborationProductionCallAgent({
        workflowId: "wf-codex-fast-mode",
        projectPath: "/projects/example",
        sessionName: "sess-1",
        worktreePath: "/worktrees/sess-1",
        sessionKey: "/projects/example::sess-1",
        originatingConversationId: "test-originating-conv",
        laneService,
        agents: collabAgents({ agent_two: { fastMode: codexFastMode } }),
        getTaskRunner: () => runner,
      });

      await callAgent({
        kind: "task_run",
        backend: "codex",
        prompt: "round 1",
        laneRef: { workflowId: "wf-codex-fast-mode", laneId: "agent_two" },
        writeCapability: "write_capable",
        outputSchema:
          COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
            string,
            unknown
          >,
      });

      expect(taskRequests).toHaveLength(2);
      expect(
        taskRequests.every(
          (request) => request.codexFastMode === codexFastMode,
        ),
      ).toBe(true);
    },
  );

  it("leaves the Codex task fast-mode choice unset when the codex lane's config carries no fast-mode setting", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-codex-fast-mode-default",
      laneId: "agent_two",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const taskRequests: AgentTaskRequest[] = [];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        taskRequests.push(request);
        return {
          backendRef: { backend: "codex", ref: "real-thread-1" },
          text: "done",
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-codex-fast-mode-default",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getTaskRunner: () => runner,
    });

    await callAgent({
      kind: "task_run",
      backend: "codex",
      prompt: "round 1",
      laneRef: {
        workflowId: "wf-codex-fast-mode-default",
        laneId: "agent_two",
      },
      writeCapability: "write_capable",
    });

    expect(taskRequests).toHaveLength(1);
    expect(taskRequests[0]?.codexFastMode).toBeUndefined();
  });

  it("prefers an explicit request modelId over the configured codex model", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-codex-model-override",
      laneId: "agent_two",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const taskRequests: AgentTaskRequest[] = [];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        taskRequests.push(request);
        const structuredOutput = draftOutput(1);
        return {
          backendRef: { backend: "codex", ref: "real-thread-1" },
          text: JSON.stringify(structuredOutput),
          structuredOutput,
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
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
      agents: collabAgents({
        agent_two: {
          model: "gpt-5.5",
          timeoutMs: 75_000,
          stallTimeoutMs: 25_000,
        },
      }),
      getTaskRunner: () => runner,
    });

    await callAgent({
      kind: "task_run",
      backend: "codex",
      prompt: "round 1",
      modelId: "gpt-5.4",
      timeoutMs: 5_000,
      laneRef: { workflowId: "wf-codex-model-override", laneId: "agent_two" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    expect(taskRequests[0]?.modelId).toBe("gpt-5.4");
    expect(taskRequests[0]?.timeoutMs).toBe(5_000);
    expect(taskRequests[0]?.stallTimeoutMs).toBe(25_000);
  });

  it("applies the configured Claude timeout to a conversation turn", async () => {
    vi.useFakeTimers();
    try {
      const laneService = createLaneService({
        store: createInMemoryLaneStore(),
      });
      await laneService.initialize({
        workflowId: "wf-claude-timeout",
        laneId: "agent_one",
        backend: "claude",
        writeCapability: "write_capable",
        policy: { continuityEnabled: true },
        ref: null,
        metrics: { rotateBeforeNextTurn: false },
        lastUsedAt: "2026-04-28T10:00:00.000Z",
      });

      const observedSignals: AbortSignal[] = [];
      let resolveTurnStarted: () => void = () => undefined;
      const turnStarted = new Promise<void>((resolve) => {
        resolveTurnStarted = resolve;
      });
      const factory: ConversationBackendFactory = {
        backend: "claude",
        async createRuntime(): Promise<ConversationBackendRuntime> {
          return {
            backend: "claude",
            status: "alive",
            modelId: undefined,
            reasoningEffort: undefined,
            outputFormat: undefined,
            alignmentVersion: null,
            async sendTurn(
              input: ConversationBackendTurnInput,
            ): Promise<ConversationBackendTurnResult> {
              observedSignals.push(input.signal);
              resolveTurnStarted();
              await new Promise<void>((resolve) => {
                input.signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
              return {
                backendRef: null,
                costUsd: null,
                durationMs: null,
                numTurns: null,
                contextTokens: null,
                contextWindowMax: null,
                contentBlocks: [],
                aborted: true,
                compacted: false,
                failure: null,
                continuationDisposition: "retain",
              };
            },
            close: async () => {},
          };
        },
      };

      const callAgent = createCollaborationProductionCallAgent({
        workflowId: "wf-claude-timeout",
        projectPath: "/projects/example",
        sessionName: "sess-1",
        worktreePath: "/worktrees/sess-1",
        sessionKey: "/projects/example::sess-1",
        originatingConversationId: "test-originating-conv",
        laneService,
        agents: collabAgents({ agent_one: { timeoutMs: 5_000 } }),
        getConversationBackendFactory: () => factory,
      });

      const resultPromise = callAgent({
        kind: "conversation_turn",
        backend: "claude",
        prompt: "round 1",
        laneRef: { workflowId: "wf-claude-timeout", laneId: "agent_one" },
        writeCapability: "write_capable",
      });

      await turnStarted;
      vi.advanceTimersByTime(4_999);
      expect(observedSignals[0]?.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      const result = await resultPromise;

      expect(observedSignals[0]?.aborted).toBe(true);
      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind === "failed") {
        expect(result.outcome.error.failureKind).toBe("timeout");
        expect(result.outcome.error.message).toContain("5000ms");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the configured claude model and reasoning effort to a conversation_turn request that carries none", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-claude-model",
      laneId: "agent_one",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const createRuntimeInputs: Array<
      Parameters<ConversationBackendFactory["createRuntime"]>[0]
    > = [];
    const factory = makeRecordingClaudeFactory(createRuntimeInputs);

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-claude-model",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents({
        agent_one: { model: "opus", reasoningEffort: "xhigh" },
      }),
      getConversationBackendFactory: () => factory,
    });

    await callAgent({
      kind: "conversation_turn",
      backend: "claude",
      prompt: "round 1",
      laneRef: { workflowId: "wf-claude-model", laneId: "agent_one" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    expect(createRuntimeInputs[0]?.modelId).toBe("opus");
    expect(createRuntimeInputs[0]?.reasoningEffort).toBe("xhigh");
  });

  it("prefers an explicit request modelId over the configured claude model", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-claude-model-override",
      laneId: "agent_one",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const createRuntimeInputs: Array<
      Parameters<ConversationBackendFactory["createRuntime"]>[0]
    > = [];
    const factory = makeRecordingClaudeFactory(createRuntimeInputs);

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-claude-model-override",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents({ agent_one: { model: "opus" } }),
      getConversationBackendFactory: () => factory,
    });

    await callAgent({
      kind: "conversation_turn",
      backend: "claude",
      prompt: "round 1",
      modelId: "sonnet",
      laneRef: { workflowId: "wf-claude-model-override", laneId: "agent_one" },
      writeCapability: "write_capable",
      outputSchema:
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
    });

    expect(createRuntimeInputs[0]?.modelId).toBe("sonnet");
  });

  it("runs a prose work turn (no schema) then a JSON format turn (schema) on the same lane, returning the format turn's structured output", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-two-step",
      laneId: "agent_two",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const taskRequests: AgentTaskRequest[] = [];
    let callCount = 0;
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        taskRequests.push(request);
        callCount += 1;
        // Only the schema-bearing format turn returns structured output; the
        // work turn answers in prose.
        const structuredOutput = request.outputSchema
          ? draftOutput(callCount)
          : undefined;
        return {
          backendRef: {
            backend: "codex",
            ref: `real-thread-${callCount}`,
          },
          text: structuredOutput
            ? JSON.stringify(structuredOutput)
            : "prose answer",
          ...(structuredOutput ? { structuredOutput } : {}),
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-two-step",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getTaskRunner: () => runner,
    });

    const schema =
      COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >;
    const workBody = "do the actual work and cover every field";
    const result = await callAgent({
      kind: "task_run",
      backend: "codex",
      prompt: `${workBody}\n\n${COLLABORATION_STRUCTURED_OUTPUT_REMINDER}`,
      laneRef: { workflowId: "wf-two-step", laneId: "agent_two" },
      writeCapability: "write_capable",
      outputSchema: schema,
    });

    expect(taskRequests).toHaveLength(2);
    // Work turn: keeps the semantic body but swaps the JSON reminder for the
    // prose directive, runs with no schema enforcement on a fresh thread.
    expect(taskRequests[0]?.prompt).toBe(
      `${workBody}\n\n${COLLABORATION_PROSE_TURN_INSTRUCTION}`,
    );
    expect(taskRequests[0]?.prompt).not.toContain(
      COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
    );
    expect(taskRequests[0]?.outputSchema).toBeUndefined();
    expect(taskRequests[0]?.resumeRef).toBeUndefined();
    // Format turn: restate-as-JSON prompt, schema enforced, resuming the work
    // turn's thread.
    expect(taskRequests[1]?.prompt).toBe(COLLABORATION_FORMAT_TURN_INSTRUCTION);
    expect(taskRequests[1]?.outputSchema).toEqual(schema);
    expect(taskRequests[1]?.resumeRef).toEqual({
      backend: "codex",
      ref: "real-thread-1",
    });
    // The returned result is the format turn's structured output.
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual(draftOutput(2));
    }
  });

  it("issues a single turn when the request carries no output schema", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId: "wf-single-turn",
      laneId: "agent_two",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });

    const taskRequests: AgentTaskRequest[] = [];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        taskRequests.push(request);
        return {
          backendRef: { backend: "codex", ref: "real-thread-1" },
          text: "prose answer",
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-single-turn",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getTaskRunner: () => runner,
    });

    await callAgent({
      kind: "task_run",
      backend: "codex",
      prompt: "no schema here",
      laneRef: { workflowId: "wf-single-turn", laneId: "agent_two" },
      writeCapability: "write_capable",
    });

    expect(taskRequests).toHaveLength(1);
    expect(taskRequests[0]?.prompt).toBe("no schema here");
  });

  it("rejects a lane-less request loudly instead of running an unscheduled direct backend call", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    let runnerInvoked = false;
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(): Promise<AgentTaskResult> {
        runnerInvoked = true;
        return {
          backendRef: { backend: "codex", ref: "real-thread-1" },
          text: "prose answer",
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId: "wf-lane-less",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getTaskRunner: () => runner,
    });

    await expect(
      callAgent({
        kind: "task_run",
        backend: "codex",
        prompt: "no lane here",
        writeCapability: "write_capable",
      }),
    ).rejects.toThrow(/requires a laneRef/);
    // The scheduler is never bypassed: no backend call ran.
    expect(runnerInvoked).toBe(false);
  });
});

/**
 * Semantic → transport mapping for the run's captured session context.
 *
 * `callPrimitive` expresses the charter as `request.systemInstructions`; this
 * caller is where that intent becomes the Claude conversation's session
 * instructions. Both the runtime it creates and the turn it dispatches have to
 * carry it, because the runtime bakes governance at creation while the turn
 * carries what actually reaches the model.
 */
describe("createCollaborationProductionCallAgent session-context transport", () => {
  const SESSION_CONTEXT: CollaborationSessionContext = {
    alignment: {
      version: 9,
      contentHash: "hash-9",
      text: "<session-alignment>\ncharter v9 body\n</session-alignment>",
    },
    activeTicketBlock: "<active-ticket>\nCC-77: ship parity\n</active-ticket>",
  };
  const CHARTER_INSTRUCTION = buildLaneSystemInstructions(SESSION_CONTEXT)!;
  const TICKET_BLOCK = SESSION_CONTEXT.activeTicketBlock!;
  const WORK_BODY = "do the actual work and cover every field";

  interface ClaudeRecorder {
    factory: ConversationBackendFactory;
    createRuntimeInputs: Array<
      Parameters<ConversationBackendFactory["createRuntime"]>[0]
    >;
    turnInputs: ConversationBackendTurnInput[];
  }

  /**
   * Claude factory double recording both governance surfaces: what the runtime
   * was created with and what each dispatched turn carried.
   */
  function makeClaudeRecorder(options?: {
    staleOnTurn?: number;
  }): ClaudeRecorder {
    const createRuntimeInputs: Array<
      Parameters<ConversationBackendFactory["createRuntime"]>[0]
    > = [];
    const turnInputs: ConversationBackendTurnInput[] = [];
    let sendTurnCount = 0;
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input): Promise<ConversationBackendRuntime> {
        createRuntimeInputs.push(input);
        return {
          backend: "claude",
          status: "alive",
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          outputFormat: input.outputFormat,
          alignmentVersion: input.alignmentVersion ?? null,
          applyPortableMcpConfig: async () => ({
            disposition: "applied_now",
            droppedServerIds: [],
            droppedFields: [],
            errors: {},
          }),
          async sendTurn(turn): Promise<ConversationBackendTurnResult> {
            turnInputs.push(turn);
            sendTurnCount += 1;
            if (options?.staleOnTurn === sendTurnCount) {
              return {
                backendRef: { backend: "claude", ref: "stale-session" },
                costUsd: null,
                durationMs: 10,
                numTurns: 1,
                contextTokens: null,
                contextWindowMax: null,
                contentBlocks: [],
                aborted: false,
                compacted: false,
                failure: {
                  kind: "stale_resume_ref",
                  message: "resume session not found",
                  retryable: true,
                },
                continuationDisposition: "retain",
              };
            }
            const structuredOutput = draftOutput(sendTurnCount);
            return {
              backendRef: {
                backend: "claude",
                ref: `real-session-${sendTurnCount}`,
              },
              costUsd: null,
              durationMs: 10,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [{ type: "text", text: structuredOutput.summary }],
              structuredOutput,
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
          close: async () => {},
        };
      },
    };
    return { factory, createRuntimeInputs, turnInputs };
  }

  async function claudeLaneService(
    workflowId: string,
    ref: string | null,
  ): Promise<ReturnType<typeof createLaneService>> {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    await laneService.initialize({
      workflowId,
      laneId: "agent_one",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });
    return laneService;
  }

  const SCHEMA = COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
    string,
    unknown
  >;

  function governedRequest(workflowId: string): AgentCallRequest {
    return {
      kind: "conversation_turn",
      backend: "claude",
      prompt: prefixPromptWithTicketBlock(
        SESSION_CONTEXT,
        `${WORK_BODY}\n\n${COLLABORATION_STRUCTURED_OUTPUT_REMINDER}`,
      ),
      systemInstructions: CHARTER_INSTRUCTION,
      laneRef: { workflowId, laneId: "agent_one" },
      writeCapability: "write_capable",
      outputSchema: SCHEMA,
    };
  }

  it("maps systemInstructions onto the Claude runtime's session instructions at creation and on every dispatched turn", async () => {
    const workflowId = "wf-session-instructions";
    const laneService = await claudeLaneService(workflowId, null);
    const recorder = makeClaudeRecorder();

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getConversationBackendFactory: () => recorder.factory,
    });

    await callAgent(governedRequest(workflowId));

    expect(recorder.createRuntimeInputs.length).toBeGreaterThan(0);
    for (const created of recorder.createRuntimeInputs) {
      expect(created.sessionInstructions).toEqual([CHARTER_INSTRUCTION]);
    }
    expect(recorder.turnInputs.length).toBeGreaterThan(0);
    for (const turn of recorder.turnInputs) {
      expect(turn.sessionInstructions).toEqual([CHARTER_INSTRUCTION]);
    }
  });

  it("passes empty session instructions when the request carries none", async () => {
    const workflowId = "wf-no-session-instructions";
    const laneService = await claudeLaneService(workflowId, null);
    const recorder = makeClaudeRecorder();

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getConversationBackendFactory: () => recorder.factory,
    });

    await callAgent({
      kind: "conversation_turn",
      backend: "claude",
      prompt: "round 1",
      laneRef: { workflowId, laneId: "agent_one" },
      writeCapability: "write_capable",
      outputSchema: SCHEMA,
    });

    for (const created of recorder.createRuntimeInputs) {
      expect(created.sessionInstructions).toEqual([]);
    }
    for (const turn of recorder.turnInputs) {
      expect(turn.sessionInstructions).toEqual([]);
    }
  });

  it("does not stamp an alignmentVersion onto the runtime, whose per-call lifecycle can never fire the recreate gate", async () => {
    const workflowId = "wf-no-alignment-version";
    const laneService = await claudeLaneService(workflowId, null);
    const recorder = makeClaudeRecorder();

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getConversationBackendFactory: () => recorder.factory,
    });

    await callAgent(governedRequest(workflowId));

    for (const created of recorder.createRuntimeInputs) {
      expect(created.alignmentVersion).toBeUndefined();
    }
  });

  it("keeps the charter on the format follow-up while dropping the ticket block with it", async () => {
    const workflowId = "wf-format-turn-governance";
    const laneService = await claudeLaneService(workflowId, null);
    const recorder = makeClaudeRecorder();

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getConversationBackendFactory: () => recorder.factory,
    });

    await callAgent(governedRequest(workflowId));

    expect(recorder.turnInputs).toHaveLength(2);
    const [workTurn, formatTurn] = recorder.turnInputs;
    // Work turn: ticket block prefixed once, prose directive swapped in.
    expect(workTurn?.promptText).toBe(
      `${TICKET_BLOCK}\n\n${WORK_BODY}\n\n${COLLABORATION_PROSE_TURN_INSTRUCTION}`,
    );
    expect(workTurn?.sessionInstructions).toEqual([CHARTER_INSTRUCTION]);
    // Format turn: same governance, restate-as-JSON prompt only — the ticket
    // block is task context for producing the answer, not for reformatting it.
    expect(formatTurn?.promptText).toBe(COLLABORATION_FORMAT_TURN_INSTRUCTION);
    expect(formatTurn?.promptText).not.toContain(TICKET_BLOCK);
    expect(formatTurn?.sessionInstructions).toEqual([CHARTER_INSTRUCTION]);
  });

  it("swaps only the builder's trailing reminder, leaving a ticket block that happens to quote it byte-identical", async () => {
    const workflowId = "wf-ticket-bytes-preserved";
    const laneService = await claudeLaneService(workflowId, null);
    const recorder = makeClaudeRecorder();

    // Ticket titles and descriptions are unrestricted user text: a ticket about
    // this very reminder carries its exact bytes. The canonical block must
    // survive the prose-turn rewrite unchanged — only the builder-owned
    // terminal reminder is the caller's to swap.
    const adversarialTicketBlock = [
      "<active-ticket>",
      `CC-99: "${COLLABORATION_STRUCTURED_OUTPUT_REMINDER}" leaks into drafts`,
      "</active-ticket>",
    ].join("\n");
    const adversarialContext: CollaborationSessionContext = {
      alignment: SESSION_CONTEXT.alignment,
      activeTicketBlock: adversarialTicketBlock,
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getConversationBackendFactory: () => recorder.factory,
    });

    await callAgent({
      kind: "conversation_turn",
      backend: "claude",
      prompt: prefixPromptWithTicketBlock(
        adversarialContext,
        `${WORK_BODY}\n\n${COLLABORATION_STRUCTURED_OUTPUT_REMINDER}`,
      ),
      systemInstructions: CHARTER_INSTRUCTION,
      laneRef: { workflowId, laneId: "agent_one" },
      writeCapability: "write_capable",
      outputSchema: SCHEMA,
    });

    const workTurn = recorder.turnInputs[0];
    expect(workTurn?.promptText).toBe(
      `${adversarialTicketBlock}\n\n${WORK_BODY}\n\n${COLLABORATION_PROSE_TURN_INSTRUCTION}`,
    );
    // The captured block is reproduced verbatim…
    expect(workTurn?.promptText.startsWith(adversarialTicketBlock)).toBe(true);
    // …including the reminder bytes inside it, while the builder's own trailing
    // reminder is the one that got swapped.
    expect(
      workTurn?.promptText.split(COLLABORATION_STRUCTURED_OUTPUT_REMINDER),
    ).toHaveLength(2);
    expect(
      workTurn?.promptText.endsWith(COLLABORATION_PROSE_TURN_INSTRUCTION),
    ).toBe(true);
  });

  it("re-issues a stale-ref fresh retry with the same session instructions and prompt", async () => {
    const workflowId = "wf-stale-governance";
    const laneService = await claudeLaneService(workflowId, null);
    // Turn 2 is the format follow-up resuming the work turn's session; it fails
    // stale, and the caller recovers once with a fresh runtime.
    const recorder = makeClaudeRecorder({ staleOnTurn: 2 });

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getConversationBackendFactory: () => recorder.factory,
    });

    await callAgent(governedRequest(workflowId));

    expect(recorder.turnInputs.length).toBeGreaterThan(2);
    const staleTurn = recorder.turnInputs[1]!;
    const retryTurn = recorder.turnInputs[2]!;
    expect(retryTurn.sessionInstructions).toEqual([CHARTER_INSTRUCTION]);
    expect(retryTurn.promptText).toBe(staleTurn.promptText);
    for (const created of recorder.createRuntimeInputs) {
      expect(created.sessionInstructions).toEqual([CHARTER_INSTRUCTION]);
    }
  });

  it("governs a resumed primary lane with the captured charter, whose supersedes clause outranks any charter in the inherited session", async () => {
    const workflowId = "wf-prior-backend-ref";
    // priorBackendRef seeding is retained by design: agent_one resumes the
    // originating conversation's session, which may contain an older charter
    // that neutral collaboration code cannot inspect.
    const laneService = await claudeLaneService(
      workflowId,
      "originating-session-with-charter-8",
    );
    const recorder = makeClaudeRecorder();

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "test-originating-conv",
      laneService,
      agents: collabAgents(),
      getConversationBackendFactory: () => recorder.factory,
    });

    await callAgent(governedRequest(workflowId));
    await callAgent(governedRequest(workflowId));

    // The seeded ref is still resumed…
    expect(recorder.createRuntimeInputs[0]?.persistedRef).toEqual({
      backend: "claude",
      ref: "originating-session-with-charter-8",
    });
    // …and every call in that resumed lane carries the captured charter with
    // its supersedes clause, so the newer version governs.
    expect(recorder.turnInputs.length).toBeGreaterThan(1);
    for (const turn of recorder.turnInputs) {
      expect(turn.sessionInstructions).toEqual([CHARTER_INSTRUCTION]);
      expect(turn.sessionInstructions[0]).toContain(CHARTER_SUPERSEDES_NOTICE);
    }
  });

  describe("CC session scope for the Codex task lane", () => {
    const SESSION_SCOPE_INPUT = {
      workflowId: "wf-session-scope",
      projectPath: "/projects/example",
      sessionName: "sess-1",
      worktreePath: "/worktrees/sess-1",
      sessionKey: "/projects/example::sess-1",
      originatingConversationId: "conv-originating",
    } as const;

    async function makeCodexLaneService() {
      const laneService = createLaneService({
        store: createInMemoryLaneStore(),
      });
      await laneService.initialize({
        workflowId: SESSION_SCOPE_INPUT.workflowId,
        laneId: "agent_two",
        backend: "codex",
        writeCapability: "write_capable",
        policy: { continuityEnabled: true },
        ref: null,
        metrics: { rotateBeforeNextTurn: false },
        lastUsedAt: "2026-04-28T10:00:00.000Z",
      });
      return laneService;
    }

    function codexWorkRequest(): AgentCallRequest {
      return {
        kind: "task_run",
        backend: "codex",
        prompt: "do the collaborative work",
        laneRef: {
          workflowId: SESSION_SCOPE_INPUT.workflowId,
          laneId: "agent_two",
        },
        writeCapability: "write_capable",
      };
    }

    function makeRecordingRunner(sink: AgentTaskRequest[]): AgentTaskRunner {
      return {
        backend: "codex",
        async run(request): Promise<AgentTaskResult> {
          sink.push(request);
          return {
            backendRef: { backend: "codex", ref: "real-thread-1" },
            text: "prose answer",
            usage: null,
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      };
    }

    /**
     * The REAL Codex task runner over a capturing provider: the request-level
     * assertions below stop at the seam, and only the runner's own env
     * construction proves the identity reaches a subprocess.
     */
    function makeRealCodexRunner() {
      return createEnvCapturingCodexTaskRunner({
        ambientEnv: {
          NODE_ENV: "test",
          PATH: "/usr/bin",
          CC_CONVERSATION_ID: "ambient-conversation",
          CC_API_TOKEN: "ambient-token",
        },
        serverUrl: "http://127.0.0.1:4321",
        apiToken: "instance-token-secret",
        configDir: "/cc/config",
      });
    }

    it("gives an opted-in Codex collaboration task the originating session's CC identity", async () => {
      const laneService = await makeCodexLaneService();
      const codex = makeRealCodexRunner();

      const callAgent = createCollaborationProductionCallAgent({
        ...SESSION_SCOPE_INPUT,
        laneService,
        agents: collabAgents(),
        grantsOriginatingSessionScope: true,
        getTaskRunner: () => codex.runner,
      });

      await callAgent(codexWorkRequest());

      // `cctl ticket get` inside the lane must resolve the conversation that
      // started the collaboration, not an ambient or synthetic one.
      expect(codex.capturedEnvs[0]).toMatchObject({
        CC_CONVERSATION_ID: "conv-originating",
        CC_PROJECT: "example",
        CC_SESSION: "sess-1",
        CC_SERVER_URL: "http://127.0.0.1:4321",
        CC_API_TOKEN: "instance-token-secret",
      });
      expect(codex.capturedEnvs[0]?.PATH).toBe("/cc/config/bin:/usr/bin");
    });

    it("leaves the task env neutralized for a caller composed without the grant (the graph-workflow shape)", async () => {
      const laneService = await makeCodexLaneService();
      const codex = makeRealCodexRunner();

      const callAgent = createCollaborationProductionCallAgent({
        ...SESSION_SCOPE_INPUT,
        laneService,
        agents: collabAgents(),
        getTaskRunner: () => codex.runner,
      });

      await callAgent(codexWorkRequest());

      expect(codex.capturedEnvs[0]).toEqual({
        NODE_ENV: "test",
        PATH: "/usr/bin",
        CC_CONVERSATION_ID: "",
        CC_API_TOKEN: "",
        CLAUDECODE: "",
      });
    });

    it("supplies the scope on every task request of an opted-in run", async () => {
      const laneService = await makeCodexLaneService();
      const taskRequests: AgentTaskRequest[] = [];

      const callAgent = createCollaborationProductionCallAgent({
        ...SESSION_SCOPE_INPUT,
        laneService,
        agents: collabAgents(),
        grantsOriginatingSessionScope: true,
        getTaskRunner: () => makeRecordingRunner(taskRequests),
      });

      await callAgent(codexWorkRequest());

      expect(taskRequests).toHaveLength(1);
      expect(taskRequests[0]?.ccSessionScope).toEqual({
        project: "example",
        session: "sess-1",
        conversationId: "conv-originating",
      });
    });

    it("supplies no scope at all when the grant is absent", async () => {
      const laneService = await makeCodexLaneService();
      const taskRequests: AgentTaskRequest[] = [];

      const callAgent = createCollaborationProductionCallAgent({
        ...SESSION_SCOPE_INPUT,
        laneService,
        agents: collabAgents(),
        getTaskRunner: () => makeRecordingRunner(taskRequests),
      });

      await callAgent(codexWorkRequest());

      expect(taskRequests).toHaveLength(1);
      expect(taskRequests[0]?.ccSessionScope).toBeUndefined();
    });

    it("keeps the resolved token and server URL out of the collaboration task request", async () => {
      const laneService = await makeCodexLaneService();
      const taskRequests: AgentTaskRequest[] = [];

      const callAgent = createCollaborationProductionCallAgent({
        ...SESSION_SCOPE_INPUT,
        laneService,
        agents: collabAgents(),
        grantsOriginatingSessionScope: true,
        getTaskRunner: () => makeRecordingRunner(taskRequests),
      });

      await callAgent(codexWorkRequest());

      // The scope names an identity; credentials are resolved server-side by
      // the runner and never travel through the request.
      const serialized = JSON.stringify(taskRequests[0]);
      expect(serialized).not.toContain("instance-token-secret");
      expect(serialized).not.toContain("127.0.0.1:4321");
    });
  });
});
