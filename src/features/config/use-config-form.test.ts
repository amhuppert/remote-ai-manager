// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  fullConfigResponseSchema,
  rawGlobalConfigSchema,
  type FullConfigResponse,
} from "@/lib/config/schemas";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { useConfigForm } from "./use-config-form";

/**
 * Parsed through the production schema so the loaded config carries exactly the
 * shape the settings page receives from `GET /api/config` — including every
 * registered backend's profile with its schema defaults.
 */
function loadedConfig(): FullConfigResponse {
  return fullConfigResponseSchema.parse({
    config: {
      baseDir: "/projects",
      ignorePatterns: [],
      defaultAgentBackend: "claude",
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
          timeoutMs: null,
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
      },
    },
    raw: {},
  });
}

function renderForm() {
  return renderHook(() => useConfigForm(loadedConfig()));
}

describe("useConfigForm backend profile editing", () => {
  // The defect this pins: a profile field the settings section renders but
  // ALL_FIELD_PATHS omits is editable on screen yet never dirties the form, so
  // Save stays disabled and the edit is dropped from the PUT body entirely.
  it.each(listBackendCatalogEntries().map((entry) => entry.id))(
    "marks a %s atomic selection edit dirty and carries it into the save payload",
    (backend) => {
      const { result } = renderForm();
      const modelSelection = {
        modelId: "edited-model",
        parameters: { providerOption: "enabled" },
      };

      act(() => {
        result.current.controller?.handleChange(
          `agentBackends.${backend}.modelSelection`,
          modelSelection,
        );
      });

      expect(result.current.dirtyCount).toBe(1);
      const payload = result.current.buildSavePayload();
      expect(payload?.agentBackends?.[backend]?.modelSelection).toEqual(
        modelSelection,
      );
    },
  );

  it.each(listBackendCatalogEntries().map((entry) => entry.id))(
    "marks a %s timeout edit dirty and carries it into the save payload",
    (backend) => {
      const { result } = renderForm();

      act(() => {
        result.current.controller?.handleChange(
          `agentBackends.${backend}.timeoutMs`,
          1_800_000,
        );
      });

      expect(result.current.dirtyCount).toBe(1);
      const payload = result.current.buildSavePayload();
      expect(payload?.agentBackends?.[backend]?.timeoutMs).toBe(1_800_000);
    },
  );

  // Dirty-tracking is only half the round trip: the payload also has to be a
  // body the config PUT accepts, or the edit is tracked and then refused.
  it("produces a payload the config write schema accepts for every backend", () => {
    for (const entry of listBackendCatalogEntries()) {
      const { result, unmount } = renderForm();

      act(() => {
        result.current.controller?.handleChange(
          `agentBackends.${entry.id}.timeoutMs`,
          600_000,
        );
      });

      const parsed = rawGlobalConfigSchema.safeParse(
        result.current.buildSavePayload(),
      );
      expect(parsed.success).toBe(true);
      expect(parsed.data?.agentBackends?.[entry.id]?.timeoutMs).toBe(600_000);
      unmount();
    }
  });

  it("leaves the other backends' profiles untouched in the payload", () => {
    const { result } = renderForm();

    act(() => {
      result.current.controller?.handleChange(
        "agentBackends.cursor.modelSelection",
        { modelId: "composer-next", parameters: { fast: "false" } },
      );
    });

    const payload = result.current.buildSavePayload();
    expect(payload?.agentBackends?.cursor?.modelSelection).toEqual({
      modelId: "composer-next",
      parameters: { fast: "false" },
    });
    expect(payload?.agentBackends?.claude).toBeUndefined();
    expect(payload?.agentBackends?.codex).toBeUndefined();
  });
});
