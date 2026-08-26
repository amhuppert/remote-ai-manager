import { describe, expect, it } from "vitest";

import {
  FROZEN_CURSOR_MODEL_SNAPSHOT,
  FROZEN_CURSOR_MODEL_VARIANT_PARAMETER_KEYS,
  type FrozenCursorModelSnapshotEntry,
} from "./0035-cursor-model-snapshot";

describe("frozen Cursor model migration snapshot", () => {
  it("preserves all canonical models, exact atomic variants, legacy effort mappings, and only unique aliases", () => {
    expect(Object.keys(FROZEN_CURSOR_MODEL_SNAPSHOT)).toHaveLength(36);
    expect(
      Object.keys(FROZEN_CURSOR_MODEL_VARIANT_PARAMETER_KEYS),
    ).toHaveLength(36);
    expect(
      Object.values(FROZEN_CURSOR_MODEL_VARIANT_PARAMETER_KEYS).reduce(
        (count, variants) => count + variants.length,
        0,
      ),
    ).toBe(342);

    expect(FROZEN_CURSOR_MODEL_SNAPSHOT["composer-2.5"]).toEqual({
      aliases: ["composer-latest", "composer", "composer-2-5"],
      defaultSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
    });
    expect(FROZEN_CURSOR_MODEL_SNAPSHOT["claude-opus-5"]).toMatchObject({
      aliases: ["opus-5"],
      defaultSelection: {
        modelId: "claude-opus-5",
        parameters: {
          context: "1m",
          cyber: "false",
          effort: "high",
          fast: "false",
          thinking: "true",
        },
      },
      legacyReasoningEffort: {
        parameterId: "effort",
        selections: {
          xhigh: {
            modelId: "claude-opus-5",
            parameters: {
              context: "1m",
              cyber: "false",
              effort: "xhigh",
              fast: "false",
              thinking: "true",
            },
          },
        },
      },
    });
    expect(
      FROZEN_CURSOR_MODEL_SNAPSHOT["gpt-5.6-sol"]?.legacyReasoningEffort,
    ).toMatchObject({
      parameterId: "reasoning",
      selections: {
        xhigh: {
          modelId: "gpt-5.6-sol",
          parameters: {
            context: "1m",
            fast: "false",
            reasoning: "xhigh",
          },
        },
      },
    });

    const aliases = Object.values(FROZEN_CURSOR_MODEL_SNAPSHOT).flatMap(
      (entry) => entry.aliases,
    );
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases).not.toContain("opus");
    expect(aliases).not.toContain("gpt");

    const snapshot: Readonly<Record<string, FrozenCursorModelSnapshotEntry>> =
      FROZEN_CURSOR_MODEL_SNAPSHOT;
    for (const [modelId, entry] of Object.entries(snapshot)) {
      expect(entry.defaultSelection.modelId).toBe(modelId);
      const variants: readonly string[] | undefined =
        FROZEN_CURSOR_MODEL_VARIANT_PARAMETER_KEYS[modelId];
      expect(variants).toContain(
        JSON.stringify(
          Object.entries(entry.defaultSelection.parameters).sort(
            ([left], [right]) => left.localeCompare(right),
          ),
        ),
      );
      const legacyReasoningEffort = entry.legacyReasoningEffort;
      for (const [effort, selection] of Object.entries(
        legacyReasoningEffort?.selections ?? {},
      )) {
        expect(selection.modelId).toBe(modelId);
        expect(selection.parameters[legacyReasoningEffort!.parameterId]).toBe(
          effort,
        );
        expect(variants).toContain(
          JSON.stringify(
            Object.entries(selection.parameters).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        );
      }
    }

    expect(FROZEN_CURSOR_MODEL_VARIANT_PARAMETER_KEYS["grok-4.6"]).toContain(
      JSON.stringify([
        ["effort", "low"],
        ["fast", "false"],
      ]),
    );
    expect(
      FROZEN_CURSOR_MODEL_VARIANT_PARAMETER_KEYS["grok-4.6"],
    ).not.toContain(
      JSON.stringify([
        ["effort", "low"],
        ["fast", "sometimes"],
      ]),
    );
  });
});
