/**
 * R7.2 — the write envelope at the backend-neutral boundary and at the runner.
 *
 * Every hop between the validator runner and the backend task runner is
 * production code: the real `createValidatorRunner`, the real task-run actor
 * implementation, the real AgentCall facade, and the real Claude and Codex task
 * runners. Two observation points are recorded per run:
 *
 *  - the NEUTRAL boundary — the `AgentCallRequest` and the task-execution intent
 *    the actor hands the facade. This is where the write-capable implementer
 *    configuration lives (`sandboxMode: "danger-full-access"`,
 *    `writeCapability: "write_capable"`), so it is the only place its ABSENCE
 *    from a validator lane can be proven for both execution strategies.
 *  - the runner's `AgentTaskRequest`, proving the policy survives the facade's
 *    task resolution and dispatch rather than being dropped one hop short.
 *
 * The provider ports are substituted because no turn needs to reach a model;
 * OS-level enforcement of the delivered policy is proven separately against the
 * real installed runners.
 */
import { WHOLE_TREE_CANDIDATE_SCOPE } from "@/lib/git/diff";

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const claudeQueryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: claudeQueryMock }));
vi.mock("@/lib/shared/sdk-env", () => ({}));

/**
 * What the fake Codex thread does for the current test. `sandbox_unavailable`
 * is the provider reporting it could not start the sandbox — the failure an
 * envelope must never fall through, and the Codex counterpart of the Claude
 * `error_during_execution` case below.
 */
const codexTurn = vi.hoisted(() => ({
  behavior: "success" as "success" | "sandbox_unavailable",
  sandboxUnavailableMessage:
    "sandbox setup failed: seatbelt sandbox is unavailable on this host",
}));

/** Scripted Codex client, streamed like the real SDK. */
function fakeCodexClient() {
  const thread = {
    id: "thread-1" as string | null,
    // Streamed, like the real SDK: a sandbox that never came up reaches the
    // adapter as a `turn.failed` event, not as a thrown error.
    runStreamed: () =>
      Promise.resolve({
        events: (async function* () {
          if (codexTurn.behavior === "sandbox_unavailable") {
            yield {
              type: "turn.failed",
              error: { message: codexTurn.sandboxUnavailableMessage },
            };
            return;
          }
          yield {
            type: "item.completed",
            item: {
              id: "item-1",
              type: "agent_message",
              text: JSON.stringify({
                summary: "ok",
                issues: [],
                advisories: [],
              }),
            },
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
            },
          };
        })(),
      }),
  };
  return { startThread: () => thread, resumeThread: () => thread };
}

import {
  createScriptedClaudeTaskRunner,
  createScriptedCodexTaskRunner,
} from "@/lib/agent-backends/testing/scripted-task-runners";
import type {
  AgentTaskRequest,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import {
  executeAgentCall,
  type AgentCallFacadeDeps,
} from "@/lib/workflows/primitives/agent-call-facade";
import type { AgentCallRequest } from "@/lib/workflows/primitives/agent-call-vocabulary";
import {
  mapToTaskRunResult,
  type ExecuteWorkflowTaskRunInput,
  type TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import {
  runTaskRunTurnForMachine,
  setActorDeps,
  _resetActorDepsForTesting,
} from "@/lib/workflows/conversation/actor-implementations";
import { createActorImplementationDepsFixture } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import {
  createValidatorRunner,
  type ValidatorRunResult,
} from "./validator-runner";
import type { ValidatorExecutionStrategy } from "./lane-continuity";
import { createWorkflowExecution } from "./test-fixtures";
import type { GraphWorkflowExecution } from "./schemas";
import type { SeededValidatorAssignment } from "./config-schemas";
import type { GraphWorkflowResolvedContext } from "./definition-schemas";

const PROJECT_PATH = "/repo-write-envelope";
const SESSION_NAME = "envelope-session";
const WORKTREE_PATH = "/private/volumes/repo/worktree";
const LANE_SCRATCH_DIR = "/private/tmp/cc-lane-scratch/exec/ctx/reviewer";
const LANE_TMP_DIR = `${LANE_SCRATCH_DIR}/tmp`;
const TRUSTED_SERVER_URL = "http://127.0.0.1:3000";

const EXPECTED_POLICY = {
  mode: "allowlist" as const,
  allowWrite: [LANE_SCRATCH_DIR, LANE_TMP_DIR],
  denyWrite: [WORKTREE_PATH],
};

const VERDICT_TEXT = JSON.stringify({
  summary: "ok",
  issues: [],
  advisories: [],
});

interface NeutralCall {
  request: AgentCallRequest;
  taskExecution: AgentCallFacadeDeps["taskExecution"];
}

let neutralCalls: NeutralCall[] = [];
let runnerRequests: AgentTaskRequest[] = [];

function claudeStream(): AsyncGenerator<unknown, void, unknown> {
  return (async function* () {
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: VERDICT_TEXT }] },
    };
    yield {
      type: "result",
      subtype: "success",
      session_id: "session-envelope",
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
  neutralCalls = [];
  runnerRequests = [];
  codexTurn.behavior = "success";
  claudeQueryMock.mockImplementation(() => claudeStream());
});

