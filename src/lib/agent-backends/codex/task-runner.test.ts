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

import { Codex } from "@openai/codex-sdk";
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

  it("passes populated mcp_servers to Codex when portableMcp translates to a non-empty map", async () => {
    await runner.run(
      makeRequest({
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "test-server",
                transport: "stdio",
                command: "node",
                args: ["server.js"],
              },
            ],
          },
        },
      }),
    );

    const codexCalls = vi.mocked(Codex).mock.calls;
    expect(codexCalls).toHaveLength(1);
    const passedOptions = codexCalls[0]![0]!;
    expect(passedOptions).toHaveProperty("config");
    expect(passedOptions.config).toEqual({
      mcp_servers: {
        "test-server": {
          command: "node",
          args: ["server.js"],
        },
      },
    });
  });

  it("passes empty mcp_servers to Codex when portableMcp translates to an empty map (suppresses ~/.codex/config.toml fallback)", async () => {
    await runner.run(
      makeRequest({
        tooling: {
          portableMcp: { servers: [] },
        },
      }),
    );

    const codexCalls = vi.mocked(Codex).mock.calls;
    expect(codexCalls).toHaveLength(1);
    const passedOptions = codexCalls[0]![0]!;
    expect(passedOptions).toHaveProperty("config");
    expect(passedOptions.config).toEqual({ mcp_servers: {} });
  });

  it("omits config entirely when no portableMcp is provided", async () => {
    await runner.run(makeRequest());

    const codexCalls = vi.mocked(Codex).mock.calls;
    expect(codexCalls).toHaveLength(1);
    const passedOptions = codexCalls[0]![0]!;
    expect(passedOptions).not.toHaveProperty("config");
  });

  it("does not abort immediately when timeoutMs is 0 (no timeout)", async () => {
    // timeoutMs=0 means "no timeout" — the task should run to completion.
    // Use a real async delay so setTimeout(0) has a chance to fire first
    // (simulating the real-world case where thread.run() does async work).
    runMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                finalResponse: "done",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                },
              }),
            50,
          ),
        ),
    );

    const result = await runner.run(makeRequest({ timeoutMs: 0 }));

    expect(result.timedOut).toBe(false);
    expect(result.text).toBe("done");
    expect(result.error).toBeNull();
  });
});
