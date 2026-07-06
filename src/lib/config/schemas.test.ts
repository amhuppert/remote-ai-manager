import { describe, expect, it } from "vitest";
import { compactionConfigSchema } from "./schemas";

describe("compactionConfigSchema", () => {
  it("materializes backend/model/effort defaults but leaves timeout unset", () => {
    const result = compactionConfigSchema.parse({});

    expect(result).toEqual({
      backend: "claude",
      conversationModel: "sonnet",
      messageModel: "sonnet",
      effort: "medium",
    });
    // No default timeout: an unset timeout means "no timeout applied".
    expect(result.timeoutMs).toBeUndefined();
  });

  it("accepts an explicit numeric timeout and a null (no-timeout) sentinel", () => {
    expect(compactionConfigSchema.parse({ timeoutMs: 60_000 }).timeoutMs).toBe(
      60_000,
    );
    expect(
      compactionConfigSchema.parse({ timeoutMs: null }).timeoutMs,
    ).toBeNull();
  });

  it("keeps explicit fields while defaulting the rest", () => {
    const result = compactionConfigSchema.parse({ messageModel: "haiku" });

    expect(result.messageModel).toBe("haiku");
    expect(result.conversationModel).toBe("sonnet");
  });

  it("rejects an invalid effort value", () => {
    const result = compactionConfigSchema.safeParse({ effort: "invalid" });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid backend value", () => {
    const result = compactionConfigSchema.safeParse({ backend: "gpt" });

    expect(result.success).toBe(false);
  });
});
