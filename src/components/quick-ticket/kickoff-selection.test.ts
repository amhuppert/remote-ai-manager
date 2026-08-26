import { describe, expect, it } from "vitest";

import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/catalog";
import { resolveKickoffSelection } from "./kickoff-selection";

const DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "opus", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

const UNTOUCHED = {
  kickoffBackend: null,
  kickoffModelSelection: null,
};

describe("resolveKickoffSelection", () => {
  it("follows the configured complete selection while the draft is untouched", () => {
    expect(
      resolveKickoffSelection({
        draft: UNTOUCHED,
        defaultBackend: "codex",
        backendDefaults: DEFAULTS,
      }),
    ).toEqual({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { reasoning: "ultra", fast: "false" },
      },
    });
  });

  it("keeps a complete draft selection as one indivisible value", () => {
    expect(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: "codex",
          kickoffModelSelection: {
            modelId: "gpt-5.6-terra",
            parameters: { reasoning: "low", fast: "true" },
          },
        },
        defaultBackend: "claude",
        backendDefaults: DEFAULTS,
      }),
    ).toEqual({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.6-terra",
        parameters: { reasoning: "low", fast: "true" },
      },
    });
  });

  it("uses the selected backend's whole default when no draft selection exists", () => {
    expect(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: "claude",
          kickoffModelSelection: null,
        },
        defaultBackend: "codex",
        backendDefaults: DEFAULTS,
      }),
    ).toEqual({
      backend: "claude",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "medium" },
      },
    });
  });

  it("does not merge missing parameters from a lower-precedence default", () => {
    expect(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: "codex",
          kickoffModelSelection: {
            modelId: "gpt-5.6-sol",
            parameters: { reasoning: "low" },
          },
        },
        defaultBackend: "claude",
        backendDefaults: DEFAULTS,
      }),
    ).toEqual({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { reasoning: "low" },
      },
    });
  });

  it("returns a clone so callers cannot mutate the persisted draft", () => {
    const draft = {
      kickoffBackend: "claude" as const,
      kickoffModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "high" },
      },
    };

    const resolved = resolveKickoffSelection({
      draft,
      defaultBackend: "codex",
      backendDefaults: DEFAULTS,
    });
    resolved.modelSelection.parameters.effort = "low";

    expect(draft.kickoffModelSelection.parameters.effort).toBe("high");
  });
});
