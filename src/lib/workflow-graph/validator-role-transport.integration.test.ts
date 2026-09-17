import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";

import { _resetForTesting as resetTaskRuntime } from "@/lib/workflows/conversation/runtime-state";

/**
 * R10.1 — the composed payload at the FINAL provider invocation.
 *
 * Every hop between the validator runner and the backend SDK is production
 * code: the real `createValidatorRunner`, the real task-run actor
 * implementation, the real AgentCall facade, and the real Claude and Codex task
 * runners. Only the provider port is substituted — Claude's `runQuery` and
 * Codex's `createCodex` — because that port IS the assertion surface: a test
 * that stopped at `executeWorkflowTaskRun` would pass even if an adapter
 * demoted the role contract to user-prompt text.
 *
 * All four backend x strategy combinations run the same way. Strategy changes
 * which continuity anchor the lane holds, never the channel, so the matrix
 * exists to prove exactly that: none of the four can lose the payload.
 */
import { WHOLE_TREE_CANDIDATE_SCOPE } from "@/lib/git/diff";

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const claudeQueryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: claudeQueryMock,
  // The Claude launch path refuses to start unless it can confirm no managed
  // policy re-enables native auto-memory; an ordinary host's policy tier is
  // silent on it.
  resolveSettings: async () => ({ effective: {}, provenance: {}, sources: [] }),
}));
vi.mock("@/lib/shared/sdk-env", () => ({}));

const codexClientState = {
  optionCalls: [] as Array<{ config?: Record<string, unknown> }>,
  promptCalls: [] as unknown[],
};

/** Scripted Codex client: records what the runner constructs it with and what
 *  it is prompted with, then returns a conforming verdict. */
function fakeCodexClient(options: { config?: Record<string, unknown> }) {
  codexClientState.optionCalls.push(options);
  const thread = {
    id: "thread-1" as string | null,
    run: (input: unknown) => {
      codexClientState.promptCalls.push(input);
      return Promise.resolve({
        finalResponse: JSON.stringify({
          summary: "ok",
          issues: [],
          advisories: [],
        }),
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
        },
        items: [],
      });
    },
  };
  return { startThread: () => thread, resumeThread: () => thread };
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createScriptedClaudeTaskRunner,
  createScriptedCodexTaskRunner,
} from "@/lib/agent-backends/testing/scripted-task-runners";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  PROFILE_LAYER_HEADING,
  buildAgentProfileSnapshot,
} from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import { type ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";

import { createActorDependenciesFixture } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { WORKFLOW_ROLE_CONTRACT_HEADING } from "./role-instructions";
import { createValidatorRunner } from "./validator-runner";
import type { ValidatorExecutionStrategy } from "./lane-continuity";
import { createWorkflowExecution } from "./test-fixtures";
import type { GraphWorkflowExecution } from "./schemas";
import type {
  GraphWorkflowAgentConfig,
  SeededValidatorAssignment,
} from "./config-schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { GraphWorkflowResolvedContext } from "./definition-schemas";

const PROJECT_PATH = "/repo-role-transport";
const SESSION_NAME = "role-session";
// A real directory: the runner composes its lane write envelope before
// dispatch, and that composition canonicalizes the candidate worktree and fails
// closed when it cannot resolve.
const WORKTREE_PATH = mkdtempSync(path.join(tmpdir(), "cc-role-transport-wt-"));
const PROFILE_SENTINEL = "PROFILE_LENS_SENTINEL";
const PROFILE_INSTRUCTIONS = `Focus on the review lens. ${PROFILE_SENTINEL}`;

const VERDICT_TEXT = JSON.stringify({
  summary: "ok",
  issues: [],
  advisories: [],
});

function claudeStream(): AsyncGenerator<unknown, void, unknown> {
  return (async function* () {
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: VERDICT_TEXT }] },
    };
    yield {
      type: "result",
      subtype: "success",
      session_id: "session-role",
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 10,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
      },
      structured_output: undefined,
      errors: [],
    };
  })();
}

beforeEach(() => {
  vi.clearAllMocks();
  codexClientState.optionCalls = [];
  codexClientState.promptCalls = [];
  claudeQueryMock.mockImplementation(() => claudeStream());
});

afterEach(() => {});

function taskRunnerFor(backend: AgentBackendId): AgentTaskRunner {
  if (backend === "claude") {
    return createScriptedClaudeTaskRunner({
      getServerUrl: () => "http://cc-role-transport.test:4312",
      runQuery: (args) => claudeQueryMock(args) as AsyncIterable<never>,
    });
  }
  return createScriptedCodexTaskRunner({
    createCodex: (options) => fakeCodexClient(options) as never,
  });
}

/**
 * The production task-run path with only the provider substituted: the real
 * actor implementation (which runs the real AgentCall gate and the real task
 * runner) followed by the real result projection.
 */
