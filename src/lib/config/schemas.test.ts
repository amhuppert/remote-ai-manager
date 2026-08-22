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
        cursor: { model: "composer-2.5", timeoutMs: null },
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
          cursor: { model: "composer-2.5", timeoutMs: null },
        },
      }),
    ).toEqual({
      defaultAgentBackend: "codex",
      agentBackends: {
        claude: { model: "sonnet" },
        codex: { fastMode: true, timeoutMs: null },
        cursor: { model: "composer-2.5", timeoutMs: null },
      },
    });
  });

  it("accepts a sparse raw Cursor profile", () => {
    expect(
      rawGlobalConfigSchema.parse({
        agentBackends: { cursor: { model: "composer-2.5" } },
      }),
    ).toEqual({ agentBackends: { cursor: { model: "composer-2.5" } } });
  });

  it("rejects a malformed Cursor model", () => {
    expect(
      rawGlobalConfigSchema.safeParse({
        agentBackends: { cursor: { model: "" } },
      }).success,
    ).toBe(false);
    expect(
      rawGlobalConfigSchema.safeParse({
        agentBackends: { cursor: { model: 5 } },
      }).success,
    ).toBe(false);
    expect(
      rawGlobalConfigSchema.safeParse({
        agentBackends: { cursor: { timeoutMs: "soon" } },
      }).success,
    ).toBe(false);
  });

  // Each of these would otherwise be stripped in silence, leaving an operator
  // believing they had configured something Command Center never reads.
  it.each([
    ["fastMode", true, /fast mode/i],
    ["pricing", { "composer-2.5": { inputPerMillion: 1 } }, /cost/i],
    ["apiKey", "sk-cursor-not-a-real-key", /CURSOR_API_KEY/],
  ])(
    "rejects the prohibited Cursor option %s with a bounded reason",
    (field, value, reasonPattern) => {
      const result = rawGlobalConfigSchema.safeParse({
        agentBackends: { cursor: { [field]: value } },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toMatch(reasonPattern);
        // Whatever the operator wrote must not be echoed back — the apiKey
        // case is the one that matters and the rule is uniform.
        expect(result.error.message).not.toContain("sk-cursor-not-a-real-key");
      }
    },
  );

  // The named `z.never()` arms above only cover the options we anticipated.
  // An option nobody predicted — a typo, a setting copied from another
  // backend, a field from a future release — has to fail too, or the operator
  // is told nothing while Command Center reads none of it.
  it.each([
    "unknownCursorOption",
    // A typo of a real field — the case an operator is most likely to hit.
    "modle",
    // A plausible-sounding setting Command Center does not expose.
    "sandbox",
  ])("rejects the unknown raw Cursor option %s, naming the key", (field) => {
    const result = rawGlobalConfigSchema.safeParse({
      agentBackends: { cursor: { model: "composer-2.5", [field]: "value" } },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["agentBackends", "cursor"],
        message: expect.stringContaining(field),
      }),
    );
  });

  it("names the unknown key without echoing its value", () => {
    const result = rawGlobalConfigSchema.safeParse({
      agentBackends: {
        cursor: { model: "composer-2.5", token: "sk-cursor-not-a-real-key" },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("token");
    expect(result.error.message).not.toContain("sk-cursor-not-a-real-key");
  });

  it("rejects an unknown option on the normalized Cursor profile too", () => {
    const result = globalConfigSchema.safeParse({
      baseDir: "/projects",
      ignorePatterns: [],
      agentBackends: {
        claude: { model: "opus", reasoningEffort: "high", timeoutMs: 60_000 },
        codex: { model: "gpt-5.4", reasoningEffort: "high", timeoutMs: null },
        cursor: {
          model: "composer-2.5",
          timeoutMs: null,
          unknownCursorOption: "anything",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  // Cursor fails closed because it is new: no shipped config file can already
  // carry a stray key under it. Tightening the profiles that HAVE shipped
  // tolerant is a separate migration decision, so this pins that the existing
  // two are deliberately unchanged rather than accidentally missed.
  it.each(["claude", "codex"])(
    "leaves the shipped %s profile's unknown-key tolerance unchanged",
    (backend) => {
      const result = rawGlobalConfigSchema.safeParse({
        agentBackends: { [backend]: { unknownLegacyOption: "tolerated" } },
      });

      expect(result.success).toBe(true);
    },
  );

  it("normalizes a Cursor profile through the global schema", () => {
    const parsed = globalConfigSchema.parse({
      baseDir: "/projects",
      ignorePatterns: [],
      agentBackends: {
        claude: { model: "opus", reasoningEffort: "high", timeoutMs: 60_000 },
        codex: { model: "gpt-5.4", reasoningEffort: "high", timeoutMs: null },
        cursor: { model: "composer-2.5", timeoutMs: null },
      },
    });

    expect(parsed.agentBackends.cursor).toEqual({
      model: "composer-2.5",
      timeoutMs: null,
    });
    expect(parsed.agentBackends.cursor).not.toHaveProperty("fastMode");
    expect(parsed.agentBackends.cursor).not.toHaveProperty("pricing");
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
        cursor: { model: "composer-2.5", timeoutMs: null },
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
        cursor: { model: "composer-2.5", timeoutMs: null },
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
        cursor: { model: "composer-2.5", timeoutMs: null },
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
        cursor: { model: "composer-2.5", timeoutMs: null },
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

describe("per-repo Cursor supported-model list", () => {
  it("accepts a declared list and preserves its order", () => {
    const parsed = perRepoConfigSchema.parse({
      agentBackends: {
        cursor: { supportedModels: ["composer-1", "composer-2.5"] },
      },
    });

    expect(parsed.agentBackends?.cursor?.supportedModels).toEqual([
      "composer-1",
      "composer-2.5",
    ]);
  });

  it("leaves the block undefined when a project declares none", () => {
    // Undefined is "this project configures no list", which the adapter's model
    // policy reads as the descriptor default — distinct from a declared list.
    const parsed = perRepoConfigSchema.parse({ initScriptPath: null });

    expect(parsed.agentBackends).toBeUndefined();
  });

  it("defaults an empty cursor block to composer-2.5 only", () => {
    const parsed = perRepoConfigSchema.parse({
      agentBackends: { cursor: {} },
    });

    expect(parsed.agentBackends?.cursor?.supportedModels).toEqual([
      "composer-2.5",
    ]);
  });

  it("accepts a declared-empty list, which permits nothing at use time", () => {
    const parsed = perRepoConfigSchema.parse({
      agentBackends: { cursor: { supportedModels: [] } },
    });

    expect(parsed.agentBackends?.cursor?.supportedModels).toEqual([]);
  });

  it("rejects a malformed list with a bounded config error", () => {
    for (const supportedModels of ["composer-2.5", [1], [""], ["  "], [null]]) {
      const result = perRepoConfigSchema.safeParse({
        agentBackends: { cursor: { supportedModels } },
      });

      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.issues[0]?.path).toEqual(
        expect.arrayContaining(["agentBackends", "cursor", "supportedModels"]),
      );
    }
  });

  it("rejects an unknown key under the cursor block by name", () => {
    const result = perRepoConfigSchema.safeParse({
      agentBackends: { cursor: { models: ["composer-2.5"] } },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a per-repo profile field that belongs to global configuration", () => {
    // The per-repo block declares the list only; model/effort/credential live
    // in (or are refused by) the global Cursor profile.
    for (const cursor of [
      { model: "composer-1" },
      { apiKey: "secret" },
      { reasoningEffort: "high" },
    ]) {
      expect(
        perRepoConfigSchema.safeParse({ agentBackends: { cursor } }).success,
      ).toBe(false);
    }
  });

  it("rejects an unknown backend key under the per-repo agentBackends block", () => {
    expect(
      perRepoConfigSchema.safeParse({
        agentBackends: { curser: { supportedModels: ["composer-2.5"] } },
      }).success,
    ).toBe(false);
  });
});
