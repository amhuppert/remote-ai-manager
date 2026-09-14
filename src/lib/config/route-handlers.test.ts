import { withTasklessBackend } from "@/lib/agent-backends/testing/taskless-backend";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConfigReader } from "./loader";
import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { createAssignmentReferenceChecker } from "@/lib/workflow-graph/assignment-references";
import {
  createConfigRouteHandlers,
  type ConfigRouteDeps,
} from "./route-handlers";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const fullConfig = {
  baseDir: "/home/user/projects",
  ignorePatterns: ["node_modules", ".next"],
  agentBackends: {
    claude: {
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      timeoutMs: 3_600_000,
    },
    codex: {
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
      timeoutMs: null,
    },
  },
  defaultAgentBackend: "claude" as const,
  preMergeTimeoutMs: 300_000,
  maxConcurrentQueries: 3,
  validation: { concurrencyLimit: 4, defaultTimeoutMs: 600_000 },
  tailscaleEnabled: true,
};

const rawConfig = {
  baseDir: "/home/user/projects",
  agentBackends: { claude: { timeoutMs: 3_600_000 } },
  validation: { concurrencyLimit: 4 },
};

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function createTestDeps(profileConfigDir: string): ConfigRouteDeps {
  return {
    readConfig: vi.fn().mockResolvedValue(fullConfig),
    readRawConfig: vi.fn().mockResolvedValue(rawConfig),
    writeRawConfig: vi.fn().mockResolvedValue(undefined),
    // A real library over an empty temp tier: the builtin tier still resolves
    // (built-ins are constants), and every global-tier id is genuinely absent,
    // which is exactly the dangling case under test.
    assignmentReferences: createAssignmentReferenceChecker({
      library: createAgentProfileLibraryService({
        storage: createAgentProfileStorage({
          resolveConfigDir: () => profileConfigDir,
        }),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePutRequest(body: unknown): Request {
  return new Request("http://localhost/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: ConfigRouteDeps;
let handlers: ReturnType<typeof createConfigRouteHandlers>;

let profileConfigDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  profileConfigDir = await mkdtemp(path.join(tmpdir(), "cc-config-profiles-"));
  deps = createTestDeps(profileConfigDir);
  handlers = createConfigRouteHandlers(deps);
});

afterEach(async () => {
  await rm(profileConfigDir, { recursive: true, force: true });
});

// ===========================================================================
// GET /api/config
// ===========================================================================

describe("GET /api/config", () => {
  it("returns { config, raw } shape", async () => {
    const response = await handlers.GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("config");
    expect(body).toHaveProperty("raw");
  });

  it("config contains full merged values (with defaults)", async () => {
    const response = await handlers.GET();
    const body = await response.json();

    expect(body.config).toEqual(fullConfig);
    expect(body.config.agentBackends.claude.modelSelection.modelId).toBe(
      "opus",
    );
    expect(body.config.ignorePatterns).toEqual(["node_modules", ".next"]);
  });

  it("raw contains only explicitly set values", async () => {
    const response = await handlers.GET();
    const body = await response.json();

    expect(body.raw).toEqual(rawConfig);
    expect(body.raw).not.toHaveProperty("ignorePatterns");
  });

  it("returns resolved and raw validation settings", async () => {
    const response = await handlers.GET();
    const body = await response.json();

    expect(body.config.validation).toEqual({
      concurrencyLimit: 4,
      defaultTimeoutMs: 600_000,
    });
    expect(body.raw.validation).toEqual({
      concurrencyLimit: 4,
    });
  });

  it("returns 500 with { error } when readConfig throws", async () => {
    vi.mocked(deps.readConfig).mockRejectedValue(
      new Error("Disk read failure"),
    );

    const response = await handlers.GET();
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe("Disk read failure");
  });

  it("returns 500 with fallback message for non-Error throws", async () => {
    vi.mocked(deps.readConfig).mockRejectedValue("string error");

    const response = await handlers.GET();
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe("Failed to read config");
  });
});

// ===========================================================================
// PUT /api/config
// ===========================================================================

describe("PUT /api/config", () => {
  it("accepts valid partial config body and persists to disk", async () => {
    const input = {
      baseDir: "/new/path",
      agentBackends: { claude: { timeoutMs: 120_000 } },
    };
    const response = await handlers.PUT(makePutRequest(input));

    expect(response.status).toBe(200);
    expect(deps.writeRawConfig).toHaveBeenCalledWith(input);
  });

  it("returns updated { config, raw } response after write", async () => {
    const updatedRaw = { baseDir: "/new/path" };
    vi.mocked(deps.readRawConfig).mockResolvedValue(updatedRaw);

    const response = await handlers.PUT(
      makePutRequest({ baseDir: "/new/path" }),
    );
    const body = await response.json();

    expect(body).toHaveProperty("config");
    expect(body).toHaveProperty("raw");
    expect(body.config).toEqual(fullConfig);
    expect(body.raw).toEqual(updatedRaw);
  });

  it("accepts partial workflowDefaults bodies with only changed blocks", async () => {
    const input = {
      workflowDefaults: {
        implementer: {
          id: "implementer",
          profile: { tier: "builtin" as const, id: "general-implementer" },
          agent: {
            backend: "claude" as const,
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
        },
      },
    };

    const response = await handlers.PUT(makePutRequest(input));

    expect(response.status).toBe(200);
    expect(deps.writeRawConfig).toHaveBeenCalledWith(input);
  });

  it("persists both validation settings and reads back raw and resolved values", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "cc-config-route-"));
    try {
      await writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ validation: { concurrencyLimit: 4 } }),
        "utf-8",
      );
      const reader = createConfigReader(configDir);
      const realHandlers = createConfigRouteHandlers({
        readConfig: () => reader.readConfig(),
        readRawConfig: () => reader.readRawConfig(),
        writeRawConfig: (config) => reader.writeRawConfig(config),
      });

      const initialResponse = await realHandlers.GET();
      const initial = await initialResponse.json();
      expect(initial.raw.validation).toEqual({ concurrencyLimit: 4 });
      expect(initial.config.validation).toEqual({
        concurrencyLimit: 4,
        defaultTimeoutMs: 600_000,
      });

      const input = {
        validation: {
          concurrencyLimit: 3,
          defaultTimeoutMs: 900_000,
        },
      };
      const response = await realHandlers.PUT(makePutRequest(input));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.raw.validation).toEqual(input.validation);
      expect(body.config.validation).toEqual(input.validation);
      await expect(reader.readRawConfig()).resolves.toEqual(input);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["concurrencyLimit", 0],
    ["concurrencyLimit", 1.5],
    ["defaultTimeoutMs", 0],
    ["defaultTimeoutMs", 1.5],
  ])("rejects invalid validation.%s", async (field, value) => {
    const response = await handlers.PUT(
      makePutRequest({ validation: { [field]: value } }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain(`validation.${field}`);
    expect(deps.writeRawConfig).not.toHaveBeenCalled();
  });

  describe("workflowDefaults assignment references (R4.2)", () => {
    function assignment(profile: { tier: string; id: string }) {
      return {
        id: "implementer",
        profile,
        agent: {
          backend: "claude" as const,
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
      };
    }

    it("refuses a project-tier profile reference, naming the scope rule", async () => {
      const response = await handlers.PUT(
        makePutRequest({
          workflowDefaults: {
            implementer: assignment({ tier: "project", id: "repo-reviewer" }),
          },
        }),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/project-tier/i);
      expect(body.error).toContain("project:repo-reviewer");
      expect(deps.writeRawConfig).not.toHaveBeenCalled();
    });

    it("refuses a dangling reference in a validator cohort", async () => {
      const response = await handlers.PUT(
        makePutRequest({
          workflowDefaults: {
            contextValidator: {
              enabled: true,
              assignments: [
                {
                  id: "org",
                  profile: { tier: "global", id: "never-created" },
                  strategy: "conversation",
                  agent: {
                    backend: "claude",
                    modelSelection: {
                      modelId: "sonnet",
                      parameters: { effort: "medium" },
                    },
                  },
                  continuity: { enabled: true },
                },
              ],
            },
          },
        }),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("global:never-created");
      expect(deps.writeRawConfig).not.toHaveBeenCalled();
    });

    it("accepts a builtin reference", async () => {
      const response = await handlers.PUT(
        makePutRequest({
          workflowDefaults: {
            implementer: assignment({
              tier: "builtin",
              id: "general-implementer",
            }),
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(deps.writeRawConfig).toHaveBeenCalled();
    });
  });

  it("rejects invalid config body with 400 status and { error }", async () => {
    const response = await handlers.PUT(
      makePutRequest({
        agentBackends: { claude: { timeoutMs: "not-a-number" } },
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Invalid config/i);
  });

  // R12.2: the settings surface, not just the schema, has to refuse an option
  // Command Center will never read — and refuse it as a client error, never a
  // 500 and never a silent strip that persists a config the operator thinks
  // carries their setting.
  it.each([
    ["unknownCursorOption", "anything", /unknownCursorOption/],
    ["fastMode", true, /complete modelSelection/i],
    ["pricing", { "composer-2.5": { inputPerMillion: 1 } }, /cost/i],
  ])(
    "rejects the Cursor option %s with a bounded 400 and persists nothing",
    async (field, value, reasonPattern) => {
      const response = await handlers.PUT(
        makePutRequest({
          agentBackends: {
            cursor: {
              modelSelection: {
                modelId: "composer-2.5",
                parameters: { fast: "true" },
              },
              [field]: value,
            },
          },
        }),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(reasonPattern);
      expect(deps.writeRawConfig).not.toHaveBeenCalled();
    },
  );

  it("refuses a credential parked under an unknown Cursor key without echoing it", async () => {
    const response = await handlers.PUT(
      makePutRequest({
        agentBackends: {
          cursor: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: { fast: "true" },
            },
            token: "sk-cursor-not-a-real-key",
          },
        },
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("token");
    expect(body.error).not.toContain("sk-cursor-not-a-real-key");
    expect(deps.writeRawConfig).not.toHaveBeenCalled();
  });

  it("accepts a well-formed Cursor profile", async () => {
    const response = await handlers.PUT(
      makePutRequest({
        agentBackends: {
          cursor: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: { fast: "true" },
            },
            timeoutMs: null,
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(deps.writeRawConfig).toHaveBeenCalled();
  });

  it("persists Cursor conversation defaults with canonical model ids", async () => {
    const response = await handlers.PUT(
      makePutRequest({
        defaultAgentBackend: "cursor",
        agentBackends: {
          cursor: {
            modelSelection: {
              modelId: "composer-latest",
              parameters: { fast: "true" },
            },
          },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(deps.writeRawConfig).toHaveBeenCalledWith({
      defaultAgentBackend: "cursor",
      agentBackends: {
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
        },
      },
    });
  });

  it.each(["conversationNaming", "compaction"])(
    "saves an admitted Cursor %s selection unchanged",
    async (field) => {
      const selection = {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      };
      const block =
        field === "conversationNaming"
          ? { backend: "cursor", enabled: true, modelSelection: selection }
          : {
              backend: "cursor",
              conversationModelSelection: selection,
              messageModelSelection: selection,
            };
      const response = await handlers.PUT(makePutRequest({ [field]: block }));
      expect(response.status).toBe(200);
      expect(deps.writeRawConfig).toHaveBeenCalledWith({ [field]: block });
    },
  );

  it.each(["conversationNaming", "compaction"])(
    "refuses an unsupported %s selection before saving",
    async (field) => {
      await withTasklessBackend("cursor", async () => {
        const selection = {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        };
        const block =
          field === "conversationNaming"
            ? { backend: "cursor", enabled: true, modelSelection: selection }
            : {
                backend: "cursor",
                conversationModelSelection: selection,
                messageModelSelection: selection,
              };
        const response = await handlers.PUT(makePutRequest({ [field]: block }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "backend-facet-unsupported",
        });
        expect(deps.writeRawConfig).not.toHaveBeenCalled();
      });
    },
  );

  it("refuses a new unsupported naming selection even when naming is disabled", async () => {
    await withTasklessBackend("cursor", async () => {
      const response = await handlers.PUT(
        makePutRequest({
          conversationNaming: {
            enabled: false,
            backend: "cursor",
            modelSelection: {
              modelId: "composer-2.5",
              parameters: { fast: "true" },
            },
          },
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "backend-facet-unsupported",
      });
      expect(deps.writeRawConfig).not.toHaveBeenCalled();
    });
  });

  it("allows unrelated edits and disabling unsupported stored naming", async () => {
    const conversationNaming = {
      backend: "cursor" as const,
      enabled: true,
      modelSelection: { modelId: "composer-2.5", parameters: { fast: "true" } },
    };
    deps.readRawConfig = async () => ({ conversationNaming });
    expect(
      (
        await handlers.PUT(
          makePutRequest({ conversationNaming, tailscaleEnabled: false }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handlers.PUT(
          makePutRequest({
            conversationNaming: { ...conversationNaming, enabled: false },
          }),
        )
      ).status,
    ).toBe(200);
  });

  it("rejects a Cursor selection that is not a complete catalog variant", async () => {
    const response = await handlers.PUT(
      makePutRequest({
        agentBackends: {
          cursor: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: {},
            },
          },
        },
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Parameter "fast" is required');
    expect(deps.writeRawConfig).not.toHaveBeenCalled();
  });

  it("rejects a legacy path with its normalized replacement", async () => {
    const response = await handlers.PUT(
      makePutRequest({ claudeTimeoutMs: 120_000 }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/agentBackends\.claude\.timeoutMs/);
  });

  it("rejects the removed Codex enable gate", async () => {
    const response = await handlers.PUT(
      makePutRequest({ agentBackends: { codex: { enabled: true } } }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Codex is always available/);
  });

  it("rejects retired split Codex model and effort fields", async () => {
    const response = await handlers.PUT(
      makePutRequest({
        agentBackends: {
          codex: { model: "gpt-5.4", reasoningEffort: "ultra" },
        },
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("agentBackends.codex.model");
    expect(body.error).toContain("agentBackends.codex.reasoningEffort");
    expect(body.error).toContain("complete modelSelection");
    expect(deps.writeRawConfig).not.toHaveBeenCalled();
  });

  it.each(["model", "effort", "reasoning", "fast", "context", "thinking"])(
    "rejects the misplaced top-level model parameter %s before writing",
    async (field) => {
      const response = await handlers.PUT(makePutRequest({ [field]: "value" }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain(field);
      expect(deps.writeRawConfig).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Claude profile", { agentBackends: { claude: { thinking: "true" } } }],
    ["Codex profile", { agentBackends: { codex: { context: "max" } } }],
    ["compaction block", { compaction: { fast: "true" } }],
    ["naming block", { conversationNaming: { reasoning: "high" } }],
  ])(
    "rejects an unknown model parameter on the %s before writing",
    async (_label, input) => {
      const response = await handlers.PUT(makePutRequest(input));

      expect(response.status).toBe(400);
      expect(deps.writeRawConfig).not.toHaveBeenCalled();
    },
  );

  it("rejects a retired effort-only Codex override before writing", async () => {
    const response = await handlers.PUT(
      makePutRequest({
        agentBackends: { codex: { reasoningEffort: "ultra" } },
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("agentBackends.codex.reasoningEffort");
    expect(body.error).toContain("complete modelSelection");
    expect(deps.writeRawConfig).not.toHaveBeenCalled();
  });

  it("handles write errors with 500 status and { error }", async () => {
    vi.mocked(deps.writeRawConfig).mockRejectedValue(
      new Error("Permission denied"),
    );

    const response = await handlers.PUT(
      makePutRequest({ baseDir: "/new/path" }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Permission denied");
  });
});
