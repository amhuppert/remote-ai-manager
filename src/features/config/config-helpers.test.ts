import { describe, it, expect } from "vitest";
import {
  formatFieldLabel,
  msToMinutes,
  minutesToMs,
  validateNumericInput,
  getModelOptionsForBackend,
  getEffortOptionsForBackend,
} from "./config-helpers";

// ---------------------------------------------------------------------------
// formatFieldLabel
// ---------------------------------------------------------------------------

describe("formatFieldLabel", () => {
  it("converts simple camelCase to Title Case", () => {
    expect(formatFieldLabel("baseDir")).toBe("Base Dir");
  });

  it("converts multi-word camelCase", () => {
    expect(formatFieldLabel("defaultModel")).toBe("Default Model");
    expect(formatFieldLabel("defaultEffort")).toBe("Default Effort");
    expect(formatFieldLabel("branchPrefix")).toBe("Branch Prefix");
  });

  it("handles long camelCase names", () => {
    expect(formatFieldLabel("maxConcurrentQueries")).toBe(
      "Max Concurrent Queries",
    );
    expect(formatFieldLabel("defaultAgentBackend")).toBe(
      "Default Agent Backend",
    );
  });

  it("strips trailing Ms suffix for duration fields", () => {
    expect(formatFieldLabel("claudeTimeoutMs")).toBe("Claude Timeout");
    expect(formatFieldLabel("preMergeTimeoutMs")).toBe("Pre Merge Timeout");
    expect(formatFieldLabel("idleQuerySessionTtlMs")).toBe(
      "Idle Query Session TTL",
    );
  });

  it("recognizes common acronyms", () => {
    expect(formatFieldLabel("serverUrl")).toBe("Server URL");
    expect(formatFieldLabel("idleQuerySessionTtlMs")).toBe(
      "Idle Query Session TTL",
    );
  });

  it("capitalizes single-word labels", () => {
    expect(formatFieldLabel("enabled")).toBe("Enabled");
    expect(formatFieldLabel("provider")).toBe("Provider");
    expect(formatFieldLabel("topic")).toBe("Topic");
    expect(formatFieldLabel("model")).toBe("Model");
    expect(formatFieldLabel("type")).toBe("Type");
    expect(formatFieldLabel("timeout")).toBe("Timeout");
  });

  it("handles trigger names", () => {
    expect(formatFieldLabel("jobCompleted")).toBe("Job Completed");
    expect(formatFieldLabel("waitingForInput")).toBe("Waiting For Input");
    expect(formatFieldLabel("workflowCompleted")).toBe("Workflow Completed");
    expect(formatFieldLabel("workflowHalted")).toBe("Workflow Halted");
    expect(formatFieldLabel("conversationIdle")).toBe("Conversation Idle");
  });

  it("handles reasoningEffort", () => {
    expect(formatFieldLabel("reasoningEffort")).toBe("Reasoning Effort");
  });

  it("handles ignorePatterns", () => {
    expect(formatFieldLabel("ignorePatterns")).toBe("Ignore Patterns");
  });

  it("handles tailscaleEnabled", () => {
    expect(formatFieldLabel("tailscaleEnabled")).toBe("Tailscale Enabled");
  });
});

// ---------------------------------------------------------------------------
// msToMinutes / minutesToMs
// ---------------------------------------------------------------------------

describe("msToMinutes", () => {
  it("converts milliseconds to minutes", () => {
    expect(msToMinutes(60_000)).toBe(1);
    expect(msToMinutes(3_600_000)).toBe(60);
    expect(msToMinutes(300_000)).toBe(5);
  });

  it("handles fractional minutes", () => {
    expect(msToMinutes(90_000)).toBe(1.5);
    expect(msToMinutes(30_000)).toBe(0.5);
  });

  it("handles zero", () => {
    expect(msToMinutes(0)).toBe(0);
  });
});

describe("minutesToMs", () => {
  it("converts minutes to milliseconds", () => {
    expect(minutesToMs(1)).toBe(60_000);
    expect(minutesToMs(60)).toBe(3_600_000);
    expect(minutesToMs(5)).toBe(300_000);
  });

  it("handles fractional minutes", () => {
    expect(minutesToMs(1.5)).toBe(90_000);
    expect(minutesToMs(0.5)).toBe(30_000);
  });

  it("handles zero", () => {
    expect(minutesToMs(0)).toBe(0);
  });

  it("roundtrips with msToMinutes", () => {
    expect(minutesToMs(msToMinutes(3_600_000))).toBe(3_600_000);
    expect(msToMinutes(minutesToMs(5))).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// validateNumericInput
// ---------------------------------------------------------------------------

describe("validateNumericInput", () => {
  it("accepts valid integer input", () => {
    const result = validateNumericInput("42", { integer: true });
    expect(result).toEqual({ valid: true, value: 42 });
  });

  it("accepts valid decimal input", () => {
    const result = validateNumericInput("3.14", {});
    expect(result).toEqual({ valid: true, value: 3.14 });
  });

  it("rejects non-numeric input", () => {
    const result = validateNumericInput("abc", {});
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects empty input when required", () => {
    const result = validateNumericInput("", { required: true });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("accepts empty input when not required", () => {
    const result = validateNumericInput("", {});
    expect(result).toEqual({ valid: true, value: undefined });
  });

  it("rejects negative numbers when positive is required", () => {
    const result = validateNumericInput("-5", { positive: true });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects zero when positive is required", () => {
    const result = validateNumericInput("0", { positive: true });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("accepts positive numbers when positive is required", () => {
    const result = validateNumericInput("10", { positive: true });
    expect(result).toEqual({ valid: true, value: 10 });
  });

  it("rejects decimal when integer is required", () => {
    const result = validateNumericInput("3.5", { integer: true });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects whitespace-only input when required", () => {
    const result = validateNumericInput("   ", { required: true });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("accepts whitespace-only input when not required", () => {
    const result = validateNumericInput("   ", {});
    expect(result).toEqual({ valid: true, value: undefined });
  });
});

// ---------------------------------------------------------------------------
// getModelOptionsForBackend / getEffortOptionsForBackend
// ---------------------------------------------------------------------------

describe("getModelOptionsForBackend", () => {
  it("returns Claude models for claude backend", () => {
    expect(getModelOptionsForBackend("claude")).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  it("returns Codex models for codex backend", () => {
    expect(getModelOptionsForBackend("codex")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
    ]);
  });
});

describe("getEffortOptionsForBackend", () => {
  it("returns Claude effort levels (including xhigh for Opus) for claude backend", () => {
    const result = getEffortOptionsForBackend("claude", "opus");
    expect(result).toContain("low");
    expect(result).toContain("medium");
    expect(result).toContain("high");
    expect(result).toContain("xhigh");
    expect(result).toContain("max");
    expect(result).not.toContain("minimal");
  });

  it("excludes xhigh for Sonnet", () => {
    const result = getEffortOptionsForBackend("claude", "sonnet");
    expect(result).toContain("low");
    expect(result).toContain("medium");
    expect(result).toContain("high");
    expect(result).not.toContain("xhigh");
    expect(result).not.toContain("max");
  });

  it("returns Codex effort levels for codex backend", () => {
    const result = getEffortOptionsForBackend("codex");
    expect(result).toContain("low");
    expect(result).toContain("medium");
    expect(result).toContain("high");
    expect(result).toContain("xhigh");
    expect(result).not.toContain("max");
  });
});
