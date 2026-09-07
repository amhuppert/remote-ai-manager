import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFsWritePolicy } from "@/lib/agent-backends/fs-write-policy";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  TaskRunResult,
  TaskRunUsage,
} from "@/lib/workflows/conversation/turn-result";
import { createPlanRepairAgentRunner } from "./agent-runner";
import type { PlanRepairAgentInvocation } from "./supervisor";

const USAGE: TaskRunUsage = {
  costUsd: 0.42,
  durationMs: 1000,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: 100,
  outputTokens: 50,
  cachedInputTokens: null,
};

const VERDICT = {
  planningDefect: true,
  diagnosis: "AC references a removed endpoint",
  operations: [
    {
      type: "update-context",
      contextId: "ctx-1",
      acceptanceCriteria: "Achievable criteria",
    },
  ],
};

const AGENT_OUTPUT = {
  planningDefect: VERDICT.planningDefect,
  diagnosis: VERDICT.diagnosis,
  operations: VERDICT.operations.map(({ type, ...payload }) => ({
    type,
    payload: JSON.stringify(payload),
  })),
};

/**
 * A real directory, because the write envelope the dispatch composes is
 * canonicalized against it: a fake path would prove the runner passes SOME
 * policy, never that the policy actually confines the repair turn.
 */
let worktreePath = "";

beforeEach(() => {
  worktreePath = realpathSync(mkdtempSync(path.join(tmpdir(), "plan-repair-")));
});

afterEach(() => {
  rmSync(worktreePath, { recursive: true, force: true });
  rmSync(
    path.join(realpathSync(tmpdir()), "cc-implementer-contexts", "exec-1"),
    {
      recursive: true,
      force: true,
    },
  );
});

function makeInvocation(
  overrides: Partial<PlanRepairAgentInvocation> = {},
): PlanRepairAgentInvocation {
  return {
    projectPath: "/p",
    sessionName: "s",
    executionId: "exec-1",
    contextId: "ctx-1",
    conversationId: "__plan_repair__:exec-1:ctx-1:1",
    worktreePath,
    prompt: "diagnose this halt",
    agent: {
      backend: "claude",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    },
    timeoutMs: 900_000,
    ...overrides,
  };
}

function makeRunner(result: TaskRunResult) {
  const calls: ExecuteWorkflowTaskRunInput[] = [];
  const runner = createPlanRepairAgentRunner({
    executeWorkflowTaskRun: (input) => {
      calls.push(input);
      return Promise.resolve(result);
    },
    getProjectDisplayName: () => "proj",
  });
  return { runner, calls };
}

describe("plan-repair agent runner", () => {
  it("dispatches an ephemeral session-scoped one-shot with the verdict schema and agent config", async () => {
    const { runner, calls } = makeRunner({
      kind: "structured",
      structuredOutput: AGENT_OUTPUT,
      text: "",
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    });

    const result = await runner(makeInvocation());

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.verdict.planningDefect).toBe(true);
    expect(result.verdict.operations).toHaveLength(1);
    expect(result.conversationId).toBe("__plan_repair__:exec-1:ctx-1:1");

    const call = calls[0]!;
    expect(call.kind).toBe("task_run");
    expect(call.modelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
    expect(call.timeoutMs).toBe(900_000);
    expect(call.outputFormat?.type).toBe("json_schema");
    const schema = call.outputFormat?.schema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["planningDefect", "diagnosis", "operations"]),
    );
    expect(call.binding.kind).toBe("ephemeral");
    expect(call.binding.address.target.scope).toBe("session");
    expect(call.binding.worktreePath).toBe(worktreePath);
    expect(call.origin).toMatchObject({ source: "workflow" });
  });

  it("confines the repair turn to a session-reader envelope: scratch and tmp only, git denied", async () => {
    const { runner, calls } = makeRunner({
      kind: "structured",
      structuredOutput: AGENT_OUTPUT,
      text: "",
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    });

    await runner(makeInvocation());

    const policy = calls[0]?.fsWritePolicy;
    expect(policy).toBeDefined();
    if (policy === undefined) return;
    expect(policy.mode).toBe("allowlist");
    // A repair agent edits the PLAN through live-edit operations; it never
    // needs a repository write, so nothing inside the worktree is writable and
    // repository metadata is denied outright.
    expect(policy.denyWrite).toEqual([path.join(worktreePath, ".git")]);
    for (const allowed of policy.allowWrite ?? []) {
      expect(
        allowed === worktreePath ||
          allowed.startsWith(`${worktreePath}${path.sep}`),
      ).toBe(false);
    }
    expect(policy.allowWrite).toHaveLength(2);
    expect(checkFsWritePolicy(policy)).toEqual({ kind: "ok" });
  });

  it("fails closed when the envelope cannot be established, dispatching no turn", async () => {
    const { runner, calls } = makeRunner({
      kind: "structured",
      structuredOutput: AGENT_OUTPUT,
      text: "",
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    });

    const result = await runner(
      makeInvocation({
        worktreePath: path.join(worktreePath, "gone"),
      }),
    );

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("write envelope"),
    });
    expect(calls).toHaveLength(0);
  });

  it("recovers the verdict from text output when no native structured payload exists", async () => {
    const { runner } = makeRunner({
      kind: "text",
      text: JSON.stringify(AGENT_OUTPUT),
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    });

    const result = await runner(makeInvocation());
    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.verdict.diagnosis).toBe("AC references a removed endpoint");
  });

  it("maps a turn error to an error result", async () => {
    const { runner } = makeRunner({
      kind: "error",
      error: "timed out after 900000ms",
      aborted: false,
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    });

    const result = await runner(makeInvocation());
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("timed out"),
    });
  });

  it("maps an unparseable verdict to an error result", async () => {
    const { runner } = makeRunner({
      kind: "text",
      text: "I could not decide.",
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    });

    const result = await runner(makeInvocation());
    expect(result.kind).toBe("error");
  });
});
