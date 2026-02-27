import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const TEST_DIR = path.join("/tmp", "cc-resolver-test-" + Date.now());
const BASE_DIR = path.join(TEST_DIR, "projects");

// Mock node:os to redirect homedir to test directory
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      platform: () => "linux",
      homedir: () => TEST_DIR,
    },
    platform: () => "linux",
    homedir: () => TEST_DIR,
  };
});

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await mkdir(BASE_DIR, { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

/** Helper: set up config to point at our test BASE_DIR */
async function setupConfig() {
  const { readConfig, writeConfig } = await import("./config");
  const config = await readConfig();
  await writeConfig({ ...config, baseDir: BASE_DIR });
}

describe("resolveProjectPath", () => {
  it("returns absolute path for a valid git repository", async () => {
    await setupConfig();
    const repoPath = path.join(BASE_DIR, "my-repo");
    await mkdir(path.join(repoPath, ".git"), { recursive: true });

    vi.resetModules();
    const { resolveProjectPath } = await import("./project-resolver");
    const result = await resolveProjectPath("my-repo");

    expect(result).toBe(repoPath);
  });

  it("returns null when directory does not exist", async () => {
    await setupConfig();

    vi.resetModules();
    const { resolveProjectPath } = await import("./project-resolver");
    const result = await resolveProjectPath("nonexistent");

    expect(result).toBeNull();
  });

  it("returns null when directory exists but has no .git", async () => {
    await setupConfig();
    await mkdir(path.join(BASE_DIR, "no-git-dir"), { recursive: true });

    vi.resetModules();
    const { resolveProjectPath } = await import("./project-resolver");
    const result = await resolveProjectPath("no-git-dir");

    expect(result).toBeNull();
  });
});
