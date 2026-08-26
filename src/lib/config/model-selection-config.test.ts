import { describe, expect, it } from "vitest";
import { rawGlobalConfigSchema } from "./schemas";

describe("atomic backend model selection config", () => {
  it("retains complete model selections for every backend", () => {
    const input = {
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
        },
        codex: {
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { reasoning: "high", fast: "false" },
          },
        },
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: {},
          },
        },
      },
    };

    const result = rawGlobalConfigSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual(input);
  });

  it.each(["model", "reasoningEffort", "fastMode"])(
    "rejects the migrated legacy field %s",
    (field) => {
      const result = rawGlobalConfigSchema.safeParse({
        agentBackends: {
          codex: { [field]: field === "fastMode" ? true : "legacy" },
        },
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["agentBackends", "codex", field],
          message: expect.stringContaining("modelSelection"),
        }),
      );
    },
  );
});
