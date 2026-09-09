#!/usr/bin/env bun

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_PROFILE_NAMES = [
  "pure-node",
  "node-integration",
  "dom-integration",
  "architecture-toolchain",
  "browser-live-acceptance",
] as const;

export type TestProfile = (typeof TEST_PROFILE_NAMES)[number];

export interface TestProfileInventoryInput {
  readonly sources: Readonly<Record<string, string>>;
  readonly pureNodeTestFiles: readonly string[];
  readonly architectureToolchainTestFiles: readonly string[];
}

export interface TestProfileInventory {
  readonly allTestFiles: readonly string[];
  readonly unitTestFiles: readonly string[];
  readonly byProfile: Readonly<Record<TestProfile, readonly string[]>>;
}

const TEST_DIRECTORIES = ["src", "scripts", "eslint-rules"] as const;
const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|mjs)$/;
const ACCEPTANCE_FILE_PATTERN = /\.acceptance\.test\.ts$/;
const ARCHITECTURE_FILE_PATTERN =
  /(?:\.|-)(?:arch|architecture)\.test\.(?:ts|tsx|mjs)$/;
const JSDOM_DIRECTIVE_PATTERN = /^\/\/ @vitest-environment jsdom\s*$/m;
const PROFILE_DIRECTIVE_PATTERN = /^\/\/ @vitest-profile ([^\s]+)\s*$/gm;
const PROFILE_NAME_SET = new Set<string>(TEST_PROFILE_NAMES);

/**
 * Entry into the setup-free cohort is review-owned because import scanning
 * cannot prove that a transitive dependency is free of process-global effects.
 */
export const PURE_NODE_TEST_FILES = [
  "src/lib/shared/close-tab-selection.test.ts",
  "src/lib/shared/decode-route-segment.test.ts",
  "src/lib/shared/deep-equal.test.ts",
  "src/lib/shared/diagnostic-text.test.ts",
  "src/lib/shared/errors.test.ts",
  "src/lib/shared/fuzzy.test.ts",
  "src/lib/shared/testing/same-bytes.test.ts",
  "src/lib/shared/truncate.test.ts",
] as const;

export const ARCHITECTURE_TOOLCHAIN_TEST_FILES = [
  "src/cli/commands/workflow.contract.test.ts",
  "src/cli/commands/workflow.help.test.ts",
  "src/cli/help-registry.contract.test.ts",
  "src/cli/index.egress.test.ts",
  "src/components/markdown/Markdown.import-boundary.test.ts",
  "src/components/markdown/markdown-boundary.test.ts",
  "src/components/workflow-graph/workflow-graph-css.test.ts",
  "src/features/_root/pwa-manifest.test.ts",
  "src/lib/agent-backends/claude/native-memory-policy-surface.test.ts",
  "src/lib/agent-backends/codex/managed-skills-bridge.test.ts",
  "src/lib/agent-backends/codex/native-sdd-authoring-packaging.test.ts",
  "src/lib/agent-backends/consumer-locality-static.test.ts",
  "src/lib/agent-backends/cursor/sdk-pin.test.ts",
  "src/lib/agent-capabilities/apply-planner.test.ts",
  "src/lib/chat-spawning/standalone-usability.test.ts",
  "src/lib/config/prerender-safety.test.ts",
  "src/lib/conversation-commands/native-spec-guidance.test.ts",
  "src/lib/conversation-commands/spec-native-command.test.ts",
  "src/lib/conversations/profile-instruction-non-leakage.test.ts",
  "src/lib/conversations/project-route-equivalent.test.ts",
  "src/lib/memory/delivery-policy.test.ts",
  "src/lib/memory/telemetry-outside-ranking.test.ts",
  "src/lib/shared/design-system-guarantees.test.ts",
  "src/lib/shared/tailwind-utility-collisions.test.ts",
  "src/lib/shared/theme-surface.test.ts",
  "src/lib/state-store/reset-installed-state-db.test.ts",
  "src/lib/state-store/write-queue.async-ratchet.test.ts",
  "src/lib/workflow-graph/lifecycle-contract-consumers.test.ts",
  "src/lib/workflow-graph/maximal-authored-launch.contract.test.ts",
  "src/lib/workflow-graph/pending-artifacts-wiring.test.ts",
  "src/lib/workflows/collaboration/workflow-envelope-invariants.test.ts",
] as const;

function sortedUnique(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort();
  const duplicate = sorted.find((value, index) => value === sorted[index - 1]);
  if (duplicate !== undefined) {
    throw new Error(`${label} registry contains duplicate test: ${duplicate}`);
  }
  return sorted;
}

function validateRegistry(
  label: string,
  entries: readonly string[],
  testFiles: ReadonlySet<string>,
): Set<string> {
  const registered = sortedUnique(entries, label);
  const missing = registered.filter((entry) => !testFiles.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `${label} registry names missing test: ${missing.join(", ")}`,
    );
  }
  return new Set(registered);
}

