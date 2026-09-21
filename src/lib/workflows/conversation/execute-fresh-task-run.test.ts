import { expect, it, vi } from "vitest";
import { executeFreshTaskRun } from "./execute-fresh-task-run";
import type { AgentTaskRequest } from "@/lib/agent-backends/task";
const input = {
  projectPath: "/repo",
  sessionName: "lane",
  identityConversationId: "implementer",
  worktreePath: "/merge-worktree",
  prompt: "Return the answer",
  timeoutMs: 4567,
  structuredOutputTurns: "single" as const,
  outputFormat: {
    type: "json_schema" as const,
    schema: {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "number" } },
      additionalProperties: false,
    },
  },
};
const resolveIdentity = async () => ({
  backend: "claude" as const,
  modelSelection: { modelId: "opus", parameters: { effort: "high" } },
});

it("runs the shared structured-output gate in the merge worktree without resuming the source lane", async () => {
  let request: AgentTaskRequest | undefined;
  const result = await executeFreshTaskRun(input, {
    resolveIdentity,
    runTask: async (_backend, value) => {
      request = value;
      return {
        text: '{"answer":4}',
        usage: { costUsd: 0.4, inputTokens: 12, outputTokens: 5 },
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      };
    },
  });
  expect(result).toMatchObject({
    kind: "structured",
    structuredOutput: { answer: 4 },
    parse: { source: "raw_json" },
    usage: { costUsd: 0.4, inputTokens: 12, outputTokens: 5 },
  });
  expect(request).toMatchObject({
    workingDirectory: "/merge-worktree",
    timeoutMs: 4567,
    autonomous: true,
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
  });
  expect(request?.resumeRef).toBeUndefined();
});

it("returns schema rejection evidence when a fresh task violates its output contract", async () => {
  const runTask = vi.fn(async () => ({
    text: '{"answer":"wrong"}',
    usage: { costUsd: 0.2 },
    error: null,
    timedOut: false,
    failure: null,
    continuationDisposition: "retain" as const,
  }));
  const result = await executeFreshTaskRun(input, { resolveIdentity, runTask });
  expect(result).toMatchObject({
    kind: "error",
    failure: { kind: "schema_validation" },
    text: '{"answer":"wrong"}',
  });
  if (result.kind !== "error") throw new Error("Expected schema rejection");
  expect(result.structuredOutputIssues?.join("\n")).toContain("answer");
});

it("retains partial text and usage and distinguishes cancellation from a timeout", async () => {
  const controller = new AbortController();
  const result = await executeFreshTaskRun(
    { ...input, signal: controller.signal },
    {
      resolveIdentity,
      runTask: async () => {
        controller.abort();
        return {
          text: "partial work",
          usage: { costUsd: 0.3, outputTokens: 7 },
          error: "transport teardown",
          timedOut: true,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    },
  );
  expect(result).toMatchObject({
    kind: "error",
    aborted: true,
    failure: { kind: "aborted" },
    text: "partial work",
    usage: { costUsd: 0.3, outputTokens: 7 },
  });
});
