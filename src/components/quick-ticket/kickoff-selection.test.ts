import { describe, expect, it } from "vitest";

import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/catalog";
import { resolveKickoffSelection } from "./kickoff-selection";

const DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "opus", effort: "medium" },
  codex: { modelId: "gpt-5.6-sol", effort: "ultra" },
};

const UNTOUCHED = {
  kickoffBackend: null,
  kickoffModel: null,
  kickoffReasoningEffort: null,
};

describe("resolveKickoffSelection", () => {
  it("follows the configured defaults while the draft is untouched", () => {
    expect(
      resolveKickoffSelection({
        draft: UNTOUCHED,
        defaultBackend: "codex",
        backendDefaults: DEFAULTS,
      }),
    ).toMatchObject({
      backend: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
  });

  it("keeps a fully valid draft selection", () => {
    expect(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: "claude",
          kickoffModel: "sonnet",
          kickoffReasoningEffort: "low",
        },
        defaultBackend: "codex",
        backendDefaults: DEFAULTS,
      }),
    ).toMatchObject({
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "low",
    });
  });

  it("applies a model choice against the default backend", () => {
    expect(
      resolveKickoffSelection({
        draft: { ...UNTOUCHED, kickoffModel: "sonnet" },
        defaultBackend: "claude",
        backendDefaults: DEFAULTS,
      }),
    ).toMatchObject({ backend: "claude", model: "sonnet" });
  });

  it("replaces a model that is invalid for the selected backend with the configured default", () => {
    expect(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: "claude",
          kickoffModel: "gpt-5.4",
          kickoffReasoningEffort: null,
        },
        defaultBackend: "codex",
        backendDefaults: DEFAULTS,
      }),
    ).toMatchObject({ backend: "claude", model: "opus" });
  });

  it("clamps an effort the resolved model does not support", () => {
    // Terra tops out at xhigh; ultra falls back to the model's high tier.
    expect(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: "codex",
          kickoffModel: "gpt-5.6-terra",
          kickoffReasoningEffort: "ultra",
        },
        defaultBackend: "claude",
        backendDefaults: DEFAULTS,
      }),
    ).toMatchObject({
      backend: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
  });

  it("clamps a configured default effort the chosen model does not support", () => {
    // No draft effort: the codex configured default (ultra) is invalid for Terra.
    expect(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: "codex",
          kickoffModel: "gpt-5.6-terra",
          kickoffReasoningEffort: null,
        },
        defaultBackend: "claude",
        backendDefaults: DEFAULTS,
      }),
    ).toMatchObject({ reasoningEffort: "high" });
  });

  it("omits reasoning effort for a model without effort levels", () => {
    expect(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: "claude",
          kickoffModel: "haiku",
          kickoffReasoningEffort: "high",
        },
        defaultBackend: "claude",
        backendDefaults: DEFAULTS,
      }),
    ).toMatchObject({
      model: "haiku",
      reasoningEffort: undefined,
      effortLevels: [],
    });
  });

  it("keeps a custom codex model configured outside the catalog", () => {
    expect(
      resolveKickoffSelection({
        draft: UNTOUCHED,
        defaultBackend: "codex",
        backendDefaults: {
          ...DEFAULTS,
          codex: { modelId: "gpt-experimental", effort: "high" },
        },
      }),
    ).toMatchObject({
      backend: "codex",
      model: "gpt-experimental",
      reasoningEffort: "high",
    });
  });

  it("exposes the resolved model's effort levels for the selector", () => {
    expect(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: "codex",
          kickoffModel: "gpt-5.6-sol",
          kickoffReasoningEffort: "ultra",
        },
        defaultBackend: "claude",
        backendDefaults: DEFAULTS,
      }).effortLevels,
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });
});
