import { describe, it, expect } from "vitest";
import {
  compactionEventSchema,
  modelUsageEntrySchema,
  conversationMetricsSchema,
  conversationStateSchema,
  metricsUpdateEventSchema,
} from "./schemas";
import {
  extractResultMetrics,
  extractInitMetrics,
  extractCompactionEvent,
} from "./prompt";
import type { ConversationMetrics } from "@/types";
import type {
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
} from "@anthropic-ai/claude-agent-sdk";

// ===========================================================================
// Task 1.3: Unit tests for metrics schemas
// ===========================================================================

describe("conversationMetricsSchema", () => {
  it("parses a fully populated metrics object", () => {
    const full = {
      inputTokens: 85200,
      outputTokens: 12300,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 2000,
      contextWindow: 200000,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 85200,
          outputTokens: 12300,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 2000,
          costUSD: 0.45,
          contextWindow: 200000,
          maxOutputTokens: 16384,
        },
      },
      durationMs: 15000,
      durationApiMs: 12000,
      numTurns: 5,
      totalCostUsd: 0.45,
      model: "claude-sonnet-4-6",
      claudeCodeVersion: "1.0.25",
      tools: ["Read", "Write", "Bash"],
      mcpServers: [{ name: "next-devtools", status: "connected" }],
      compactionCount: 1,
      lastCompactionPreTokens: 180000,
      compactions: [
        {
          trigger: "auto",
          preTokens: 180000,
          timestamp: "2024-01-01T00:00:00Z",
        },
      ],
      stopReason: "end_turn",
      errorSubtype: null,
      permissionDenials: null,
    };

    const result = conversationMetricsSchema.parse(full);
    expect(result).toEqual(full);
  });

  it("parses with all fields set to null (initial state)", () => {
    const initial = {
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      contextWindow: null,
      modelUsage: null,
      durationMs: null,
      durationApiMs: null,
      numTurns: null,
      totalCostUsd: null,
      model: null,
      claudeCodeVersion: null,
      tools: null,
      mcpServers: null,
      compactionCount: 0,
      lastCompactionPreTokens: null,
      compactions: [],
      stopReason: null,
      errorSubtype: null,
      permissionDenials: null,
    };

    const result = conversationMetricsSchema.parse(initial);
    expect(result).toEqual(initial);
  });

  it("parses partial data (only init metadata, no result yet)", () => {
    const partial = {
      model: "claude-sonnet-4-6",
      claudeCodeVersion: "1.0.25",
      tools: ["Read", "Write"],
      mcpServers: [],
    };

    const result = conversationMetricsSchema.parse(partial);
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.claudeCodeVersion).toBe("1.0.25");
    expect(result.tools).toEqual(["Read", "Write"]);
    // Defaults applied
    expect(result.inputTokens).toBeNull();
    expect(result.compactionCount).toBe(0);
    expect(result.compactions).toEqual([]);
  });

  it("defaults compactionCount to 0 and compactions to empty array", () => {
    const result = conversationMetricsSchema.parse({});
    expect(result.compactionCount).toBe(0);
    expect(result.compactions).toEqual([]);
  });
});

describe("compactionEventSchema", () => {
  it("parses a valid compaction event", () => {
    const event = {
      trigger: "auto",
      preTokens: 180000,
      timestamp: "2024-01-01T00:00:00Z",
    };
    expect(compactionEventSchema.parse(event)).toEqual(event);
  });

  it("accepts manual trigger", () => {
    const event = {
      trigger: "manual",
      preTokens: 150000,
      timestamp: "2024-01-01T00:00:00Z",
    };
    expect(compactionEventSchema.parse(event)).toEqual(event);
  });
});

describe("modelUsageEntrySchema", () => {
  it("parses a valid model usage entry", () => {
    const entry = {
      inputTokens: 50000,
      outputTokens: 8000,
      cacheReadInputTokens: 3000,
      cacheCreationInputTokens: 1000,
      costUSD: 0.25,
      contextWindow: 200000,
      maxOutputTokens: 16384,
    };
    expect(modelUsageEntrySchema.parse(entry)).toEqual(entry);
  });
});