function productionTaskRun(
  backend: AgentBackendId,
): (input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult> {
  const actorDependencies = createActorDependenciesFixture({
    getTaskRunner: vi.fn(() => taskRunnerFor(backend)),
  });

  return async (input) => {
    const fixture = await createLifecycleFixture({
      binding: input.binding,
      conversation: { agentBackend: backend, backendRef: null },
      actorDeps: actorDependencies,
    });
    try {
      return await fixture.executeWorkflowTaskRun({
        ...input,
        binding: { ...input.binding, worktreePath: WORKTREE_PATH },
        resumeRef: input.resumeRef ?? null,
      });
    } finally {
      await fixture.close();
    }
  };
}

function seededValidator(
  backend: AgentBackendId,
  strategy: ValidatorExecutionStrategy,
): SeededValidatorAssignment {
  if (backend === "cursor") {
    throw new Error("Cursor has no task facet for validator lanes");
  }
  const modelSelection: BackendModelSelection =
    backend === "claude"
      ? {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        }
      : {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        };
  const agent: GraphWorkflowAgentConfig = { backend, modelSelection };
  return {
    id: "reviewer",
    profile: { tier: "builtin", id: "general-reviewer" },
    profileSnapshot: buildAgentProfileSnapshot({
      tier: "builtin",
      id: "general-reviewer",
      name: "General Reviewer",
      revision: 1,
      sourceContentHash: computeContentHash(PROFILE_INSTRUCTIONS),
      instructions: PROFILE_INSTRUCTIONS,
    }),
    strategy,
    authority: "blocking",
    agent,
    continuity: { enabled: true },
  };
}

function contextFor(
  validator: SeededValidatorAssignment,
  execution: GraphWorkflowExecution,
): GraphWorkflowResolvedContext {
  const context = execution.workingDefinition.executionContexts[0]!;
  return {
    ...context,
    contextValidator: { enabled: true, assignments: [validator] },
  };
}

async function runValidator(
  backend: AgentBackendId,
  strategy: ValidatorExecutionStrategy,
): Promise<void> {
  const validator = seededValidator(backend, strategy);
  const execution = createWorkflowExecution();
  const context = contextFor(validator, execution);

  const runner = createValidatorRunner({
    executionContract: createTestGraphExecutionContract(),
    resolveWorktreePath: async () => WORKTREE_PATH,
    resolveTimeoutMs: async () => 30_000,
    executeWorkflowTaskRun: productionTaskRun(backend),
    computeValidationDiffScope: async () => ({
      kind: "unavailable",
      candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
      reason: "test",
    }),
    readLaneConversation: async () => null,
    continuityService: {
      resolveValidatorCall: async () =>
        strategy === "conversation"
          ? {
              execution,
              sessionAction: "create",
              strategy: "conversation",
              backend,
              conversationId: "lane-conversation-1",
            }
          : {
              execution,
              sessionAction: "create",
              strategy: "task",
              backend,
              backendRef: { backend, ref: "ref-1" },
            },
      recordLaneTurnOutcome: async () => execution,
    },
  });

  const result = await runner.runContextValidator({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    execution,
    context,
    validator,
  });

  // A run that never reached the provider would surface here as an infra error,
  // which would make the channel assertions below vacuous.
  expect(result.result.kind, JSON.stringify(result.result)).toBe("pass");
}

/** The system-prompt append Claude's SDK was actually handed. */
function claudeAppend(): string {
  const options = claudeQueryMock.mock.calls[0]?.[0]?.options;
  const systemPrompt = options?.systemPrompt;
  expect(systemPrompt).toMatchObject({
    type: "preset",
    preset: "claude_code",
  });
  return String(systemPrompt.append ?? "");
}

/** The developer_instructions the Codex SDK client was actually constructed with. */
function codexDeveloperInstructions(): string {
  const config = codexClientState.optionCalls[0]?.config ?? {};
  return String(config.developer_instructions ?? "");
}

function expectRoleContractFirst(payload: string): void {
  const contractAt = payload.indexOf(WORKFLOW_ROLE_CONTRACT_HEADING);
  const profileAt = payload.indexOf(PROFILE_LAYER_HEADING);
  expect(contractAt).toBeGreaterThanOrEqual(0);
  expect(profileAt).toBeGreaterThan(contractAt);
  // Exactly once. A validator lane can hold a CC conversation, and if the
  // conversation channel ever also injected its snapshot the profile would
  // arrive twice — once subordinate, once not.
  expect(payload.match(new RegExp(PROFILE_SENTINEL, "g"))).toHaveLength(1);
  // The profile arrives still wearing its subordination frame.
  expect(payload).toContain("subordinate specialization lens");
}

describe("validator role-contract transport (R10.1)", () => {
  it("reaches Claude's system prompt on a task-strategy validator", async () => {
    await runValidator("claude", "task");
    expectRoleContractFirst(claudeAppend());
  });

  it("reaches Claude's system prompt on a conversation-strategy validator", async () => {
    await runValidator("claude", "conversation");
    expectRoleContractFirst(claudeAppend());
  });

  it("reaches Codex developer instructions on a task-strategy validator", async () => {
    await runValidator("codex", "task");
    expectRoleContractFirst(codexDeveloperInstructions());
  });

  it("reaches Codex developer instructions on a conversation-strategy validator", async () => {
    await runValidator("codex", "conversation");
    expectRoleContractFirst(codexDeveloperInstructions());
  });

  it("never delivers the payload as Codex user-prompt text", async () => {
    await runValidator("codex", "task");

    const prompt = JSON.stringify(codexClientState.promptCalls[0]);
    expect(prompt).not.toContain(WORKFLOW_ROLE_CONTRACT_HEADING);
    expect(prompt).not.toContain(PROFILE_SENTINEL);
    expect(prompt).not.toContain("## System Instructions");
    // The validation prompt itself still travels as user input.
    expect(prompt).toContain("Context Validation");
  });

  it("never delivers the payload as Claude user-prompt text", async () => {
    await runValidator("claude", "task");

    const prompt = String(claudeQueryMock.mock.calls[0]?.[0]?.prompt ?? "");
    expect(prompt).not.toContain(WORKFLOW_ROLE_CONTRACT_HEADING);
    expect(prompt).not.toContain(PROFILE_SENTINEL);
    expect(prompt).toContain("Context Validation");
  });
});

afterEach(() => resetTaskRuntime());
