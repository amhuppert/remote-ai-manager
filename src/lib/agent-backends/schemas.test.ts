import { describe, expect, it } from "vitest";
import { conversationTokenUsageSchema } from "./schemas";

describe("conversationTokenUsageSchema", () => {
  it("accepts a full usage record without a reasoning count", () => {
    const parsed = conversationTokenUsageSchema.safeParse({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      totalTokens: 1540,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.reasoningTokens).toBeUndefined();
  });

  it("accepts a reasoning count that the total excludes", () => {
    const parsed = conversationTokenUsageSchema.safeParse({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      reasoningTokens: 4096,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.reasoningTokens).toBe(4096);
  });

  it("rejects a record missing a required count", () => {
    const parsed = conversationTokenUsageSchema.safeParse({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      totalTokens: 150,
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects negative and fractional counts", () => {
    expect(
      conversationTokenUsageSchema.safeParse({
        inputTokens: -1,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 49,
      }).success,
    ).toBe(false);

    expect(
      conversationTokenUsageSchema.safeParse({
        inputTokens: 1.5,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 51,
      }).success,
    ).toBe(false);
  });

  it("rejects null in place of a count so unavailability stays a whole-record verdict", () => {
    expect(
      conversationTokenUsageSchema.safeParse({
        inputTokens: null,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 50,
      }).success,
    ).toBe(false);

    // Unavailable usage is the null record itself, not a record of nulls.
    expect(
      conversationTokenUsageSchema.nullable().safeParse(null).success,
    ).toBe(true);
  });
});
