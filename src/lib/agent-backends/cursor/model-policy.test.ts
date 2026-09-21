import { describe, expect, it } from "vitest";

import { createRepoConfig } from "@/lib/projects/repo-config";

import { createCursorDisabledModelsReader } from "./model-policy";

const PROJECT = "/work/tree";

describe("cursor disabled-model reader over project configuration", () => {
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

  it("reads the project's declared opt-out list", async () => {
    const read = createCursorDisabledModelsReader(
      repoConfigReaderFor(
        JSON.stringify({
          agentBackends: {
            cursor: { disabledModels: ["composer-1", "gpt-5.4"] },
          },
        }),
      ),
    );

    expect(await read(PROJECT)).toEqual(["composer-1", "gpt-5.4"]);
  });

  it("reports null when the project has no config file or no Cursor block", async () => {
    // Null and an empty list are the same effective answer — nothing disabled —
    // so the reader does not invent a list the project never wrote.
    for (const contents of [
      null,
      JSON.stringify({}),
      JSON.stringify({ agentBackends: {} }),
    ]) {
      const read = createCursorDisabledModelsReader(
        repoConfigReaderFor(contents),
      );
      expect(await read(PROJECT)).toBeNull();
    }
  });

  it("reports an empty opt-out list for a project declaring an empty Cursor block", async () => {
    const read = createCursorDisabledModelsReader(
      repoConfigReaderFor(JSON.stringify({ agentBackends: { cursor: {} } })),
    );

    expect(await read(PROJECT)).toEqual([]);
  });

  it("propagates a malformed configuration rather than reporting an empty opt-out list", async () => {
    // Reporting "nothing disabled" for a file Command Center cannot parse would
    // enable models the operator may have turned off. The catalog facet turns
    // the throw into a bounded refusal.
    const read = createCursorDisabledModelsReader(
      repoConfigReaderFor(
        JSON.stringify({
          agentBackends: { cursor: { disabledModels: "composer-2.5" } },
        }),
      ),
    );

    await expect(read(PROJECT)).rejects.toThrow();
  });

  it("names disabledModels when a project still declares the former allowlist", async () => {
    const read = createCursorDisabledModelsReader(
      repoConfigReaderFor(
        JSON.stringify({
          agentBackends: { cursor: { supportedModels: ["composer-2.5"] } },
        }),
      ),
    );

    await expect(read(PROJECT)).rejects.toThrow(/disabledModels/);
  });
});
