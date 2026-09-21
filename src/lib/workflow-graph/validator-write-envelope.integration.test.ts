/** The real validator, conversation actor, facade and provider adapters carry one write envelope. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  resolveSettings: async () => ({
    effective: {},
    provenance: {},
    sources: [],
  }),
}));
vi.mock("@/lib/shared/sdk-env", () => ({}));

import type { ConversationBackendCreateInput } from "@/lib/agent-backends/conversation";
import { createScriptedConversationBackend } from "@/lib/agent-backends/testing/scripted-conversation-backends";
import {
  recordServerBaseUrl,
  _resetServerBaseUrlForTesting,
} from "@/lib/agent-gateway/server-url";
import { WHOLE_TREE_CANDIDATE_SCOPE } from "@/lib/git/diff";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { AgentCallRequest } from "@/lib/workflows/primitives/agent-call-vocabulary";
import { createTestGraphExecutionContract } from "./testing/execution-contract";
import { createValidatorRunner } from "./validator-runner";
import {
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "./test-fixtures";

const PROJECT = "/repo-write-envelope";
const SESSION = "envelope-session";
const VERDICT_TEXT = JSON.stringify({
  summary: "ok",
  issues: [],
  advisories: [],
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  _resetServerBaseUrlForTesting();
});

async function runValidator(
  backend: "claude" | "codex",
  sandboxUnavailable = false,
  unrestricted = false,
) {
  const root = mkdtempSync(path.join(tmpdir(), "cc-validator-envelope-"));
  roots.push(root);
  const worktreePath = path.join(root, "worktree");
  const scratch = path.join(root, "scratch");
  const temporary = path.join(scratch, "tmp");
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  const policy = {
    mode: "allowlist" as const,
    allowWrite: [scratch, temporary],
    denyWrite: [worktreePath],
  };
  const provider = createScriptedConversationBackend({
    backend,
    responseText: VERDICT_TEXT,
    sandboxUnavailable,
  });
  recordServerBaseUrl({ CC_SERVER_URL: "http://127.0.0.1:3000" });
  const runtimeInputs: ConversationBackendCreateInput[] = [];
  const neutralCalls: AgentCallRequest[] = [];
  const validator = makeSeededValidatorAssignment({
    id: "reviewer",
    authority: "blocking",
    agent: {
      backend,
      modelSelection:
        backend === "claude"
          ? { modelId: "sonnet", parameters: { effort: "medium" } }
          : {
              modelId: "gpt-5.4",
              parameters: { reasoning: "medium", fast: "false" },
            },
    },
  });
  const lifecycle = await createLifecycleFixture({
    address: {
      projectPath: PROJECT,
      target: {
        scope: "session",
        projectName: "test-project",
        sessionName: SESSION,
        conversationId: "lane-conversation-1",
      },
    },
    conversation: {
      agentBackend: backend,
      backendRef: null,
      role: unrestricted ? "iteration" : "validator",
      profileSnapshot: validator.profileSnapshot,
    },
    actorDeps: {
      getProjectDisplayName: () => "test-project",
      composePortableMcpForConversation: async () => ({ servers: [] }),
      getConversationBackendFactory: () => ({
        ...provider.factory,
        async createRuntime(input) {
          runtimeInputs.push(input);
          return provider.factory.createRuntime(input);
        },
      }),
      async executeAgentCall(request, deps) {
        neutralCalls.push(request);
        return executeAgentCall(request, deps);
      },
    },
  });
  try {
    const execution = createWorkflowExecution();
    const context = execution.workingDefinition.executionContexts[0];
    if (!context) throw new Error("fixture context missing");
    context.contextValidator = { enabled: true, assignments: [validator] };
    const runner = createValidatorRunner({
      executionContract: createTestGraphExecutionContract(),
      resolveWorktreePath: async () => worktreePath,
      getProjectDisplayName: () => "test-project",
      executeConversationTurn: lifecycle.manager.executeConversationTurn,
      stopConversationActor: lifecycle.manager.stopConversationActor,
      computeValidationDiffScope: async () => ({
        kind: "unavailable",
        candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
        reason: "test",
      }),
      readLaneConversation: async () => null,
      readValidatorConversationTelemetry: async () => null,
      composeLaneWriteEnvelope: () => ({
        policy,
        laneScratchDir: scratch,
        laneTmpDir: temporary,
      }),
      continuityService: {
        ensureValidatorConversation: async () => ({
          execution,
          sessionAction: "create",
          backend,
          conversationId: "lane-conversation-1",
        }),
      },
    });
    const result = unrestricted
      ? await lifecycle.manager.executeConversationTurn({
          binding: { ...lifecycle.binding, worktreePath },
          turn: {
            kind: "conversation_turn",
            backend,
            promptText: "implement the task",
            modelSelection: validator.agent.modelSelection,
            autonomous: true,
          },
          executionContext: {
            workflowContext: {
              executionId: execution.id,
              contextId: context.id,
            },
          },
        })
      : await runner.runContextValidator({
          projectPath: PROJECT,
          sessionName: SESSION,
          execution,
          context,
          validator,
        });
    return {
      result,
      neutralCalls,
      runtimeInputs,
      policy,
      worktreePath,
      claudeOptions: provider.claudeOptions,
      codexThreadRequest: provider.codexThreadRequest,
    };
  } finally {
    await lifecycle.close();
    provider.close();
  }
}

function conversationRequest(calls: AgentCallRequest[]) {
  const request = calls[0];
  if (!request || request.kind !== "conversation_turn")
    throw new Error("expected a conversation turn at the facade boundary");
  return request;
}

for (const backend of ["claude", "codex"] as const) {
  describe(`validator write envelope — ${backend}`, () => {
    it("carries the server-derived write policy through the neutral boundary into the provider runtime", async () => {
      const run = await runValidator(backend);
      expect(run.result, JSON.stringify(run.result)).toMatchObject({
        result: { kind: "pass" },
      });
      expect(conversationRequest(run.neutralCalls).fsWritePolicy).toEqual(
        run.policy,
      );
      expect(run.runtimeInputs).toHaveLength(1);
      expect(run.runtimeInputs[0]?.fsWritePolicy).toEqual(run.policy);
      expect(run.runtimeInputs[0]?.executionClass).toBe("governed-execution");
      if (backend === "claude") {
        expect(run.claudeOptions?.sandbox?.filesystem?.allowWrite).toEqual(
          run.policy.allowWrite,
        );
        expect(run.claudeOptions?.sandbox?.filesystem?.denyWrite).toEqual(
          run.policy.denyWrite,
        );
        expect(run.claudeOptions?.sandbox?.failIfUnavailable).toBe(true);
      } else {
        const thread = run.codexThreadRequest;
        expect(thread?.sandbox).toBe("workspace-write");
        const config = z.record(z.string(), z.unknown()).parse(thread?.config);
        expect(config.sandbox_workspace_write).toMatchObject({
          writable_roots: run.policy.allowWrite,
          exclude_slash_tmp: true,
          exclude_tmpdir_env_var: true,
        });
      }
    });

    it("never carries the unrestricted implementer configuration or makes the candidate worktree writable", async () => {
      const run = await runValidator(backend);
      expect(run.result, JSON.stringify(run.result)).toMatchObject({
        result: { kind: "pass" },
      });
      expect(conversationRequest(run.neutralCalls).writeCapability).toBe(
        "read_only",
      );
      expect(run.runtimeInputs[0]?.fsWritePolicy?.allowWrite).not.toContain(
        run.worktreePath,
      );
      expect(run.runtimeInputs[0]?.fsWritePolicy?.denyWrite).toContain(
        run.worktreePath,
      );
      if (backend === "claude") {
        expect(run.claudeOptions?.permissionMode).toBe("dontAsk");
        expect(run.claudeOptions?.allowDangerouslySkipPermissions).not.toBe(
          true,
        );
        expect(run.claudeOptions?.cwd).not.toBe(run.worktreePath);
      } else {
        const thread = run.codexThreadRequest;
        expect(thread?.sandbox).not.toBe("danger-full-access");
        expect(thread?.cwd).not.toBe(run.worktreePath);
      }
    });

    it("classifies a sandbox that could not start as an infrastructure outcome", async () => {
      const run = await runValidator(backend, true);
      expect(run.result, JSON.stringify(run.result)).toMatchObject({
        result: { kind: "infra_error" },
      });
      expect(run.runtimeInputs).toHaveLength(1);
    });
  });
}

it("keeps unrestricted implementer conversations write-capable without a write policy", async () => {
  const run = await runValidator("claude", false, true);
  expect(run.result, JSON.stringify(run.result)).toMatchObject({
    kind: "settled",
    turn: {
      outcome: {
        kind: "call_result",
        result: { outcome: { kind: "completed" } },
      },
    },
  });
  expect(conversationRequest(run.neutralCalls).writeCapability).toBe(
    "write_capable",
  );
  expect(run.runtimeInputs[0]?.fsWritePolicy).toBeUndefined();
  expect(run.claudeOptions?.permissionMode).toBe("bypassPermissions");
});
