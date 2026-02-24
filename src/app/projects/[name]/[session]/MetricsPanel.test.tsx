// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import MetricsPanel from "./MetricsPanel";
import type { ConversationMetrics } from "@/types";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const fullMetrics: ConversationMetrics = {
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
  durationMs: 135000,
  durationApiMs: 98000,
  numTurns: 12,
  totalCostUsd: 0.45,
  model: "claude-sonnet-4-6",
  claudeCodeVersion: "1.0.25",
  tools: ["Read", "Write", "Bash"],
  mcpServers: [
    { name: "next-devtools", status: "connected" },
    { name: "chrome-devtools", status: "disconnected" },
  ],
  compactionCount: 2,
  lastCompactionPreTokens: 190000,
  compactions: [
    { trigger: "auto", preTokens: 180000, timestamp: "2024-06-15T10:30:00Z" },
    { trigger: "manual", preTokens: 190000, timestamp: "2024-06-15T11:00:00Z" },
  ],
  stopReason: "end_turn",
  errorSubtype: null,
  permissionDenials: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MetricsPanel", () => {
  it("renders placeholder when metrics are null", () => {
    render(<MetricsPanel metrics={null} />);
    expect(screen.getByText("No metrics yet")).toBeDefined();
  });

  it("renders formatted token counts", () => {
    render(<MetricsPanel metrics={fullMetrics} />);
    expect(screen.getByText("85,200")).toBeDefined();
    expect(screen.getByText("12,300")).toBeDefined();
    expect(screen.getByText("200,000")).toBeDefined();
  });

  it("renders cache token counts", () => {
    render(<MetricsPanel metrics={fullMetrics} />);
    expect(screen.getByText("5,000")).toBeDefined();
    expect(screen.getByText("2,000")).toBeDefined();
  });

  it("renders formatted cost", () => {
    render(<MetricsPanel metrics={fullMetrics} />);
    expect(screen.getByText("$0.45")).toBeDefined();
  });

  it("renders timing values", () => {
    render(<MetricsPanel metrics={fullMetrics} />);
    // 135000ms = 2m 15s
    expect(screen.getByText("2m 15s")).toBeDefined();
    // 98000ms = 1m 38s
    expect(screen.getByText("1m 38s")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
  });

  it("renders session info", () => {
    render(<MetricsPanel metrics={fullMetrics} />);
    expect(screen.getByText("claude-sonnet-4-6")).toBeDefined();
    expect(screen.getByText("1.0.25")).toBeDefined();
  });

  it("renders MCP server badges", () => {
    render(<MetricsPanel metrics={fullMetrics} />);
    expect(screen.getByText("next-devtools")).toBeDefined();
    expect(screen.getByText("chrome-devtools")).toBeDefined();
  });

  it("renders compaction info when present", () => {
    render(<MetricsPanel metrics={fullMetrics} />);
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("190,000")).toBeDefined();
  });

  it("renders stop reason when present", () => {
    render(<MetricsPanel metrics={fullMetrics} />);
    expect(screen.getByText("end_turn")).toBeDefined();
  });

  it("renders error subtype badge", () => {
    const errorMetrics: ConversationMetrics = {
      ...fullMetrics,
      stopReason: null,
      errorSubtype: "error_max_turns",
      permissionDenials: ["Bash", "Write"],
    };
    render(<MetricsPanel metrics={errorMetrics} />);
    expect(screen.getByText("error_max_turns")).toBeDefined();
    expect(screen.getByText("Bash")).toBeDefined();
    expect(screen.getByText("Write")).toBeDefined();
  });

  it("renders per-model cost breakdown for multi-model conversations", () => {
    const multiModel: ConversationMetrics = {
      ...fullMetrics,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 60000,
          outputTokens: 8000,
          cacheReadInputTokens: 3000,
          cacheCreationInputTokens: 1000,
          costUSD: 0.3,
          contextWindow: 200000,
          maxOutputTokens: 16384,
        },
        "claude-haiku-4-5": {
          inputTokens: 25200,
          outputTokens: 4300,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 1000,
          costUSD: 0.15,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        },
      },
    };
    render(<MetricsPanel metrics={multiModel} />);
    expect(screen.getByText("$0.30")).toBeDefined();
    expect(screen.getByText("$0.15")).toBeDefined();
  });

  it("does not render compaction section when count is 0", () => {
    const noCompaction: ConversationMetrics = {
      ...fullMetrics,
      compactionCount: 0,
      lastCompactionPreTokens: null,
      compactions: [],
    };
    const { container } = render(<MetricsPanel metrics={noCompaction} />);
    expect(container.querySelector(".mp-compaction")).toBeNull();
  });

  it("does not render stop section when no stop/error/denial info", () => {
    const clean: ConversationMetrics = {
      ...fullMetrics,
      stopReason: null,
      errorSubtype: null,
      permissionDenials: null,
    };
    const { container } = render(<MetricsPanel metrics={clean} />);
    expect(container.querySelector(".mp-stop")).toBeNull();
  });
});
