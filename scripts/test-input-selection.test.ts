// @vitest-inputs src/**/*.test.{ts,tsx,mjs} scripts/**/*.test.{ts,tsx,mjs}
// @vitest-inputs eslint-rules/**/*.test.{ts,tsx,mjs}
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectTestsForChangedPaths } from "./test-inputs";
import { buildRepositoryTestProfileInventory } from "./test-profiles";

/**
 * Proofs that changed validation selects the source-scanning contracts whose
 * inputs a change touches. These run against the real inventory and the real
 * `// @vitest-inputs` declarations, so a declaration that narrows past what a
 * contract scans fails here before it can let a regression escape selection.
 * The first three cases are the ratchets that went red on main unnoticed while
 * the architecture cohort was still selected by import graph alone.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const inventory = buildRepositoryTestProfileInventory(REPO_ROOT);

function select(changedPaths: readonly string[]): string[] {
  return selectTestsForChangedPaths(
    inventory.declaredInputsByTestFile,
    changedPaths,
  );
}

describe("changed-scope selection of source-scanning contracts", () => {
  it("selects the utility-collision ratchet when a component's classes change", () => {
    expect(select(["src/components/ui/Button.tsx"])).toContain(
      "src/lib/shared/tailwind-utility-collisions.test.ts",
    );
  });

  it("selects the route-consumer ratchet when workflow-graph source changes", () => {
    expect(select(["src/lib/workflow-graph/lane-join.ts"])).toContain(
      "src/lib/workflow-graph/route-consumers.arch.test.ts",
    );
  });

  it("selects the spec/graph boundary ratchet when spec-studio or specs source changes", () => {
    for (const changed of [
      "src/lib/specs/authoring-service.ts",
      "src/features/spec-studio/SpecReviewMode.tsx",
      "src/cli/commands/spec/index.ts",
    ]) {
      expect(select([changed]), changed).toContain(
        "src/lib/workflow-graph/spec-graph-boundary.arch.test.ts",
      );
    }
  });

  it("selects route inventories for an added or deleted App Router route", () => {
    for (const changed of [
      "src/app/api/projects/[name]/new/route.ts",
      "src/app/api/projects/[name]/retired/route.ts",
    ]) {
      expect(select([changed]), changed).toContain(
        "src/lib/conversations/project-route-equivalent.test.ts",
      );
    }
  });

  it("selects wrapper contracts when a validation script changes", () => {
    expect(select(["scripts/validate/test.sh"])).toEqual(
      expect.arrayContaining([
        "scripts/pre-merge-hermetic.test.ts",
        "scripts/validate-test-full-suite.test.ts",
        "scripts/validation-scope-wrappers.test.ts",
      ]),
    );
    expect(select(["CommandCenter.json"])).toEqual(
      expect.arrayContaining([
        "scripts/validate-test-full-suite.test.ts",
        "scripts/validation-gate-composition.test.ts",
      ]),
    );
  });

  it("selects shipped-skill contracts when a plugin skill document changes", () => {
    expect(
      select(["plugins/command-center/command-center/skills/cc-cli/SKILL.md"]),
    ).toEqual(
      expect.arrayContaining([
        "scripts/cc-cli-skill-reference.test.ts",
        "src/cli/commands/workflow.help.test.ts",
        "src/cli/help-registry.contract.test.ts",
      ]),
    );
  });

  it("selects the profile inventory contracts when any test file changes", () => {
    expect(select(["src/lib/memory/service.test.ts"])).toEqual(
      expect.arrayContaining([
        "scripts/test-profile-config.test.ts",
        "scripts/test-profiles.test.ts",
      ]),
    );
  });

  it("selects nothing for changes no contract scans", () => {
    expect(select(["PERFORMANCE.md", "docs/reports/2026-07-15.md"])).toEqual(
      [],
    );
  });

  it("only ever selects architecture/toolchain tests", () => {
    const architecture = new Set(inventory.byProfile["architecture-toolchain"]);
    for (const testFile of Object.keys(inventory.declaredInputsByTestFile)) {
      expect(architecture.has(testFile), testFile).toBe(true);
    }
  });
});
