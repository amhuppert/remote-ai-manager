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
      agentBackends: {
        claude: {
          model: "opus",
          reasoningEffort: "high",
          timeoutMs: 60_000,
        },
        codex: {
          model: "gpt-5.4",
          reasoningEffort: "high",
          timeoutMs: null,
        },
      },
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

describe("agent backend config", () => {
  it("accepts sparse raw backend profiles", () => {
    expect(
      rawGlobalConfigSchema.parse({
        defaultAgentBackend: "codex",
        agentBackends: {
          claude: { model: "sonnet" },
          codex: { fastMode: true, timeoutMs: null },
        },
      }),
    ).toEqual({
      defaultAgentBackend: "codex",
      agentBackends: {
        claude: { model: "sonnet" },
        codex: { fastMode: true, timeoutMs: null },
      },
    });
  });

  it("rejects non-boolean Codex fast mode values", () => {
    expect(
      rawGlobalConfigSchema.safeParse({
        agentBackends: { codex: { fastMode: "fast" } },
      }).success,
    ).toBe(false);
  });

  it("accepts custom Codex models with provider-valid effort", () => {
    const result = rawGlobalConfigSchema.safeParse({
      agentBackends: {
        codex: { model: "custom-codex-model", reasoningEffort: "ultra" },
      },
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ["defaultModel", "agentBackends.claude.model"],
    ["defaultEffort", "agentBackends.claude.reasoningEffort"],
    ["claudeTimeoutMs", "agentBackends.claude.timeoutMs"],
    ["codex", "agentBackends.codex"],
  ])(
    "rejects legacy %s with an actionable replacement",
    (field, replacement) => {
      const result = rawGlobalConfigSchema.safeParse({ [field]: "legacy" });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: [field],
          message: expect.stringContaining(replacement),
        }),
      );
    },
  );

  it("rejects the removed Codex enable gate actionably", () => {
    const result = rawGlobalConfigSchema.safeParse({
      agentBackends: { codex: { enabled: true } },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["agentBackends", "codex", "enabled"],
        message: expect.stringMatching(/always available/i),
      }),
    );
  });

  it.each([
    ["claude", "haiku", "high"],
    ["claude", "sonnet", "xhigh"],
    ["codex", "gpt-5.4", "ultra"],
  ])(
    "rejects an unsupported %s model and effort pair",
    (backend, model, reasoningEffort) => {
      const result = rawGlobalConfigSchema.safeParse({
        agentBackends: {
          [backend]: { model, reasoningEffort },
        },
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["agentBackends", backend, "reasoningEffort"],
          message: expect.stringContaining(model),
        }),
      );
    },
  );

  it("rejects invalid pairs in effective config too", () => {
    const result = globalConfigSchema.safeParse({
      baseDir: "/projects",
      ignorePatterns: [],
      agentBackends: {
        claude: {
          model: "haiku",
          reasoningEffort: "high",
          timeoutMs: 60_000,
        },
        codex: {
          model: "gpt-5.4",
          reasoningEffort: "high",
          timeoutMs: null,
        },
      },
    });

    expect(result.success).toBe(false);
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
