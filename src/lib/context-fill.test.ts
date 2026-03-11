import { describe, it, expect } from "vitest";
import {
  extractContextTokens,
  extractContextWindow,
  computeContextFillPercent,
} from "./context-fill";
import { conversationStateSchema } from "./schemas";

// =============================================================================
// extractContextTokens
// =============================================================================

describe("extractContextTokens", () => {
  it("sums input + cache_read + cache_creation tokens", () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
    };
    expect(extractContextTokens(usage)).toBe(1250);
  });

  it("returns 0 for undefined usage", () => {
    expect(extractContextTokens(undefined)).toBe(0);
  });

  it("handles null optional fields", () => {
    const usage = {
      input_tokens: 500,
      output_tokens: 100,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    };
    expect(extractContextTokens(usage)).toBe(500);
  });
});

// =============================================================================
// extractContextWindow
// =============================================================================

describe("extractContextWindow", () => {
  it("returns contextWindow from first model entry", () => {
    const modelUsage = {
      "claude-sonnet-4-20250514": {
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.05,
        contextWindow: 200000,
        maxOutputTokens: 16384,
      },
    };
    expect(extractContextWindow(modelUsage)).toBe(200000);
  });

  it("returns null for undefined modelUsage", () => {
    expect(extractContextWindow(undefined)).toBeNull();
  });

  it("returns null for empty modelUsage", () => {
    expect(extractContextWindow({})).toBeNull();
  });
});

// =============================================================================
// computeContextFillPercent
// =============================================================================

describe("computeContextFillPercent", () => {
  it("computes correct percentage", () => {
    expect(computeContextFillPercent(100000, 200000)).toBe(50);
  });

  it("returns null when contextTokens is null", () => {
    expect(computeContextFillPercent(null, 200000)).toBeNull();
  });

  it("returns null when contextWindowMax is null", () => {
    expect(computeContextFillPercent(100000, null)).toBeNull();
  });

  it("returns null when contextWindowMax is 0", () => {
    expect(computeContextFillPercent(100000, 0)).toBeNull();
  });

  it("handles 100% fill", () => {
    expect(computeContextFillPercent(200000, 200000)).toBe(100);
  });
});

// =============================================================================
// ConversationState schema extension
// =============================================================================

describe("conversationStateSchema context fields", () => {
  it("accepts contextTokens and contextWindowMax", () => {
    const base = {
      id: "test-id",
      claudeSessionId: null,
      transcriptPath: null,
      status: "awaiting" as const,
      promptCount: 0,
      createdAt: "2025-01-01T00:00:00Z",
      lastActivityAt: "2025-01-01T00:00:00Z",
      contextTokens: 50000,
      contextWindowMax: 200000,
    };
    const result = conversationStateSchema.parse(base);
    expect(result.contextTokens).toBe(50000);
    expect(result.contextWindowMax).toBe(200000);
  });

  it("defaults contextTokens and contextWindowMax to null", () => {
    const base = {
      id: "test-id",
      claudeSessionId: null,
      transcriptPath: null,
      status: "awaiting" as const,
      promptCount: 0,
      createdAt: "2025-01-01T00:00:00Z",
      lastActivityAt: "2025-01-01T00:00:00Z",
    };
    const result = conversationStateSchema.parse(base);
    expect(result.contextTokens).toBeNull();
    expect(result.contextWindowMax).toBeNull();
  });
});
