import { describe, expect, it } from "vitest";
import {
  compactionConfigSchema,
  conversationNamingConfigSchema,
  globalConfigSchema,
  perRepoConfigSchema,
  rawGlobalConfigSchema,
  resolveConversationNamingConfig,
} from "./schemas";

function normalizedAgentBackends() {
  return {
    claude: {
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      timeoutMs: 60_000,
    },
    codex: {
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
      timeoutMs: null,
    },
    cursor: {
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
      timeoutMs: null,
    },
  };
}

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
      agentBackends: normalizedAgentBackends(),
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
    const input = {
      defaultAgentBackend: "codex",
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "high" },
          },
        },
        codex: {
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { reasoning: "high", fast: "true" },
          },
          timeoutMs: null,
        },
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
          timeoutMs: null,
        },
      },
    } as const;

    expect(rawGlobalConfigSchema.parse(input)).toEqual(input);
  });

  it("accepts a sparse raw Cursor profile", () => {
    const input = {
      agentBackends: {
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
        },
      },
    };

    expect(rawGlobalConfigSchema.parse(input)).toEqual(input);
  });

  it("rejects a malformed Cursor model selection", () => {
    expect(
      rawGlobalConfigSchema.safeParse({
        agentBackends: {
          cursor: { modelSelection: { modelId: "", parameters: {} } },
        },
      }).success,
    ).toBe(false);
    expect(
      rawGlobalConfigSchema.safeParse({
        agentBackends: {
          cursor: { modelSelection: { modelId: 5, parameters: {} } },
        },
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
    ["fastMode", true, /modelSelection/i],
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
      agentBackends: {
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
          [field]: "value",
        },
      },
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
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
          token: "sk-cursor-not-a-real-key",
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("token");
    expect(result.error.message).not.toContain("sk-cursor-not-a-real-key");
  });

  it("rejects an unknown option on the normalized Cursor profile too", () => {
    const agentBackends = normalizedAgentBackends();
    const result = globalConfigSchema.safeParse({
      baseDir: "/projects",
      ignorePatterns: [],
      agentBackends: {
        ...agentBackends,
        cursor: {
          ...agentBackends.cursor,
          unknownCursorOption: "anything",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it.each(["claude", "codex"])(
    "rejects an unknown %s profile option instead of stripping it",
    (backend) => {
      const result = rawGlobalConfigSchema.safeParse({
        agentBackends: { [backend]: { thinking: "enabled" } },
      });

      expect(result.success).toBe(false);
    },
  );

  it.each(["model", "effort", "reasoning", "fast", "context", "thinking"])(
    "rejects the misplaced top-level model parameter %s",
    (field) => {
      const result = rawGlobalConfigSchema.safeParse({ [field]: "value" });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: [field] }),
      );
    },
  );

  it.each([
    ["Claude profile", { agentBackends: { claude: { thinking: "true" } } }],
    ["Codex profile", { agentBackends: { codex: { context: "max" } } }],
    ["compaction block", { compaction: { fast: "true" } }],
    ["naming block", { conversationNaming: { reasoning: "high" } }],
  ])("rejects an unknown model parameter on the %s", (_label, input) => {
    expect(rawGlobalConfigSchema.safeParse(input).success).toBe(false);
  });

  it("normalizes a Cursor profile through the global schema", () => {
    const parsed = globalConfigSchema.parse({
      baseDir: "/projects",
      ignorePatterns: [],
      agentBackends: normalizedAgentBackends(),
    });

    expect(parsed.agentBackends.cursor).toEqual({
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
      timeoutMs: null,
    });
    expect(parsed.agentBackends.cursor).not.toHaveProperty("fastMode");
    expect(parsed.agentBackends.cursor).not.toHaveProperty("pricing");
  });

  it("rejects non-string values inside an atomic Codex selection", () => {
    expect(
      rawGlobalConfigSchema.safeParse({
        agentBackends: {
          codex: {
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { reasoning: "high", fast: true },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts custom Codex models with provider-valid effort", () => {
    const result = rawGlobalConfigSchema.safeParse({
      agentBackends: {
        codex: {
          modelSelection: {
            modelId: "custom-codex-model",
            parameters: { reasoning: "ultra", fast: "false" },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ["defaultModel", "agentBackends.claude.modelSelection"],
    ["defaultEffort", "agentBackends.claude.modelSelection.parameters"],
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

  it.each(["claude", "codex", "cursor"])(
    "rejects an incomplete atomic %s selection",
    (backend) => {
      const result = rawGlobalConfigSchema.safeParse({
        agentBackends: {
          [backend]: { modelSelection: { modelId: "model" } },
        },
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["agentBackends", backend, "modelSelection", "parameters"],
        }),
      );
    },
  );

  it("rejects a malformed selection in effective config too", () => {
    const agentBackends = normalizedAgentBackends();
    const result = globalConfigSchema.safeParse({
      baseDir: "/projects",
      ignorePatterns: [],
      agentBackends: {
        ...agentBackends,
        claude: {
          ...agentBackends.claude,
          modelSelection: { modelId: "", parameters: {} },
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
      agentBackends: normalizedAgentBackends(),
      validation: {},
    });

    expect(parsed.validation).toEqual({
      concurrencyLimit: 8,
      defaultTimeoutMs: 600_000,
    });
  });
});

describe("conversationNamingConfigSchema", () => {
  it("materializes an atomic model-selection default but leaves timeout unset", () => {
    const result = conversationNamingConfigSchema.parse({});

    expect(result).toEqual({
      enabled: true,
      backend: "claude",
      modelSelection: { modelId: "haiku", parameters: {} },
    });
    // No default timeout: the service resolves an unset timeout to 60s.
    expect(result.timeoutMs).toBeUndefined();
  });

  it("keeps explicit fields while defaulting the rest", () => {
    const result = conversationNamingConfigSchema.parse({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
    });

    expect(result.backend).toBe("codex");
    expect(result.modelSelection).toEqual({
      modelId: "gpt-5.4",
      parameters: { reasoning: "high", fast: "false" },
    });
    expect(result.enabled).toBe(true);
  });

  it("accepts an explicit numeric timeout and a null sentinel", () => {
    expect(
      conversationNamingConfigSchema.parse({ timeoutMs: 30_000 }).timeoutMs,
    ).toBe(30_000);
    expect(
      conversationNamingConfigSchema.parse({ timeoutMs: null }).timeoutMs,
    ).toBeNull();
  });

  it("rejects invalid backend and model-selection values", () => {
    expect(
      conversationNamingConfigSchema.safeParse({ backend: "gpt" }).success,
    ).toBe(false);
    expect(
      conversationNamingConfigSchema.safeParse({
        modelSelection: { modelId: "", parameters: {} },
      }).success,
    ).toBe(false);
  });

  it("is retained partially by the raw disk schema without materializing defaults", () => {
    const modelSelection = {
      modelId: "sonnet",
      parameters: { effort: "high" },
    };
    expect(
      rawGlobalConfigSchema.parse({
        conversationNaming: { modelSelection },
      }),
    ).toEqual({ conversationNaming: { modelSelection } });
  });

  it("is accepted by the normalized global schema", () => {
    const parsed = globalConfigSchema.parse({
      baseDir: "/projects",
      ignorePatterns: [],
      agentBackends: normalizedAgentBackends(),
      conversationNaming: { enabled: false },
    });

    expect(parsed.conversationNaming).toEqual({
      enabled: false,
      backend: "claude",
      modelSelection: { modelId: "haiku", parameters: {} },
    });
  });

  it("resolveConversationNamingConfig returns defaults when the block is absent", () => {
    const config = globalConfigSchema.parse({
      baseDir: "/projects",
      ignorePatterns: [],
      agentBackends: normalizedAgentBackends(),
    });

    expect(resolveConversationNamingConfig(config)).toEqual({
      enabled: true,
      backend: "claude",
      modelSelection: { modelId: "haiku", parameters: {} },
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
  it("materializes atomic model-selection defaults but leaves timeout unset", () => {
    const result = compactionConfigSchema.parse({});

    expect(result).toEqual({
      backend: "claude",
      conversationModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
      messageModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
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
    const result = compactionConfigSchema.parse({
      messageModelSelection: { modelId: "haiku", parameters: {} },
    });

    expect(result.messageModelSelection).toEqual({
      modelId: "haiku",
      parameters: {},
    });
    expect(result.conversationModelSelection).toEqual({
      modelId: "sonnet",
      parameters: { effort: "medium" },
    });
  });

  it("rejects a malformed model-selection parameter value", () => {
    const result = compactionConfigSchema.safeParse({
      conversationModelSelection: {
        modelId: "sonnet",
        parameters: { effort: 5 },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid backend value", () => {
    const result = compactionConfigSchema.safeParse({ backend: "gpt" });

    expect(result.success).toBe(false);
  });
});

describe("per-repo Cursor opt-out model list", () => {
  it("accepts a declared opt-out list and preserves its order", () => {
    const parsed = perRepoConfigSchema.parse({
      agentBackends: {
        cursor: { disabledModels: ["composer-1", "composer-2.5"] },
      },
    });

    expect(parsed.agentBackends?.cursor?.disabledModels).toEqual([
      "composer-1",
      "composer-2.5",
    ]);
  });

  it("leaves the block undefined when a project declares none", () => {
    // Undefined is "this project configures nothing", which leaves every
    // generated model available.
    const parsed = perRepoConfigSchema.parse({ initScriptPath: null });

    expect(parsed.agentBackends).toBeUndefined();
  });

  it("defaults an empty cursor block to no opt-outs at all", () => {
    const parsed = perRepoConfigSchema.parse({
      agentBackends: { cursor: {} },
    });

    expect(parsed.agentBackends?.cursor?.disabledModels).toEqual([]);
  });

  it("rejects a malformed opt-out list with a bounded config error", () => {
    for (const disabledModels of ["composer-2.5", [1], [""], ["  "], [null]]) {
      const result = perRepoConfigSchema.safeParse({
        agentBackends: { cursor: { disabledModels } },
      });

      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.issues[0]?.path).toEqual(
        expect.arrayContaining(["agentBackends", "cursor", "disabledModels"]),
      );
    }
  });

  it("names the replacement when a project still declares the former allowlist", () => {
    // Silently ignoring it would leave an operator believing models are
    // restricted when every model is in fact available.
    const result = perRepoConfigSchema.safeParse({
      agentBackends: { cursor: { supportedModels: ["composer-2.5"] } },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("disabledModels");
  });

  it("rejects an unknown key under the cursor block by name", () => {
    const result = perRepoConfigSchema.safeParse({
      agentBackends: { cursor: { models: ["composer-2.5"] } },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a per-repo profile field that belongs to global configuration", () => {
    // The per-repo block declares the opt-out list only; model/effort/credential
    // live in (or are refused by) the global Cursor profile.
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
        agentBackends: { curser: { disabledModels: ["composer-2.5"] } },
      }).success,
    ).toBe(false);
  });
});
