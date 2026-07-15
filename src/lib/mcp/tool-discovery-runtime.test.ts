import { describe, expect, it, vi } from "vitest";

import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { McpDiscoveredTool } from "@/lib/mcp/schemas";
import { createClaudeRuntimeToolSource } from "./tool-discovery-runtime";

function makeRuntime(
  partial: Partial<ConversationBackendRuntime> & {
    listMcpServerTools?: (
      serverKey: string,
    ) => Promise<McpDiscoveredTool[] | undefined>;
  },
): ConversationBackendRuntime {
  return {
    backend: partial.backend ?? "claude",
    status: partial.status ?? "alive",
    modelId: partial.modelId,
    reasoningEffort: partial.reasoningEffort,
    outputFormat: partial.outputFormat,
    sendTurn: partial.sendTurn ?? vi.fn(),
    close: partial.close ?? vi.fn(),
    ...(partial.queueUserInput
      ? { queueUserInput: partial.queueUserInput }
      : {}),
    ...(partial.applyPortableMcpConfig
      ? { applyPortableMcpConfig: partial.applyPortableMcpConfig }
      : {}),
    ...(partial.listMcpServerTools
      ? { listMcpServerTools: partial.listMcpServerTools }
      : {}),
  } as ConversationBackendRuntime;
}

describe("createClaudeRuntimeToolSource", () => {
  it("returns tools reported by the live runtime for the requested server", async () => {
    const tools: McpDiscoveredTool[] = [{ name: "t1" }, { name: "t2" }];
    const runtime = makeRuntime({
      listMcpServerTools: async (key) => (key === "srv" ? tools : undefined),
    });
    const source = createClaudeRuntimeToolSource({
      getRuntime: (id) => (id === "conv-1" ? runtime : undefined),
    });

    const result = await source.listToolsFromActiveRuntime({
      conversationId: "conv-1",
      serverKey: "srv",
    });

    expect(result).toEqual(tools);
  });

  it("returns undefined when no runtime is registered for the conversation", async () => {
    const source = createClaudeRuntimeToolSource({
      getRuntime: () => undefined,
    });

    const result = await source.listToolsFromActiveRuntime({
      conversationId: "missing",
      serverKey: "srv",
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when the runtime is not a Claude backend", async () => {
    const runtime = makeRuntime({
      backend: "codex",
      listMcpServerTools: async () => [{ name: "should-not-be-returned" }],
    });
    const source = createClaudeRuntimeToolSource({
      getRuntime: () => runtime,
    });

    const result = await source.listToolsFromActiveRuntime({
      conversationId: "conv-1",
      serverKey: "srv",
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when the runtime is dead", async () => {
    const runtime = makeRuntime({
      status: "dead",
      listMcpServerTools: async () => [{ name: "should-not-be-returned" }],
    });
    const source = createClaudeRuntimeToolSource({
      getRuntime: () => runtime,
    });

    const result = await source.listToolsFromActiveRuntime({
      conversationId: "conv-1",
      serverKey: "srv",
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when the runtime does not implement listMcpServerTools", async () => {
    const runtime = makeRuntime({});
    const source = createClaudeRuntimeToolSource({
      getRuntime: () => runtime,
    });

    const result = await source.listToolsFromActiveRuntime({
      conversationId: "conv-1",
      serverKey: "srv",
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when the runtime reports nothing for the server", async () => {
    const runtime = makeRuntime({
      listMcpServerTools: async () => undefined,
    });
    const source = createClaudeRuntimeToolSource({
      getRuntime: () => runtime,
    });

    const result = await source.listToolsFromActiveRuntime({
      conversationId: "conv-1",
      serverKey: "missing-server",
    });

    expect(result).toBeUndefined();
  });

  it("swallows runtime errors and falls back to undefined", async () => {
    const runtime = makeRuntime({
      listMcpServerTools: async () => {
        throw new Error("boom");
      },
    });
    const source = createClaudeRuntimeToolSource({
      getRuntime: () => runtime,
    });

    const result = await source.listToolsFromActiveRuntime({
      conversationId: "conv-1",
      serverKey: "srv",
    });

    expect(result).toBeUndefined();
  });
});