afterEach(() => {
  _resetActorDepsForTesting();
});

function realTaskRunner(backend: AgentBackendId): AgentTaskRunner {
  if (backend === "claude") {
    return createScriptedClaudeTaskRunner({
      getServerUrl: () => TRUSTED_SERVER_URL,
      runQuery: (args) => claudeQueryMock(args) as AsyncIterable<never>,
    });
  }
  return createScriptedCodexTaskRunner({
    createCodex: () => fakeCodexClient() as never,
  });
}

/** The real runner, with the request it is handed recorded first. */
function recordingRunner(backend: AgentBackendId): AgentTaskRunner {
  const runner = realTaskRunner(backend);
  return {
    backend: runner.backend,
    run: (input) => {
      runnerRequests.push(input);
      return runner.run(input);
    },
  };
}

/**
 * The production task-run path with the provider substituted and the neutral
 * boundary recorded. The machine's event fold is covered by the entrypoint's
 * own tests; this harness starts at the actor input so the facade, the task
 * resolution, and the runner are all the real ones.
 */
function productionTaskRun(
  backend: AgentBackendId,
): (input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult> {
  setActorDeps(
    createActorImplementationDepsFixture({
      getTaskRunner: vi.fn(() => recordingRunner(backend)),
      executeAgentCall: async (request, facadeDeps) => {
        neutralCalls.push({
          request,
          taskExecution: facadeDeps.taskExecution,
        });
        return executeAgentCall(request, facadeDeps);
      },
    }),
  );

  return async (input) => {
    const actorResult = await runTaskRunTurnForMachine({
      persistence: "ephemeral",
      projectPath: input.projectPath,
      projectName: "repo",
      sessionName: input.sessionName,
      worktreePath: WORKTREE_PATH,
      conversationId: input.conversationId,
      agentBackend: backend,
      backendRef: null,
      promptText: input.prompt,
      modelId: input.modelId ?? null,
      effort: input.effort ?? null,
      ...(input.outputFormat !== undefined
        ? { outputFormat: input.outputFormat }
        : {}),
      ...(input.systemInstructions !== undefined
        ? { systemInstructions: input.systemInstructions }
        : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.fsWritePolicy !== undefined
        ? { fsWritePolicy: input.fsWritePolicy }
        : {}),
    });

    return mapToTaskRunResult(
      actorResult,
      actorResult.error,
      input.outputFormat,
    );
  };
}

function seededValidator(
  backend: AgentBackendId,
  strategy: ValidatorExecutionStrategy,
): SeededValidatorAssignment {
  return {
    id: "reviewer",
    profile: { tier: "builtin", id: "general-reviewer" },
    profileSnapshot: buildAgentProfileSnapshot({
      tier: "builtin",
      id: "general-reviewer",
      name: "General Reviewer",
      revision: 1,
      sourceContentHash: computeContentHash("Review carefully."),
      instructions: "Review carefully.",
    }),
    strategy,
    agent: { backend, model: "sonnet", reasoningEffort: "medium" },
    continuity: { enabled: true },
  } as SeededValidatorAssignment;
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

async function runValidatorRaw(
  backend: AgentBackendId,
  strategy: ValidatorExecutionStrategy,
): Promise<ValidatorRunResult> {
  const validator = seededValidator(backend, strategy);
  const execution = createWorkflowExecution();
  const context = contextFor(validator, execution);

  const runner = createValidatorRunner({
    resolveWorktreePath: async () => WORKTREE_PATH,
    resolveTimeoutMs: async () => 30_000,
    executeWorkflowTaskRun: productionTaskRun(backend),
    computeValidationDiffScope: async () => ({
      kind: "unavailable",
      candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
      reason: "test",
    }),
    readLaneConversation: async () => null,
    composeLaneWriteEnvelope: () => ({
      policy: EXPECTED_POLICY,
      laneScratchDir: LANE_SCRATCH_DIR,
      laneTmpDir: LANE_TMP_DIR,
    }),
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

  return runner.runContextValidator({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    execution,
    context,
    validator,
  });
}

async function runValidator(
  backend: AgentBackendId,
  strategy: ValidatorExecutionStrategy,
): Promise<void> {
  const result = await runValidatorRaw(backend, strategy);

  // A run that never reached the runner would surface here as an infra error,
  // which would make every assertion below vacuous.
  expect(result.result.kind).toBe("pass");
}

function neutralRequest(): Extract<AgentCallRequest, { kind: "task_run" }> {
  const call = neutralCalls[0];
  expect(call).toBeDefined();
  const request = call!.request;
  expect(request.kind).toBe("task_run");
  return request as Extract<AgentCallRequest, { kind: "task_run" }>;
}

describe.each([
  ["claude", "task"],
  ["claude", "conversation"],
  ["codex", "task"],
  ["codex", "conversation"],
] as const)(
  "validator write envelope — %s / %s strategy",
  (backend, strategy) => {
    it("carries the server-derived write policy to the neutral boundary and the runner", async () => {
      await runValidator(backend, strategy);

      expect(neutralRequest().fsWritePolicy).toEqual(EXPECTED_POLICY);
      expect(runnerRequests).toHaveLength(1);
      expect(runnerRequests[0]?.fsWritePolicy).toEqual(EXPECTED_POLICY);
    });

    it("never carries the write-capable implementer configuration", async () => {
      await runValidator(backend, strategy);

      expect(neutralCalls[0]?.taskExecution?.sandboxMode).not.toBe(
        "danger-full-access",
      );
      expect(runnerRequests[0]?.sandboxMode).not.toBe("danger-full-access");
      expect(neutralRequest().writeCapability).toBe("read_only");
      // The implementer's write-capable tool set is its workflow task tooling
      // (the `cctl workflow …` server that completes tasks and edits the run).
      // A validator lane is handed none of it.
      expect(neutralRequest().tooling).toBeUndefined();
      expect(runnerRequests[0]?.tooling).toBeUndefined();
    });

    it("never lists the candidate worktree as writable", async () => {
      await runValidator(backend, strategy);

      const policy = runnerRequests[0]?.fsWritePolicy;
      expect(policy?.allowWrite).not.toContain(WORKTREE_PATH);
      expect(policy?.denyWrite).toContain(WORKTREE_PATH);
    });
  },
);

describe("implementer task runs", () => {
  it("keep the write-capable configuration and carry no write policy", async () => {
    // The same dispatch site serves both roles; the derivation must leave the
    // unrestricted lane exactly as it was.
    const dispatch = productionTaskRun("claude");

    await dispatch({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: "implementer-conversation",
      kind: "task_run",
      prompt: "implement the task",
      timeoutMs: 30_000,
    });

    expect(neutralCalls[0]?.taskExecution?.sandboxMode).toBe(
      "danger-full-access",
    );
    expect(neutralRequest().writeCapability).toBe("write_capable");
    expect(neutralRequest().fsWritePolicy).toBeUndefined();
    expect(runnerRequests[0]?.fsWritePolicy).toBeUndefined();
    expect(runnerRequests[0]?.sandboxMode).toBe("danger-full-access");
  });
});

/**
 * R7.1 — a lane that cannot establish enforcement fails CLOSED.
 *
 * The two ways establishment can fail are covered at the two layers that can
 * detect them: the adapter refuses a policy it cannot translate before it
 * reaches a provider, and a sandbox that the provider could not start comes
 * back as a failed turn. Both have to land on the cohort as an INFRASTRUCTURE
 * outcome — anything else spends a specialist's review budget on a lane that
 * never reviewed anything, and a lane that fell through to a verdict would have
 * reviewed unsandboxed.
 */
/**
 * Each backend's way of saying "the sandbox did not come up". They differ in
 * shape — Claude reports a failed result message, Codex a failed turn — so the
 * parity has to be asserted per backend rather than assumed from one of them.
 */
const induceSandboxUnavailable: Record<AgentBackendId, () => void> = {
  claude: () =>
    claudeQueryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "error_during_execution",
          session_id: "session-sandbox-unavailable",
          total_cost_usd: 0,
          num_turns: 0,
          duration_ms: 5,
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          errors: ["sandbox dependencies are unavailable"],
        };
      })(),
    ),
  codex: () => {
    codexTurn.behavior = "sandbox_unavailable";
  },
};

describe.each(["claude", "codex"] as const)(
  "fail-closed envelope establishment — %s",
  (backend) => {
    it("classifies a sandbox that could not start as an infrastructure outcome", async () => {
      induceSandboxUnavailable[backend]();

      const result = await runValidatorRaw(backend, "task");

      expect(result.result.kind).toBe("infra_error");
      // Never a verdict: an unsandboxed review is not a review this cohort
      // is allowed to count.
      expect(result.result.kind).not.toBe("pass");
      expect(result.result.kind).not.toBe("fail");
    });
  },
);
