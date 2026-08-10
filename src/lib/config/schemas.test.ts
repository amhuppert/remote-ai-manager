import { describe, expect, it } from "vitest";
import {
  compactionConfigSchema,
  conversationNamingConfigSchema,
  globalConfigSchema,
  perRepoConfigSchema,
  rawGlobalConfigSchema,
  resolveConversationNamingConfig,
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

describe("validation config composition", () => {
  const registry = {
    commands: {
      lint: {
        command: { full: "scripts/validate/lint.sh" },
        cost: 2,
        pathArgs: "forbid",
      },
      test: {
        command: {
          full: "scripts/validate/test-full-suite.sh",
          changed: "scripts/validate/test.sh",
        },
        cost: 8,
        timeoutMs: 900_000,
        pathArgs: "paths",
      },
    },
    preMerge: ["lint", "test"],
    laneMerge: ["test"],
  };

  it("perRepoConfigSchema parses a CommandCenter.json validation registry", () => {
    const parsed = perRepoConfigSchema.parse({ validation: registry });

    expect(parsed.validation?.preMerge).toEqual(["lint", "test"]);
    expect(parsed.validation?.laneMerge).toEqual(["test"]);
    expect(parsed.validation?.commands.test?.pathArgs).toBe("paths");
    expect(parsed.validation?.commands.lint?.pathArgs).toBe("forbid");
  });

  it("rejects preMergeCommand with an actionable registry replacement", () => {
    const result = perRepoConfigSchema.safeParse({
      preMergeCommand: "scripts/validate.sh",
      validation: registry,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["preMergeCommand"],
        message: expect.stringContaining("validation.commands/preMerge"),
      }),
    );
  });

  it("perRepoConfigSchema rejects a registry entry without a cost", () => {
    expect(
      perRepoConfigSchema.safeParse({
        validation: {
          commands: {
            lint: {
              command: { full: "scripts/validate/lint.sh" },
              pathArgs: "forbid",
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rawGlobalConfigSchema retains an explicit validation block", () => {
    expect(
      rawGlobalConfigSchema.parse({
        validation: { concurrencyLimit: 4 },
      }),
    ).toEqual({ validation: { concurrencyLimit: 4 } });
  });

  it("globalConfigSchema materializes validation defaults", () => {
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
      validation: {},
    });

    expect(parsed.validation).toEqual({
      concurrencyLimit: 8,
      defaultTimeoutMs: 600_000,
    });
  });
});

describe("conversationNamingConfigSchema", () => {
  it("materializes enabled/backend/model/effort defaults but leaves timeout unset", () => {
    const result = conversationNamingConfigSchema.parse({});

    expect(result).toEqual({
      enabled: true,
      backend: "claude",
      model: "haiku",
      effort: "low",
    });
    // No default timeout: the service resolves an unset timeout to 60s.
    expect(result.timeoutMs).toBeUndefined();
  });

  it("keeps explicit fields while defaulting the rest", () => {
    const result = conversationNamingConfigSchema.parse({
      backend: "codex",
      model: "gpt-5.4",
    });

    expect(result.backend).toBe("codex");
    expect(result.model).toBe("gpt-5.4");
    expect(result.enabled).toBe(true);
    expect(result.effort).toBe("low");
  });

  it("accepts an explicit numeric timeout and a null sentinel", () => {
    expect(
      conversationNamingConfigSchema.parse({ timeoutMs: 30_000 }).timeoutMs,
    ).toBe(30_000);
    expect(
      conversationNamingConfigSchema.parse({ timeoutMs: null }).timeoutMs,
    ).toBeNull();
  });

  it("rejects invalid backend and effort values", () => {
    expect(
      conversationNamingConfigSchema.safeParse({ backend: "gpt" }).success,
    ).toBe(false);
    expect(
      conversationNamingConfigSchema.safeParse({ effort: "invalid" }).success,
    ).toBe(false);
  });

  it("is retained partially by the raw disk schema without materializing defaults", () => {
    expect(
      rawGlobalConfigSchema.parse({
        conversationNaming: { model: "sonnet" },
      }),
    ).toEqual({ conversationNaming: { model: "sonnet" } });
  });

  it("is accepted by the normalized global schema", () => {
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
      conversationNaming: { enabled: false },
    });

    expect(parsed.conversationNaming).toEqual({
      enabled: false,
      backend: "claude",
      model: "haiku",
      effort: "low",
    });
  });

  it("resolveConversationNamingConfig returns defaults when the block is absent", () => {
    const config = globalConfigSchema.parse({
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
    });

    expect(resolveConversationNamingConfig(config)).toEqual({
      enabled: true,
      backend: "claude",
      model: "haiku",
      effort: "low",
    });
  });

  // The block is global-only (charter invariant global-config-only): the
  // per-repo schema must not carry it. Zod objects strip unknown keys, so
  // "not accepted" is observable as the key being absent from the parse.
  it("is not accepted by the per-repo schema", () => {
    const parsed: Record<string, unknown> = perRepoConfigSchema.parse({
      conversationNaming: { enabled: false },
    });

    expect("conversationNaming" in parsed).toBe(false);
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
