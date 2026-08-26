import { describe, expect, it } from "vitest";

import type { AgentBackendId } from "@/lib/shared/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import {
  catalogBackendSelectionDefaults,
  catalogEntryFromDescriptor,
  getConfiguredBackendModelCatalog,
  getBackendCatalogEntry,
  listBackendCatalogEntries,
  queueCapabilityForBackend,
  resolveConfiguredBackendSelectionDefaults,
  skillTriggerPrefixForBackend,
  backendLabel,
  backendSupportsFastMode,
  backendToneToken,
  getDefaultStallTimeoutForBackend,
  isModelCompatibleWithBackend,
  isSelectableModelForBackend,
  modelOptionsForCatalogEntry,
} from "./catalog";
import { validateModelSelection } from "./model-selection";
import { getBackendDescriptor } from "./registry";
import { CLAUDE_DEFAULT_STALL_TIMEOUT_MS } from "./claude/shared";

describe("client-safe catalog ⇄ registered descriptors", () => {
  it.each(agentBackendSchema.options)(
    "the %s catalog entry equals the projection of its registered descriptor",
    (backend) => {
      expect(getBackendCatalogEntry(backend)).toEqual(
        catalogEntryFromDescriptor(getBackendDescriptor(backend)),
      );
    },
  );

  it("lists every canonical backend exactly once", () => {
    expect(listBackendCatalogEntries().map((e) => e.id)).toEqual([
      ...agentBackendSchema.options,
    ]);
  });
});

describe("queueCapabilityForBackend", () => {
  it.each(agentBackendSchema.options)(
    "matches the %s descriptor's declared queue capability",
    (backend) => {
      expect(queueCapabilityForBackend(backend)).toEqual(
        getBackendDescriptor(backend).conversation?.capabilities.queue,
      );
    },
  );

  it("declares in-turn delivery for claude and next-turn for codex and cursor", () => {
    expect(queueCapabilityForBackend("claude")).toEqual({
      acceptsWhileRunning: true,
      deliveryTiming: "in_turn",
    });
    expect(queueCapabilityForBackend("codex")).toEqual({
      acceptsWhileRunning: true,
      deliveryTiming: "next_turn",
    });
    expect(queueCapabilityForBackend("cursor")).toEqual({
      acceptsWhileRunning: false,
      deliveryTiming: "next_turn",
    });
  });
});

describe("catalog facet-presence flags", () => {
  it.each(agentBackendSchema.options)(
    "reports the %s entry's facet flags from its registered descriptor",
    (backend) => {
      const descriptor = getBackendDescriptor(backend);
      expect(getBackendCatalogEntry(backend).facets).toEqual({
        conversation: descriptor.conversation !== undefined,
        tasks: descriptor.tasks !== undefined,
      });
    },
  );

  // The flag is what facet-gated pickers and routes read instead of branching
  // on backend identity, so it has to be wrong-proof for the one backend that
  // actually lacks a facet.
  it("reports cursor as conversation-only and claude/codex as both", () => {
    expect(getBackendCatalogEntry("cursor").facets).toEqual({
      conversation: true,
      tasks: false,
    });
    expect(getBackendCatalogEntry("claude").facets).toEqual({
      conversation: true,
      tasks: true,
    });
    expect(getBackendCatalogEntry("codex").facets).toEqual({
      conversation: true,
      tasks: true,
    });
  });
});

describe("backendSupportsFastMode", () => {
  it("is enabled only for Codex", () => {
    expect(backendSupportsFastMode("codex")).toBe(true);
    expect(backendSupportsFastMode("claude")).toBe(false);
    expect(backendSupportsFastMode("cursor")).toBe(false);
  });
});

describe("getDefaultStallTimeoutForBackend", () => {
  it.each(agentBackendSchema.options)(
    "arms an inactivity bound for %s turns",
    (backend) => {
      const bound = getDefaultStallTimeoutForBackend(backend);
      expect(typeof bound).toBe("number");
      expect(bound).toBeGreaterThan(0);
    },
  );

  it("serves the Claude bound from the single Claude literal", () => {
    expect(getDefaultStallTimeoutForBackend("claude")).toBe(
      CLAUDE_DEFAULT_STALL_TIMEOUT_MS,
    );
  });
});

