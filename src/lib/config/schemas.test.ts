import { describe, expect, it } from "vitest";
import {
  compactionConfigSchema,
  globalConfigSchema,
  rawGlobalConfigSchema,
} from "./schemas";

describe("commandCenterProjectName config", () => {
  it("is retained by the raw disk schema", () => {
    expect(
      rawGlobalConfigSchema.parse({
        commandCenterProjectName: "command-center",
      }),
    ).toEqual({ commandCenterProjectName: "command-center" });
  });

  it("is retained by the normalized global schema", () => {
    const parsed = globalConfigSchema.parse({
      baseDir: "/projects",
      ignorePatterns: [],
      claudeTimeoutMs: 60_000,
      commandCenterProjectName: "command-center",
    });

    expect(parsed.commandCenterProjectName).toBe("command-center");
  });

  it("rejects an empty override", () => {
    expect(
      rawGlobalConfigSchema.safeParse({ commandCenterProjectName: "" }).success,
    ).toBe(false);
  });
});

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