describe("conversationStateSchema with metrics", () => {
  const baseConversation = {
    id: "conv-123",
    claudeSessionId: null,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
  };

  it("defaults metrics to null when missing from input", () => {
    const result = conversationStateSchema.parse(baseConversation);
    expect(result.metrics).toBeNull();
  });

  it("parses conversation with metrics present", () => {
    const withMetrics = {
      ...baseConversation,
      metrics: {
        model: "claude-sonnet-4-6",
        totalCostUsd: 0.05,
        numTurns: 3,
      },
    };
    const result = conversationStateSchema.parse(withMetrics);
    expect(result.metrics).not.toBeNull();
    expect(result.metrics!.model).toBe("claude-sonnet-4-6");
    expect(result.metrics!.totalCostUsd).toBe(0.05);
    expect(result.metrics!.numTurns).toBe(3);
    expect(result.metrics!.compactionCount).toBe(0);
  });

  it("strips legacy totalCostUsd/totalDurationMs/totalTurns without errors", () => {
    const legacy = {
      ...baseConversation,
      totalCostUsd: 0.1,
      totalDurationMs: 5000,
      totalTurns: 4,
    };
    // Zod should strip unknown keys (they are no longer in the schema)
    const result = conversationStateSchema.parse(legacy);
    expect(result).not.toHaveProperty("totalCostUsd");
    expect(result).not.toHaveProperty("totalDurationMs");
    expect(result).not.toHaveProperty("totalTurns");
  });
});

// ===========================================================================
// Task 2.4: Unit tests for extraction functions
// ===========================================================================

function makeSuccessResult(
  overrides: Partial<SDKResultSuccess> = {},
): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 5000,
    duration_api_ms: 4000,
    is_error: false,
    num_turns: 3,
    result: "Done.",
    stop_reason: "end_turn",
    total_cost_usd: 0.05,
    usage: {
      inputTokens: 50000,
      outputTokens: 8000,
      cacheReadInputTokens: 3000,
      cacheCreationInputTokens: 1000,
      webSearchRequests: 0,
    },
    modelUsage: {
      "claude-sonnet-4-6": {
        inputTokens: 50000,
        outputTokens: 8000,
        cacheReadInputTokens: 3000,
        cacheCreationInputTokens: 1000,
        webSearchRequests: 0,
        costUSD: 0.05,
        contextWindow: 200000,
        maxOutputTokens: 16384,
      },
    },
    permission_denials: [],
    uuid: "test-uuid",
    session_id: "sess-1",
    ...overrides,
  } as SDKResultSuccess;
}

