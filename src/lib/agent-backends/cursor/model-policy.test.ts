import { describe, expect, it } from "vitest";

import { createRepoConfig } from "@/lib/projects/repo-config";

import type { CursorModelPolicyDeps } from "./model-policy";
import {
  CURSOR_DEFAULT_MODEL,
  CURSOR_DEFAULT_SUPPORTED_MODELS,
  createCursorSupportedModelsReader,
  resolveCursorModel,
  resolveCursorModelForProject,
} from "./model-policy";

const PROJECT = "/work/tree";

describe("cursor model resolution order", () => {
  it("prefers an explicit selection over the global profile and the default", () => {
    const resolved = resolveCursorModel({
      explicitSelection: "composer-2.5-fast",
      globalProfileModel: "composer-2.5",
      configuredSupportedModels: ["composer-2.5", "composer-2.5-fast"],
    });

    expect(resolved).toStrictEqual({
      ok: true,
      model: "composer-2.5-fast",
      source: "explicit",
      supportedModels: ["composer-2.5", "composer-2.5-fast"],
    });
  });

  it("falls back to the global profile when nothing is explicitly selected", () => {
    for (const explicitSelection of [null, undefined, "", "   "]) {
      const resolved = resolveCursorModel({
        explicitSelection,
        globalProfileModel: "composer-2.5-fast",
        configuredSupportedModels: ["composer-2.5", "composer-2.5-fast"],
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.model).toBe("composer-2.5-fast");
      expect(resolved.source).toBe("global_profile");
    }
  });

  it("falls back to composer-2.5 when neither is set", () => {
    const resolved = resolveCursorModel({});
    expect(resolved).toStrictEqual({
      ok: true,
      model: CURSOR_DEFAULT_MODEL,
      source: "default",
      supportedModels: CURSOR_DEFAULT_SUPPORTED_MODELS,
    });
  });

  it("defaults the supported list to composer-2.5 only", () => {
    expect(CURSOR_DEFAULT_SUPPORTED_MODELS).toStrictEqual(["composer-2.5"]);

    for (const configuredSupportedModels of [null, undefined]) {
      const resolved = resolveCursorModel({ configuredSupportedModels });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.supportedModels).toStrictEqual(["composer-2.5"]);
    }
  });
});

