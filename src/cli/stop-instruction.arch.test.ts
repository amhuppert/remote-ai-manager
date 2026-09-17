// @vitest-inputs src/cli/**/*.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCliSources, type CliSourceFile } from "./testing/source-scan";

const CLI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".",
);

/** The legacy field name for the tier-3 instruction the lane protocol emits. */
const LEGACY_SPELLING = "stopInstruction";

/**
 * Where the legacy spelling is allowed to appear, and why. Two names for one
 * tier is a cost every reader pays, so it stays where the wire protocol forces
 * it: everything else authors `instruction`.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "commands/workflow/schemas.ts":
    "decodes the lane task completion response’s server-owned stopInstruction field",
  "commands/workflow/lane.ts":
    "the lane `task complete` response is the one server payload that still emits it (src/lib/workflow-graph/lane-route-handlers.ts)",
};

function filesMentioning(
  sources: readonly CliSourceFile[],
  marker: string,
): string[] {
  return sources
    .filter((file) => file.source.includes(marker))
    .map((file) => file.relativePath)
    .sort();
}

/**
 * Containment ratchet (docs/design/cc-cli/09 §10). Nothing in the type system
 * stops a new command from reading or authoring `stopInstruction`, and every
 * new site makes the eventual rename more expensive — so the spelling is pinned
 * to the files that carry the protocol, and spreading it fails here.
 */
describe("legacy stopInstruction containment", () => {
  it("appears only in the files that carry the lane protocol", async () => {
    const mentions = filesMentioning(
      await readCliSources(CLI_ROOT),
      LEGACY_SPELLING,
    );

    const unexpected = mentions.filter((file) => ALLOWED[file] === undefined);
    expect(
      unexpected,
      `these files introduce the legacy "${LEGACY_SPELLING}" spelling — author "instruction" instead, or add the file here with the protocol reason that forces it`,
    ).toEqual([]);

    const stale = Object.keys(ALLOWED)
      .filter((file) => !mentions.includes(file))
      .sort();
    expect(
      stale,
      "these files no longer use the legacy spelling — drop them so the containment list shrinks toward zero",
    ).toEqual([]);
  });

  it("sees the spelling wherever it is written", () => {
    const offenders = filesMentioning(
      [
        {
          relativePath: "commands/new-command.ts",
          source: "const stop = response.stopInstruction ?? null;\n",
        },
        {
          relativePath: "commands/clean.ts",
          source: "const stop = response.instruction ?? null;\n",
        },
      ],
      LEGACY_SPELLING,
    );

    expect(offenders).toEqual(["commands/new-command.ts"]);
  });
});
