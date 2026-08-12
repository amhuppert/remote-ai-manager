import { describe, expect, it } from "vitest";

import type { AgentBackendId } from "@/lib/shared/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import {
  catalogEntryFromDescriptor,
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

  it("declares in-turn delivery for claude and next-turn for codex", () => {
    expect(queueCapabilityForBackend("claude")).toEqual({
      acceptsWhileRunning: true,
      deliveryTiming: "in_turn",
    });
    expect(queueCapabilityForBackend("codex")).toEqual({
      acceptsWhileRunning: true,
      deliveryTiming: "next_turn",
    });
  });
});

describe("backendSupportsFastMode", () => {
  it("is enabled only for Codex", () => {
    expect(backendSupportsFastMode("codex")).toBe(true);
    expect(backendSupportsFastMode("claude")).toBe(false);
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

  it("does not reject custom Codex models", () => {
    expect(isSelectableModelForBackend("codex", "custom-codex-model")).toBe(
      true,
    );
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
          claude: { model: "sonnet", reasoningEffort: "medium" },
          codex: {
            model: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
            fastMode: true,
          },
        },
      }),
    ).toEqual({
      claude: { modelId: "sonnet", effort: "medium" },
      codex: {
        modelId: "gpt-5.6-sol",
        effort: "xhigh",
        codexFastMode: true,
      },
    });
  });

  it("keeps the UI effort preference at high when a profile omits effort", () => {
    expect(
      resolveConfiguredBackendSelectionDefaults({
        agentBackends: {
          claude: { model: "haiku" },
          codex: { model: "gpt-5.4" },
        },
      }),
    ).toEqual({
      claude: { modelId: "haiku", effort: "high" },
      codex: {
        modelId: "gpt-5.4",
        effort: "high",
        codexFastMode: false,
      },
    });
  });
});
