import { describe, expect, it, vi } from "vitest";

import { buildCursorModelCatalog } from "../src/lib/agent-backends/cursor/model-catalog-generation";
import {
  checkCursorModelCatalog,
  refreshCursorModelCatalog,
  type CursorModelsCommandDeps,
} from "./cursor-models";

const generatedAt = new Date("2026-08-25T12:00:00.000Z");
const catalog = buildCursorModelCatalog(
  [{ id: "composer-2.5", displayName: "Composer 2.5" }],
  { generatedAt: generatedAt.toISOString(), sdkVersion: "1.0.28" },
);

function deps(
  overrides: Partial<CursorModelsCommandDeps> = {},
): CursorModelsCommandDeps {
  return {
    sdkVersion: "1.0.28",
    readArtifact: vi.fn(async () => catalog),
    writeArtifact: vi.fn(async () => undefined),
    listModels: vi.fn(async () => [
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ]),
    now: () => generatedAt,
    writeOutput: vi.fn(),
    ...overrides,
  };
}

describe("checkCursorModelCatalog", () => {
  it("validates the checked-in artifact without making an authenticated request", async () => {
    const commandDeps = deps();

    await expect(checkCursorModelCatalog(commandDeps)).resolves.toEqual(
      catalog,
    );
    expect(commandDeps.listModels).not.toHaveBeenCalled();
    expect(commandDeps.writeArtifact).not.toHaveBeenCalled();
  });
});

describe("refreshCursorModelCatalog", () => {
  it("requires an explicit credential before model discovery", async () => {
    const commandDeps = deps();

    await expect(refreshCursorModelCatalog(null, commandDeps)).rejects.toThrow(
      /CURSOR_API_KEY/,
    );
    expect(commandDeps.listModels).not.toHaveBeenCalled();
    expect(commandDeps.writeArtifact).not.toHaveBeenCalled();
  });

  it("discovers, validates, and writes the complete authenticated snapshot", async () => {
    const commandDeps = deps();

    const refreshed = await refreshCursorModelCatalog(
      "cursor-test-credential",
      commandDeps,
    );

    expect(commandDeps.listModels).toHaveBeenCalledWith(
      "cursor-test-credential",
    );
    expect(commandDeps.writeArtifact).toHaveBeenCalledWith(refreshed);
    expect(refreshed.provenance).toEqual({
      source: "Cursor.models.list",
      generatedAt: generatedAt.toISOString(),
      sdkVersion: "1.0.28",
    });
    expect(commandDeps.writeOutput).toHaveBeenCalledWith(
      "Cursor model catalog refreshed: 1 model, 0 parameters, 1 variant.",
    );
    expect(
      JSON.stringify(vi.mocked(commandDeps.writeOutput).mock.calls),
    ).not.toContain("cursor-test-credential");
  });

  it("reports omitted ambiguous aliases deterministically", async () => {
    const commandDeps = deps({
      listModels: vi.fn(async () => [
        { id: "composer-2.5", displayName: "Composer 2.5" },
        {
          id: "model-b",
          displayName: "Model B",
          aliases: ["shared", "also"],
        },
        {
          id: "model-a",
          displayName: "Model A",
          aliases: ["shared", "also"],
        },
      ]),
    });

    await refreshCursorModelCatalog("cursor-test-credential", commandDeps);

    expect(commandDeps.writeOutput).toHaveBeenCalledWith(
      "Cursor aliases omitted as ambiguous: 2 aliases (also -> model-a, model-b; shared -> model-a, model-b).",
    );
  });

  it("reports a deterministic diff by model and parameter", async () => {
    const previous = buildCursorModelCatalog(
      [
        { id: "composer-2.5", displayName: "Composer 2.5" },
        { id: "model-old", displayName: "Model Old" },
      ],
      { generatedAt: generatedAt.toISOString(), sdkVersion: "1.0.28" },
    );
    const commandDeps = deps({
      readArtifact: vi.fn(async () => previous),
      listModels: vi.fn(async () => [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          parameters: [
            {
              id: "thinking",
              values: [
                { value: "false", displayName: "Off" },
                { value: "true", displayName: "On" },
              ],
            },
          ],
          variants: [
            {
              displayName: "Off",
              isDefault: true,
              params: [{ id: "thinking", value: "false" }],
            },
            {
              displayName: "On",
              params: [{ id: "thinking", value: "true" }],
            },
          ],
        },
        { id: "model-new", displayName: "Model New" },
      ]),
    });

    await refreshCursorModelCatalog("cursor-test-credential", commandDeps);

    expect(commandDeps.writeOutput).toHaveBeenCalledWith(
      "Cursor model catalog diff: models +model-new, -model-old, ~composer-2.5; parameters composer-2.5(+thinking).",
    );
  });
});