describe("backend model ownership", () => {
  it.each(getBackendCatalogEntry("claude").models)(
    "rejects the Claude $id model for Codex",
    ({ id }) => {
      expect(isSelectableModelForBackend("codex", id)).toBe(false);
    },
  );

  it("selects a custom Codex model only when the global profile authorizes it", () => {
    expect(isSelectableModelForBackend("codex", "custom-codex-model")).toBe(
      false,
    );
    expect(
      isSelectableModelForBackend(
        "codex",
        "custom-codex-model",
        "custom-codex-model",
      ),
    ).toBe(true);
    expect(
      isSelectableModelForBackend(
        "codex",
        "request-supplied-model",
        "custom-codex-model",
      ),
    ).toBe(false);
  });

  it("keeps unknown provider model ids runtime-compatible without accepting known foreign models", () => {
    expect(isModelCompatibleWithBackend("claude", "claude-haiku-4-5")).toBe(
      true,
    );
    expect(isModelCompatibleWithBackend("codex", "opus")).toBe(false);
  });

  it.each(getBackendCatalogEntry("claude").models)(
    "does not present the Claude $id model as a custom Codex option",
    ({ id }) => {
      const options = modelOptionsForCatalogEntry(
        getBackendCatalogEntry("codex"),
        id,
      );

      expect(options.map((option) => option.id)).not.toContain(id);
    },
  );
});

describe("unknown backend ids", () => {
  it("throws instead of silently coercing to a real backend", () => {
    const unknown = "mystery" as AgentBackendId;
    expect(() => getBackendCatalogEntry(unknown)).toThrow(
      /unknown agent backend/i,
    );
    expect(() => queueCapabilityForBackend(unknown)).toThrow();
    expect(() => backendLabel(unknown)).toThrow();
    expect(() => backendToneToken(unknown)).toThrow();
    expect(() => skillTriggerPrefixForBackend(unknown)).toThrow();
  });
});

describe("resolveConfiguredBackendSelectionDefaults", () => {
  it("projects the configured profiles into backend-keyed UI defaults", () => {
    expect(
      resolveConfiguredBackendSelectionDefaults({
        agentBackends: {
          claude: {
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
          codex: {
            modelSelection: {
              modelId: "gpt-5.6-sol",
              parameters: { reasoning: "xhigh", fast: "true" },
            },
          },
          cursor: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: {},
            },
          },
        },
      }),
    ).toEqual({
      claude: { modelId: "sonnet", parameters: { effort: "medium" } },
      codex: {
        modelId: "gpt-5.6-sol",
        parameters: { reasoning: "xhigh", fast: "true" },
      },
      cursor: { modelId: "composer-2.5", parameters: {} },
    });
  });

  it("does not synthesize parameters a configured selection omits", () => {
    expect(
      resolveConfiguredBackendSelectionDefaults({
        agentBackends: {
          claude: {
            modelSelection: { modelId: "haiku", parameters: {} },
          },
          codex: {
            modelSelection: { modelId: "gpt-5.4", parameters: {} },
          },
          cursor: {
            modelSelection: { modelId: "composer-2.5", parameters: {} },
          },
        },
      }),
    ).toEqual({
      claude: { modelId: "haiku", parameters: {} },
      codex: { modelId: "gpt-5.4", parameters: {} },
      cursor: { modelId: "composer-2.5", parameters: {} },
    });
  });
});

describe("catalogBackendSelectionDefaults", () => {
  it("returns an exact valid default variant for every backend", () => {
    const defaults = catalogBackendSelectionDefaults();

    for (const backend of agentBackendSchema.options) {
      expect(
        validateModelSelection(
          getConfiguredBackendModelCatalog(backend),
          defaults[backend],
        ).valid,
        `${backend} default must be a complete catalog variant`,
      ).toBe(true);
    }

    expect(defaults.cursor).toEqual({
      modelId: "composer-2.5",
      parameters: { fast: "true" },
    });
  });
});