function explicitProfiles(filePath: string, source: string): TestProfile[] {
  const profiles: TestProfile[] = [];
  for (const match of source.matchAll(PROFILE_DIRECTIVE_PATTERN)) {
    const profile = match[1];
    if (profile === undefined || !PROFILE_NAME_SET.has(profile)) {
      throw new Error(
        `${filePath}: unknown test profile "${profile ?? ""}"; expected ${TEST_PROFILE_NAMES.join(", ")}`,
      );
    }
    profiles.push(profile as TestProfile);
  }
  return sortedUnique(profiles, `${filePath} directive`) as TestProfile[];
}

export function buildTestProfileInventory({
  sources,
  pureNodeTestFiles,
  architectureToolchainTestFiles,
}: TestProfileInventoryInput): TestProfileInventory {
  const allTestFiles = Object.keys(sources)
    .filter((filePath) => TEST_FILE_PATTERN.test(filePath))
    .sort();
  const testFileSet = new Set(allTestFiles);
  const pureNodeRegistry = validateRegistry(
    "pure-node",
    pureNodeTestFiles,
    testFileSet,
  );
  const architectureRegistry = validateRegistry(
    "architecture-toolchain",
    architectureToolchainTestFiles,
    testFileSet,
  );
  const byProfile: Record<TestProfile, string[]> = {
    "pure-node": [],
    "node-integration": [],
    "dom-integration": [],
    "architecture-toolchain": [],
    "browser-live-acceptance": [],
  };

  for (const filePath of allTestFiles) {
    const source = sources[filePath] ?? "";
    const owners = new Set<TestProfile>(explicitProfiles(filePath, source));

    if (pureNodeRegistry.has(filePath)) owners.add("pure-node");
    if (JSDOM_DIRECTIVE_PATTERN.test(source)) owners.add("dom-integration");
    if (ACCEPTANCE_FILE_PATTERN.test(filePath)) {
      owners.add("browser-live-acceptance");
    }
    if (
      filePath.startsWith("scripts/") ||
      filePath.startsWith("eslint-rules/") ||
      ARCHITECTURE_FILE_PATTERN.test(filePath) ||
      architectureRegistry.has(filePath)
    ) {
      owners.add("architecture-toolchain");
    }

    if (owners.has("pure-node") && !pureNodeRegistry.has(filePath)) {
      throw new Error(
        `${filePath}: pure-node ownership must be reviewed in PURE_NODE_TEST_FILES`,
      );
    }
    if (owners.size === 0) owners.add("node-integration");
    if (owners.size !== 1) {
      throw new Error(
        `${filePath}: expected exactly one test profile, found ${[...owners].sort().join(", ")}`,
      );
    }

    const [owner] = owners;
    if (owner === undefined) {
      throw new Error(`${filePath}: no test profile owner`);
    }
    byProfile[owner].push(filePath);
  }

  const unitTestFiles = TEST_PROFILE_NAMES.filter(
    (profile) => profile !== "browser-live-acceptance",
  ).flatMap((profile) => byProfile[profile]);

  return {
    allTestFiles,
    unitTestFiles: unitTestFiles.sort(),
    byProfile,
  };
}

function collectTestSources(
  repoRoot: string,
  directory: string,
): Record<string, string> {
  const absoluteDirectory = path.join(repoRoot, directory);
  return Object.fromEntries(
    readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return Object.entries(collectTestSources(repoRoot, relativePath));
      }
      if (!entry.isFile() || !TEST_FILE_PATTERN.test(entry.name)) return [];
      const normalizedPath = relativePath.split(path.sep).join("/");
      return [
        [
          normalizedPath,
          readFileSync(path.join(repoRoot, relativePath), "utf8"),
        ],
      ];
    }),
  );
}

export function buildRepositoryTestProfileInventory(
  repoRoot: string,
): TestProfileInventory {
  const sources = Object.assign(
    {},
    ...TEST_DIRECTORIES.map((directory) =>
      collectTestSources(repoRoot, directory),
    ),
  ) as Record<string, string>;
  return buildTestProfileInventory({
    sources,
    pureNodeTestFiles: PURE_NODE_TEST_FILES,
    architectureToolchainTestFiles: ARCHITECTURE_TOOLCHAIN_TEST_FILES,
  });
}

if (import.meta.main) {
  try {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const inventory = buildRepositoryTestProfileInventory(repoRoot);
    const counts = TEST_PROFILE_NAMES.map(
      (profile) => `${profile}=${inventory.byProfile[profile].length}`,
    ).join(" ");
    process.stdout.write(
      `test-profiles: ${inventory.allTestFiles.length} files ${counts}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`test-profiles: ${message}\n`);
    process.exitCode = 1;
  }
}
