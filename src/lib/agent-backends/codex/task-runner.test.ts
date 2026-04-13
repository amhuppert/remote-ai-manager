import { beforeEach, describe, expect, it, vi } from "vitest";

const startThreadMock = vi.fn();
const resumeThreadMock = vi.fn();
const runMock = vi.fn();

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn().mockImplementation(() => ({
    startThread: startThreadMock,
    resumeThread: resumeThreadMock,
  })),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@/lib/child-env", () => ({
  buildChildEnv: () => ({}),
}));

vi.mock("../registry-core", () => ({
  registerTaskRunner: vi.fn(),
}));

import { registerTaskRunner } from "../registry-core";
import { CodexTaskRunner } from "./task-runner";
import type { AgentTaskRequest } from "../task";

function makeRequest(overrides?: Partial<AgentTaskRequest>): AgentTaskRequest {
  return {
    workingDirectory: "/test/workspace",
    prompt: "Do the thing",
    timeoutMs: 30_000,
    autonomous: true,
    ...overrides,
  };
}

it("registers the codex task runner in the registry on module load", () => {
  expect(vi.mocked(registerTaskRunner)).toHaveBeenCalledWith(
    expect.objectContaining({ backend: "codex" }),
  );
});

describe("CodexTaskRunner", () => {
  let runner: CodexTaskRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new CodexTaskRunner();

    startThreadMock.mockReturnValue({
      id: "thread-abc",
      run: runMock,
    });
    resumeThreadMock.mockReturnValue({
      id: "thread-resumed",
      run: runMock,
    });
    runMock.mockResolvedValue({
      finalResponse: "done",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 7,
      },
    });
  });

  it("passes modelReasoningEffort to thread options", async () => {
    await runner.run(makeRequest({ reasoningEffort: "high" }));

    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelReasoningEffort: "high" }),
    );
  });

  it("fails fast when reasoning effort is invalid", async () => {
    const result = await runner.run(makeRequest({ reasoningEffort: "max" }));

    expect(startThreadMock).not.toHaveBeenCalled();
    expect(result.error).toContain('Invalid Codex reasoning effort: "max"');
  });
});