function makeErrorResult(
  overrides: Partial<SDKResultError> = {},
): SDKResultError {
  return {
    type: "result",
    subtype: "error_max_turns",
    duration_ms: 10000,
    duration_api_ms: 8000,
    is_error: true,
    num_turns: 50,
    stop_reason: null,
    total_cost_usd: 0.5,
    usage: {
      inputTokens: 200000,
      outputTokens: 40000,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 5000,
      webSearchRequests: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors: ["Max turns reached"],
    uuid: "test-uuid",
    session_id: "sess-1",
    ...overrides,
  } as SDKResultError;
}

describe("extractResultMetrics", () => {
  it("maps all fields from a success result", () => {
    const result = makeSuccessResult();
    const metrics = extractResultMetrics(result, null);

    expect(metrics.inputTokens).toBe(50000);
    expect(metrics.outputTokens).toBe(8000);
    expect(metrics.cacheReadInputTokens).toBe(3000);
    expect(metrics.cacheCreationInputTokens).toBe(1000);
    expect(metrics.totalCostUsd).toBe(0.05);
    expect(metrics.durationMs).toBe(5000);
    expect(metrics.durationApiMs).toBe(4000);
    expect(metrics.numTurns).toBe(3);
    expect(metrics.stopReason).toBe("end_turn");
    expect(metrics.contextWindow).toBe(200000);
    expect(metrics.modelUsage).toBeDefined();
    expect(metrics.modelUsage!["claude-sonnet-4-6"]!.costUSD).toBe(0.05);
  });

  it("accumulates cost, duration, and turns from existing metrics", () => {
    const existing: ConversationMetrics = conversationMetricsSchema.parse({
      totalCostUsd: 0.1,
      durationMs: 3000,
      durationApiMs: 2000,
      numTurns: 5,
    });

    const result = makeSuccessResult();
    const metrics = extractResultMetrics(result, existing);

    expect(metrics.totalCostUsd).toBeCloseTo(0.15, 10); // 0.10 + 0.05
    expect(metrics.durationMs).toBe(8000); // 3000 + 5000
    expect(metrics.durationApiMs).toBe(6000); // 2000 + 4000
    expect(metrics.numTurns).toBe(8); // 5 + 3
  });

  it("extracts errorSubtype from error result", () => {
    const result = makeErrorResult({ subtype: "error_max_budget_usd" });
    const metrics = extractResultMetrics(result, null);

    expect(metrics.errorSubtype).toBe("error_max_budget_usd");
    expect(metrics.totalCostUsd).toBe(0.5);
    expect(metrics.numTurns).toBe(50);
  });

  it("extracts permission denials as tool names only", () => {
    const result = makeSuccessResult({
      permission_denials: [
        {
          tool_name: "Bash",
          tool_use_id: "tu-1",
          tool_input: { command: "rm -rf /" },
        },
        {
          tool_name: "Write",
          tool_use_id: "tu-2",
          tool_input: { path: "/etc/passwd" },
        },
      ],
    });
    const metrics = extractResultMetrics(result, null);

    expect(metrics.permissionDenials).toEqual(["Bash", "Write"]);
  });

  it("handles null existing metrics (first prompt)", () => {
    const result = makeSuccessResult();
    const metrics = extractResultMetrics(result, null);

    expect(metrics.totalCostUsd).toBe(0.05);
    expect(metrics.durationMs).toBe(5000);
    expect(metrics.numTurns).toBe(3);
  });
});

describe("extractInitMetrics", () => {
  it("extracts model, version, tools, and MCP servers", () => {
    const init = {
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-6",
      claude_code_version: "1.0.25",
      tools: ["Read", "Write", "Bash", "Grep"],
      mcp_servers: [
        { name: "next-devtools", status: "connected" },
        { name: "chrome-devtools", status: "disconnected" },
      ],
      session_id: "sess-1",
      uuid: "u1",
    } as unknown as SDKSystemMessage;

    const metrics = extractInitMetrics(init);

    expect(metrics.model).toBe("claude-sonnet-4-6");
    expect(metrics.claudeCodeVersion).toBe("1.0.25");
    expect(metrics.tools).toEqual(["Read", "Write", "Bash", "Grep"]);
    expect(metrics.mcpServers).toEqual([
      { name: "next-devtools", status: "connected" },
      { name: "chrome-devtools", status: "disconnected" },
    ]);
  });
});

describe("extractCompactionEvent", () => {
  it("creates first compaction from null existing metrics", () => {
    const compact = {
      type: "system" as const,
      subtype: "compact_boundary" as const,
      compact_metadata: { trigger: "auto" as const, pre_tokens: 180000 },
      uuid: "u1",
      session_id: "sess-1",
    } as unknown as SDKCompactBoundaryMessage;

    const metrics = extractCompactionEvent(compact, null);

    expect(metrics.compactionCount).toBe(1);
    expect(metrics.lastCompactionPreTokens).toBe(180000);
    expect(metrics.compactions).toHaveLength(1);
    expect(metrics.compactions![0]!.trigger).toBe("auto");
    expect(metrics.compactions![0]!.preTokens).toBe(180000);
  });

  it("increments count and appends to existing compactions", () => {
    const existing: ConversationMetrics = conversationMetricsSchema.parse({
      compactionCount: 1,
      lastCompactionPreTokens: 150000,
      compactions: [
        {
          trigger: "auto",
          preTokens: 150000,
          timestamp: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const compact = {
      type: "system" as const,
      subtype: "compact_boundary" as const,
      compact_metadata: { trigger: "manual" as const, pre_tokens: 190000 },
      uuid: "u2",
      session_id: "sess-1",
    } as unknown as SDKCompactBoundaryMessage;

    const metrics = extractCompactionEvent(compact, existing);

    expect(metrics.compactionCount).toBe(2);
    expect(metrics.lastCompactionPreTokens).toBe(190000);
    expect(metrics.compactions).toHaveLength(2);
    expect(metrics.compactions![1]!.trigger).toBe("manual");
    expect(metrics.compactions![1]!.preTokens).toBe(190000);
  });
});

// ===========================================================================
// Task 4.2: SSE metrics event schema test
// ===========================================================================

describe("metricsUpdateEventSchema", () => {
  it("validates a metrics-update event with partial metrics", () => {
    const event = {
      type: "metrics-update",
      projectName: "my-project",
      sessionName: "feature-x",
      conversationId: "conv-123",
      metrics: {
        totalCostUsd: 0.05,
        numTurns: 3,
      },
    };

    const result = metricsUpdateEventSchema.parse(event);
    expect(result.type).toBe("metrics-update");
    expect(result.metrics.totalCostUsd).toBe(0.05);
  });
});