describe("cursor model validation", () => {
  it("accepts any ID present in the configured list", () => {
    const resolved = resolveCursorModel({
      explicitSelection: "composer-1",
      configuredSupportedModels: ["composer-2.5", "composer-1"],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.model).toBe("composer-1");
  });

  it("rejects an explicit ID absent from the configured list", () => {
    const resolved = resolveCursorModel({
      explicitSelection: "gpt-5",
      configuredSupportedModels: ["composer-2.5"],
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("model_not_supported");
    expect(resolved.message).toContain("gpt-5");
    expect(resolved.supportedModels).toStrictEqual(["composer-2.5"]);
  });

  it("rejects an explicit ID absent from the default list", () => {
    const resolved = resolveCursorModel({ explicitSelection: "gpt-5" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("model_not_supported");
  });

  it("rejects a global profile model outside the project's list rather than substituting", () => {
    // Substitution would silently run a different model than the operator
    // configured; the invalid selection has to surface.
    const resolved = resolveCursorModel({
      globalProfileModel: "composer-9",
      configuredSupportedModels: ["composer-2.5"],
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("model_not_supported");
    expect(resolved.message).toContain("composer-9");
  });

  it("fails closed when the configured list omits the default and nothing is selected", () => {
    const resolved = resolveCursorModel({
      configuredSupportedModels: ["composer-1"],
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("default_model_not_supported");
    expect(resolved.message).toContain(CURSOR_DEFAULT_MODEL);
    expect(resolved.supportedModels).toStrictEqual(["composer-1"]);
  });

  it("fails closed on an explicitly empty configured list", () => {
    // An empty list permits nothing; treating it as "unconfigured" would
    // quietly re-enable the default.
    const explicit = resolveCursorModel({
      explicitSelection: "composer-2.5",
      configuredSupportedModels: [],
    });
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) expect(explicit.code).toBe("model_not_supported");

    const fallback = resolveCursorModel({ configuredSupportedModels: [] });
    expect(fallback.ok).toBe(false);
    if (!fallback.ok) expect(fallback.code).toBe("default_model_not_supported");
  });

  it("trims a selection before matching but keeps the listed ID", () => {
    const resolved = resolveCursorModel({
      explicitSelection: "  composer-2.5  ",
      configuredSupportedModels: ["composer-2.5"],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.model).toBe("composer-2.5");
  });

  it("never reports a resolved model that is not in the supported list", () => {
    for (const configuredSupportedModels of [
      null,
      [],
      ["composer-2.5"],
      ["composer-1"],
      ["composer-2.5", "composer-1"],
    ]) {
      for (const explicitSelection of [
        null,
        "composer-2.5",
        "composer-1",
        "x",
      ]) {
        for (const globalProfileModel of [null, "composer-1", "y"]) {
          const resolved = resolveCursorModel({
            explicitSelection,
            globalProfileModel,
            configuredSupportedModels,
          });
          if (!resolved.ok) continue;
          expect(resolved.supportedModels).toContain(resolved.model);
        }
      }
    }
  });
});

describe("cursor model resolution through the injected config reads", () => {
  function deps(
    supported: readonly string[] | null,
    globalModel: string | null,
  ): CursorModelPolicyDeps {
    return {
      async supportedModels(projectPath) {
        expect(projectPath).toBe(PROJECT);
        return supported;
      },
      async globalProfileModel() {
        return globalModel;
      },
    };
  }

  it("resolves through the project's configured list", async () => {
    const resolved = await resolveCursorModelForProject(
      { projectPath: PROJECT },
      deps(["composer-2.5", "composer-1"], "composer-1"),
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.model).toBe("composer-1");
    expect(resolved.source).toBe("global_profile");
  });

  it("returns the bounded error when the project's list excludes the selection", async () => {
    const resolved = await resolveCursorModelForProject(
      { projectPath: PROJECT, explicitSelection: "composer-9" },
      deps(["composer-2.5"], null),
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("model_not_supported");
  });
});

describe("cursor supported-model reader over project configuration", () => {
  function repoConfigReaderFor(contents: string | null) {
    // The real repo-config reader and the real per-repo schema — a JS object
    // stand-in could not prove the declared list survives an actual parse.
    return createRepoConfig({
      existsSync: () => contents !== null,
      readFile: async () => {
        if (contents === null) throw new Error("file not found");
        return contents;
      },
    }).readRepoConfig;
  }

  it("reads the project's declared list", async () => {
    const read = createCursorSupportedModelsReader(
      repoConfigReaderFor(
        JSON.stringify({
          agentBackends: {
            cursor: { supportedModels: ["composer-1", "composer-2.5"] },
          },
        }),
      ),
    );

    expect(await read(PROJECT)).toEqual(["composer-1", "composer-2.5"]);
  });

  it("reports null when the project has no config file or no Cursor block", async () => {
    for (const contents of [
      null,
      JSON.stringify({}),
      JSON.stringify({ agentBackends: {} }),
    ]) {
      const read = createCursorSupportedModelsReader(
        repoConfigReaderFor(contents),
      );
      expect(await read(PROJECT)).toBeNull();
    }
  });

  it("reports the declared-empty list as configured rather than as unconfigured", async () => {
    const read = createCursorSupportedModelsReader(
      repoConfigReaderFor(
        JSON.stringify({ agentBackends: { cursor: { supportedModels: [] } } }),
      ),
    );

    expect(await read(PROJECT)).toEqual([]);
  });

  it("refuses with a bounded error rather than throwing when the config is malformed", async () => {
    const resolved = await resolveCursorModelForProject(
      { projectPath: PROJECT, explicitSelection: "composer-2.5" },
      {
        supportedModels: createCursorSupportedModelsReader(
          repoConfigReaderFor(
            JSON.stringify({
              agentBackends: { cursor: { supportedModels: "composer-2.5" } },
            }),
          ),
        ),
        globalProfileModel: async () => null,
      },
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("supported_models_unreadable");
    expect(resolved.message).toContain("CommandCenter.json");
    expect(resolved.message.length).toBeLessThanOrEqual(400);
  });
});
