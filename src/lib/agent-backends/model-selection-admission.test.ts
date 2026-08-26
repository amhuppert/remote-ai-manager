import { describe, expect, it, vi } from "vitest";
import type { ConversationTurnConfig } from "./conversation-policy";
import type { ConversationBackendFactory } from "./conversation";
import { backendModelCatalogSchema } from "./schemas";
import {
  admitConfiguredModelSelection,
  type ModelSelectionAdmissionDeps,
} from "./model-selection-admission";

const CONFIG = {
  agentBackends: {
    claude: {
      modelSelection: { modelId: "claude-default", parameters: {} },
      timeoutMs: null,
    },
    codex: {
      modelSelection: {
        modelId: "custom-codex",
        parameters: { fast: "false", reasoning: "high" },
      },
      timeoutMs: null,
    },
    cursor: {
      modelSelection: { modelId: "cursor-default", parameters: {} },
      timeoutMs: null,
    },
  },
} satisfies ConversationTurnConfig;

const CATALOG = backendModelCatalogSchema.parse({
  backend: "codex",
  defaultModelId: "custom-codex",
  models: [
    {
      id: "custom-codex",
      label: "Custom Codex",
      aliases: ["custom-alias"],
      parameters: [
        {
          id: "reasoning",
          label: "Reasoning",
          values: [{ value: "high", label: "High" }],
          prominence: "hidden",
        },
        {
          id: "fast",
          label: "Fast",
          values: [
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ],
          prominence: "advanced",
        },
      ],
      variants: [
        {
          selection: {
            modelId: "custom-codex",
            parameters: { reasoning: "high", fast: "false" },
          },
          label: "High · Standard",
          isDefault: true,
        },
        {
          selection: {
            modelId: "custom-codex",
            parameters: { reasoning: "high", fast: "true" },
          },
          label: "High · Fast",
          isDefault: false,
        },
      ],
    },
  ],
  provenance: { source: "test" },
});

function factory(
  overrides: Partial<ConversationBackendFactory> = {},
): ConversationBackendFactory {
  return {
    backend: "codex",
    createRuntime: vi.fn(),
    ...overrides,
  } as unknown as ConversationBackendFactory;
}

function deps(
  backendFactory: ConversationBackendFactory,
): ModelSelectionAdmissionDeps {
  return {
    readConfig: vi.fn(async () => CONFIG),
    getConfiguredBackendModelCatalog: vi.fn(() => CATALOG),
    getConversationBackendFactory: vi.fn(() => backendFactory),
  };
}

describe("admitConfiguredModelSelection", () => {
  it("uses the configured profile to admit a custom Codex model and canonicalizes aliases before project policy", async () => {
    const validateProjectModelSelection = vi.fn(async ({ modelSelection }) => ({
      ok: true as const,
      modelSelection,
    }));
    const backendFactory = factory({ validateProjectModelSelection });
    const admissionDeps = deps(backendFactory);

    const result = await admitConfiguredModelSelection(
      {
        backend: "codex",
        projectPath: "/repo",
        modelSelection: {
          modelId: "custom-alias",
          parameters: { fast: "true", reasoning: "high" },
        },
      },
      admissionDeps,
    );

    expect(result).toEqual({
      ok: true,
      modelSelection: {
        modelId: "custom-codex",
        parameters: { fast: "true", reasoning: "high" },
      },
    });
    expect(admissionDeps.getConfiguredBackendModelCatalog).toHaveBeenCalledWith(
      "codex",
      CONFIG.agentBackends.codex.modelSelection,
    );
    expect(validateProjectModelSelection).toHaveBeenCalledWith({
      projectPath: "/repo",
      modelSelection: {
        modelId: "custom-codex",
        parameters: { fast: "true", reasoning: "high" },
      },
    });
  });

  it("resolves an omitted selection to the configured backend profile", async () => {
    const backendFactory = factory();

    await expect(
      admitConfiguredModelSelection(
        { backend: "codex", projectPath: "/repo" },
        deps(backendFactory),
      ),
    ).resolves.toEqual({
      ok: true,
      modelSelection: {
        modelId: "custom-codex",
        parameters: { fast: "false", reasoning: "high" },
      },
    });
  });

  it("returns the first stable catalog diagnostic before calling factory policy", async () => {
    const validateModelSelection = vi.fn();
    const validateProjectModelSelection = vi.fn();
    const backendFactory = factory({
      validateModelSelection,
      validateProjectModelSelection,
    });

    const result = await admitConfiguredModelSelection(
      {
        backend: "codex",
        projectPath: "/repo",
        modelSelection: {
          modelId: "custom-codex",
          parameters: { fast: "turbo", reasoning: "high" },
        },
      },
      deps(backendFactory),
    );

    expect(result).toEqual({
      ok: false,
      code: "unsupported_value",
      message:
        'Value "turbo" is not supported for parameter "fast" on model "custom-codex".',
      modelId: "custom-codex",
      parameterId: "fast",
    });
    expect(validateModelSelection).not.toHaveBeenCalled();
    expect(validateProjectModelSelection).not.toHaveBeenCalled();
  });

  it("uses a caller-supplied config snapshot without rereading configuration", async () => {
    const admissionDeps = deps(factory());
    vi.mocked(admissionDeps.readConfig).mockRejectedValue(
      new Error("configuration changed while admitting"),
    );

    await expect(
      admitConfiguredModelSelection(
        {
          backend: "codex",
          projectPath: "/repo",
          config: CONFIG,
        },
        admissionDeps,
      ),
    ).resolves.toEqual({
      ok: true,
      modelSelection: {
        modelId: "custom-codex",
        parameters: { fast: "false", reasoning: "high" },
      },
    });
    expect(admissionDeps.readConfig).not.toHaveBeenCalled();
  });

  it("bounds configuration read failures with the requested model identity", async () => {
    const admissionDeps = deps(factory());
    vi.mocked(admissionDeps.readConfig).mockRejectedValue(
      new Error("configuration unavailable"),
    );

    await expect(
      admitConfiguredModelSelection(
        {
          backend: "codex",
          projectPath: "/repo",
          modelSelection: {
            modelId: "gpt-requested",
            parameters: { fast: "false", reasoning: "high" },
          },
        },
        admissionDeps,
      ),
    ).resolves.toEqual({
      ok: false,
      code: "selection_validation_failed",
      message: "configuration unavailable",
      modelId: "gpt-requested",
    });
  });

  it("returns a typed configured-default refusal when configuration cannot be read and no selection was requested", async () => {
    const admissionDeps = deps(factory());
    vi.mocked(admissionDeps.readConfig).mockRejectedValue(
      new Error("configuration unavailable"),
    );

    await expect(
      admitConfiguredModelSelection(
        { backend: "codex", projectPath: "/repo" },
        admissionDeps,
      ),
    ).resolves.toEqual({
      ok: false,
      code: "configured_selection_unavailable",
      message: "configuration unavailable",
      modelId: "configured_default",
    });
  });
});
