import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "./config";
import {
  createProjectResolver,
  getProjectDisplayName,
} from "./project-resolver";

const TEST_DIR = path.join("/tmp", "cc-resolver-test-" + Date.now());
const CONFIG_DIR = path.join(TEST_DIR, "config");
const BASE_DIR = path.join(TEST_DIR, "projects");

beforeEach(async () => {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(BASE_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

function createTestResolver() {
  const configReader = createConfigReader(CONFIG_DIR);
  const resolver = createProjectResolver({
    readConfig: () => configReader.readConfig(),
  });
  return { configReader, resolver };
}

describe("resolveProjectPath", () => {
  it("returns absolute path for a valid git repository", async () => {
    const { configReader, resolver } = createTestResolver();
    const config = await configReader.readConfig();
    await configReader.writeConfig({ ...config, baseDir: BASE_DIR });

    const repoPath = path.join(BASE_DIR, "my-repo");
    await mkdir(path.join(repoPath, ".git"), { recursive: true });

    const result = await resolver.resolveProjectPath("my-repo");
    expect(result).toBe(repoPath);
  });

  it("returns null when directory does not exist", async () => {
    const { configReader, resolver } = createTestResolver();
    const config = await configReader.readConfig();
    await configReader.writeConfig({ ...config, baseDir: BASE_DIR });

    const result = await resolver.resolveProjectPath("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when directory exists but has no .git", async () => {
    const { configReader, resolver } = createTestResolver();
    const config = await configReader.readConfig();
    await configReader.writeConfig({ ...config, baseDir: BASE_DIR });

    await mkdir(path.join(BASE_DIR, "no-git-dir"), { recursive: true });

    const result = await resolver.resolveProjectPath("no-git-dir");
    expect(result).toBeNull();
  });

  it("uses explicit baseDir when provided", async () => {
    const { resolver } = createTestResolver();
    const customBase = path.join(TEST_DIR, "custom");
    const repoPath = path.join(customBase, "repo");
    await mkdir(path.join(repoPath, ".git"), { recursive: true });

    const result = await resolver.resolveProjectPath("repo", customBase);
    expect(result).toBe(repoPath);
  });
});

describe("getProjectDisplayName", () => {
  it("returns last path segment", () => {
    expect(getProjectDisplayName("/home/user/projects/my-repo")).toBe(
      "my-repo",
    );
  });

  it("returns full path as fallback for root", () => {
    expect(getProjectDisplayName("/")).toBe("/");
  });
});
