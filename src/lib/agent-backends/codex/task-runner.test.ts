import { beforeEach, describe, expect, it, vi } from "vitest";

const startThreadMock = vi.fn();
const resumeThreadMock = vi.fn();
const runMock = vi.fn();
const runStreamedMock = vi.fn();

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

vi.mock("@/lib/shared/child-env", () => ({
  buildChildEnv: () => ({}),
}));

vi.mock("../registry-core", () => ({
  registerTaskRunner: vi.fn(),
}));

import { Codex } from "@openai/codex-sdk";
import { registerTaskRunner } from "../registry-core";
import { CodexTaskRunner, type CodexTaskRunnerDeps } from "./task-runner";
import type { AgentTaskRequest } from "../task";
import { getDefaultCodexModel } from "@/lib/agent-backends/schemas";

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
  let listNativeCodexMcpServers: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    listNativeCodexMcpServers = vi.fn().mockResolvedValue([]);
    runner = new CodexTaskRunner({
      createCodex: (options) =>
        new Codex(options) as unknown as ReturnType<
          CodexTaskRunnerDeps["createCodex"]
        >,
      buildChildEnv: () => ({}) as NodeJS.ProcessEnv,
      listNativeCodexMcpServers,
    });

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

  it("defaults to the global default codex model when no modelId is provided", async () => {
    await runner.run(makeRequest());

    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: getDefaultCodexModel() }),
    );
  });

  it("passes an explicit modelId to thread options", async () => {
    await runner.run(makeRequest({ modelId: "gpt-5.5" }));

    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.5" }),
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

  it("passes enabled=false entries for native Codex MCP servers not managed by Command Center", async () => {
    listNativeCodexMcpServers.mockResolvedValue([
      {
        name: "playwright",
        configEntry: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      },
      {
        name: "test-server",
        configEntry: { command: "node", args: ["server.js"] },
      },
      {
        name: "next-devtools",
        configEntry: {
          command: "npx",
          args: ["-y", "next-devtools-mcp@latest"],
        },
      },
    ]);

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

    expect(listNativeCodexMcpServers).toHaveBeenCalledWith({
      cwd: "/test/workspace",
      env: { CLAUDECODE: "" },
    });
    const codexCalls = vi.mocked(Codex).mock.calls;
    const passedOptions = codexCalls[0]![0]!;
    expect(passedOptions.config).toEqual({
      mcp_servers: {
        "test-server": {
          command: "node",
          args: ["server.js"],
        },
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp@latest"],
          enabled: false,
        },
        "next-devtools": {
          command: "npx",
          args: ["-y", "next-devtools-mcp@latest"],
          enabled: false,
        },
      },
    });
  });

  it("passes empty mcp_servers to Codex when no managed or native servers are present", async () => {
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

  it("captures turn.items as a lossless transcript", async () => {
    const items = [
      { type: "reasoning", text: "weigh AC vs prototype" },
      { type: "command_execution", command: "npm run verify", exit_code: 0 },
      { type: "agent_message", text: "GO" },
    ];
    runMock.mockResolvedValue({
      finalResponse: "GO",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      items,
    });

    const result = await runner.run(makeRequest());

    expect(result.transcript).toEqual([
      { seq: 0, backend: "codex", type: "reasoning", raw: items[0] },
      { seq: 1, backend: "codex", type: "command_execution", raw: items[1] },
      { seq: 2, backend: "codex", type: "agent_message", raw: items[2] },
    ]);
  });

  it("captures streamed items before a failed Codex turn", async () => {
    const items = [
      { type: "reasoning", text: "checking the repo" },
      { type: "command_execution", command: "npm run verify", exit_code: 1 },
    ];
    async function* events() {
      yield { type: "item.completed", item: items[0] };
      yield { type: "item.completed", item: items[1] };
      yield {
        type: "turn.failed",
        error: { message: "command failed" },
      };
    }
    runStreamedMock.mockResolvedValue({ events: events() });
    startThreadMock.mockReturnValue({
      id: "thread-abc",
      run: runMock,
      runStreamed: runStreamedMock,
    });

    const result = await runner.run(makeRequest());

    expect(runStreamedMock).toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(result.error).toBe("command failed");
    expect(result.transcript).toEqual([
      { seq: 0, backend: "codex", type: "reasoning", raw: items[0] },
      { seq: 1, backend: "codex", type: "command_execution", raw: items[1] },
    ]);
  });

  it("omits transcript when the turn returned no items", async () => {
    // Default runMock has no `items`.
    const result = await runner.run(makeRequest());
    expect(result.transcript).toBeUndefined();
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
