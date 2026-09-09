import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildTestProfileInventory,
  buildRepositoryTestProfileInventory,
  PURE_NODE_TEST_FILES,
  TEST_PROFILE_NAMES,
  type TestProfileInventoryInput,
} from "./test-profiles";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function build(
  overrides: Partial<TestProfileInventoryInput> = {},
): ReturnType<typeof buildTestProfileInventory> {
  const sources = {
    "src/pure.test.ts": "",
    "src/default.test.ts": "",
    "src/component.test.tsx": "// @vitest-environment jsdom\n",
    "src/boundary.arch.test.ts": "",
    "src/provider.acceptance.test.ts": "",
    ...overrides.sources,
  };

  return buildTestProfileInventory({
    pureNodeTestFiles: ["src/pure.test.ts"],
    architectureToolchainTestFiles: [],
    ...overrides,
    sources,
  });
}

describe("test profile inventory", () => {
  it("assigns every test exactly once across the five execution profiles", () => {
    const inventory = build();

    expect(inventory.byProfile).toEqual({
      "pure-node": ["src/pure.test.ts"],
      "node-integration": ["src/default.test.ts"],
      "dom-integration": ["src/component.test.tsx"],
      "architecture-toolchain": ["src/boundary.arch.test.ts"],
      "browser-live-acceptance": ["src/provider.acceptance.test.ts"],
    });
    expect(inventory.allTestFiles).toHaveLength(5);
    expect(inventory.unitTestFiles).toHaveLength(4);
  });

  it("rejects a file claimed by more than one profile", () => {
    expect(() =>
      build({ pureNodeTestFiles: ["src/boundary.arch.test.ts"] }),
    ).toThrow(
      /src\/boundary\.arch\.test\.ts.*architecture-toolchain.*pure-node/,
    );
  });

  it("rejects stale registry entries", () => {
    expect(() => build({ pureNodeTestFiles: ["src/removed.test.ts"] })).toThrow(
      /pure-node registry names missing test: src\/removed\.test\.ts/,
    );
  });

  it("rejects an unsupported profile directive", () => {
    expect(() =>
      build({
        sources: {
          "src/unknown.test.ts": "// @vitest-profile fast\n",
        },
        pureNodeTestFiles: [],
      }),
    ).toThrow(/src\/unknown\.test\.ts.*unknown test profile "fast"/);
  });

  it("requires pure directives to pass through the reviewed registry", () => {
    expect(() =>
      build({
        sources: {
          "src/unreviewed.test.ts": "// @vitest-profile pure-node\n",
        },
        pureNodeTestFiles: [],
      }),
    ).toThrow(/src\/unreviewed\.test\.ts.*PURE_NODE_TEST_FILES/);
  });

  it("rejects acceptance tests that request a unit environment", () => {
    expect(() =>
      build({
        sources: {
          "src/provider.acceptance.test.ts": "// @vitest-environment jsdom\n",
        },
        pureNodeTestFiles: [],
      }),
    ).toThrow(
      /src\/provider\.acceptance\.test\.ts.*browser-live-acceptance.*dom-integration/,
    );
  });

  it("covers the repository corpus once and keeps the pure cohort explicit", () => {
    const inventory = buildRepositoryTestProfileInventory(REPO_ROOT);
    const assigned = TEST_PROFILE_NAMES.flatMap(
      (profile) => inventory.byProfile[profile],
    );

    expect(new Set(assigned).size).toBe(inventory.allTestFiles.length);
    expect(assigned).toHaveLength(inventory.allTestFiles.length);
    expect(inventory.byProfile["pure-node"]).toEqual([...PURE_NODE_TEST_FILES]);
  });
});
