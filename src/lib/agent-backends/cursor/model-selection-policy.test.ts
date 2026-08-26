import { describe, expect, it } from "vitest";

import type { BackendModelCatalog } from "../schemas";
import {
  validateCursorModelSelectionForProject,
  type CursorModelSelectionPolicyDeps,
} from "./model-policy";

const CATALOG: BackendModelCatalog = {
  backend: "cursor",
  defaultModelId: "composer-2.5",
  models: [
    {
      id: "claude-opus-5",
      label: "Claude 5 Opus",
      aliases: ["opus-5"],
      parameters: [
        {
          id: "effort",
          label: "Effort",
          prominence: "primary",
          values: [
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" },
          ],
        },
        {
          id: "thinking",
          label: "Thinking",
          prominence: "advanced",
          values: [
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ],
        },
        {
          id: "cyber",
          label: "Cyber",
          prominence: "hidden",
          values: [{ value: "false", label: "Off" }],
        },
      ],
      variants: [
        {
          selection: {
            modelId: "claude-opus-5",
            parameters: {
              cyber: "false",
              effort: "high",
              thinking: "true",
            },
          },
          label: "High, thinking",
          isDefault: true,
        },
        {
          selection: {
            modelId: "claude-opus-5",
            parameters: {
              cyber: "false",
              effort: "xhigh",
              thinking: "true",
            },
          },
          label: "Extra high, thinking",
          isDefault: false,
        },
      ],
    },
  ],
  provenance: {
    source: "Cursor.models.list",
    generatedAt: "2026-08-25T00:00:00.000Z",
    sdkVersion: "1.0.28",
  },
};

function deps(
  getCatalog: CursorModelSelectionPolicyDeps["modelCatalog"]["getCatalog"],
): CursorModelSelectionPolicyDeps {
  return { modelCatalog: { getCatalog } };
}

describe("Cursor complete model-selection policy", () => {
  it("canonicalizes an alias only after the complete variant is validated", async () => {
    const configuredSelection = CATALOG.models[0]!.variants[0]!.selection;
    const seen: unknown[] = [];
    const result = await validateCursorModelSelectionForProject(
      {
        projectPath: "/repo",
        configuredSelection,
        selection: {
          modelId: "opus-5",
          parameters: {
            cyber: "false",
            effort: "xhigh",
            thinking: "true",
          },
        },
      },
      deps(async (input) => {
        seen.push(input);
        return CATALOG;
      }),
    );

    expect(seen).toEqual([{ projectPath: "/repo", configuredSelection }]);
    expect(result).toEqual({
      ok: true,
      selection: {
        modelId: "claude-opus-5",
        parameters: {
          cyber: "false",
          effort: "xhigh",
          thinking: "true",
        },
      },
    });
  });

  it("refuses a partial parameter record without choosing a nearby variant", async () => {
    const selection = {
      modelId: "claude-opus-5",
      parameters: { effort: "xhigh", thinking: "true" },
    };
    const result = await validateCursorModelSelectionForProject(
      {
        projectPath: "/repo",
        configuredSelection: CATALOG.models[0]!.variants[0]!.selection,
        selection,
      },
      deps(async () => CATALOG),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "missing_parameter",
      modelId: "claude-opus-5",
      parameterId: "cyber",
    });
    if (!result.ok) expect(result.message).toContain("cyber");
  });

  it("turns catalog refusal into a bounded typed result", async () => {
    const result = await validateCursorModelSelectionForProject(
      {
        projectPath: "/repo",
        configuredSelection: CATALOG.models[0]!.variants[0]!.selection,
        selection: CATALOG.models[0]!.variants[0]!.selection,
      },
      deps(async () => {
        throw new Error("project catalog unavailable");
      }),
    );

    expect(result).toEqual({
      ok: false,
      code: "catalog_unavailable",
      message:
        "Could not load the effective Cursor model catalog: project catalog unavailable",
      modelId: "claude-opus-5",
    });
  });
});
