import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every production composition of the execution repository must inject the
 * pending-artifact seam.
 *
 * The two deps are optional so a fixture can hold the record in memory, and
 * that optionality is exactly what could rot: a composition root that omits
 * them still compiles, still starts runs, and still passes every behavioural
 * test — it simply loses the ability to repair a launch that crashed between
 * its reserving commit and its `.cc` writes. Nothing observable fails until a
 * real crash, so the guard has to be structural.
 */
const PRODUCTION_COMPOSITION_ROOTS = [
  "src/lib/conversations/answer-route-handlers.ts",
  "src/lib/conversations/ask-route-handlers.ts",
  "src/lib/workflow-graph/execution-route-handlers.ts",
  "src/lib/workflow-graph/expansion-production.ts",
  "src/lib/workflow-graph/lane-tool-context-loader.ts",
  "src/lib/workflow-graph/runtime-edit-route-handlers.ts",
];

function readSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf-8");
}

const CONSTRUCTOR = "createGraphWorkflowExecutionRepository({";

/** The dep object one module hands the repository constructor. */
function repositoryConstruction(source: string): string {
  const start = source.indexOf(CONSTRUCTOR);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n});", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("pending-artifact wiring at the production composition roots", () => {
  it.each(PRODUCTION_COMPOSITION_ROOTS)(
    "%s injects both pending-artifact deps",
    (relativePath) => {
      // The dep list, not the file: an import of the same name elsewhere in the
      // module would otherwise satisfy an assertion the constructor does not.
      const construction = repositoryConstruction(readSource(relativePath));

      expect(construction).toContain("getGraphWorkflowPendingArtifacts,");
      expect(construction).toContain("clearGraphWorkflowPendingArtifacts,");
    },
  );

  it("names every production composition of the repository", () => {
    // The list above is only as good as its coverage, so it is derived from the
    // tree rather than trusted: a new composition root shows up here as a
    // failure instead of silently going unguarded.
    const root = path.join(process.cwd(), "src");
    const composers = readdirSync(root, {
      recursive: true,
      encoding: "utf-8",
    })
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
      .filter((entry) => !/\.test\.tsx?$/.test(entry))
      .filter((entry) => !entry.includes("test-fixtures"))
      .filter((entry) => !entry.includes(`compat${path.sep}engine-harness`))
      .filter((entry) =>
        readFileSync(path.join(root, entry), "utf-8").includes(CONSTRUCTOR),
      )
      .map((entry) => path.posix.join("src", entry.split(path.sep).join("/")))
      .sort();

    expect(composers).toEqual([...PRODUCTION_COMPOSITION_ROOTS].sort());
  });
});
