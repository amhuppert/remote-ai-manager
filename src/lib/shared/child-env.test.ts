import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { buildChildEnv, findNodeBinDir } from "./child-env";
import type { FindNodeDeps } from "./child-env";

describe("buildChildEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("overrides NODE_ENV to development so it survives a merge over process.env", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const env = buildChildEnv();
    expect(env.NODE_ENV).toBe("development");
  });

  it("clobbers __NEXT_ prefixed vars to empty string", () => {
    process.env.__NEXT_FOO = "bar";
    const env = buildChildEnv();
    expect(env.__NEXT_FOO).toBe("");
  });

  it("clobbers __TURBOPACK_ prefixed vars to empty string", () => {
    process.env.__TURBOPACK_FOO = "bar";
    const env = buildChildEnv();
    expect(env.__TURBOPACK_FOO).toBe("");
  });

  it("clobbers NODE_CHANNEL_ prefixed vars to empty string", () => {
    process.env.NODE_CHANNEL_FD = "3";
    const env = buildChildEnv();
    expect(env.NODE_CHANNEL_FD).toBe("");
  });

  it("survives an SDK-style merge over process.env (parent NODE_ENV does not leak through)", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.__NEXT_PRIVATE_ORIGIN = "http://localhost:3000";
    const merged = { ...process.env, ...buildChildEnv() };
    expect(merged.NODE_ENV).toBe("development");
    expect(merged.__NEXT_PRIVATE_ORIGIN).toBe("");
  });

  it("strips inherited git location/index vars so child git commands use their own cwd", () => {
    // Reproduces the pre-commit-hook leak: git runs hooks with GIT_DIR /
    // GIT_INDEX_FILE / GIT_WORK_TREE exported, and any child `git` that inherits
    // them would mutate the hook's repo instead of its own working directory.
    process.env.GIT_DIR = "/real/repo/.git";
    process.env.GIT_WORK_TREE = "/real/repo";
    process.env.GIT_INDEX_FILE = "/real/repo/.git/index";
    process.env.GIT_PREFIX = "subdir/";
    process.env.GIT_COMMON_DIR = "/real/repo/.git";
    process.env.GIT_OBJECT_DIRECTORY = "/real/repo/.git/objects";
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = "/alt/objects";
    process.env.GIT_NAMESPACE = "ns";

    const env = buildChildEnv();

    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_PREFIX).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect(env.GIT_NAMESPACE).toBeUndefined();
  });
});

describe("findNodeBinDir", () => {
  function makeDeps(
    existingPaths: Set<string>,
    versionDirs: Record<string, string[]> = {},
  ): FindNodeDeps {
    return {
      existsSync: (p: string) => existingPaths.has(p),
      readdirSync: (p: string) => versionDirs[p] ?? [],
      homedir: () => "/home/testuser",
      platform: () => "linux",
    };
  }

  it("returns null when node is already on PATH", () => {
    const deps = makeDeps(new Set(["/usr/bin/node"]));
    const result = findNodeBinDir(
      `/usr/bin${path.delimiter}/usr/local/bin`,
      deps,
    );
    expect(result).toBeNull();
  });

  it("finds node via nvm", () => {
    const nvmBin = "/home/testuser/.nvm/versions/node/v22.14.0/bin";
    const nvmBase = "/home/testuser/.nvm/versions/node";
    const deps = makeDeps(new Set([nvmBase, `${nvmBin}/node`]), {
      [nvmBase]: ["v20.11.0", "v22.14.0"],
    });
    const result = findNodeBinDir("", deps);
    expect(result).toBe(nvmBin);
  });

  it("prefers latest nvm version", () => {
    const nvmBase = "/home/testuser/.nvm/versions/node";
    const deps = makeDeps(
      new Set([
        nvmBase,
        `${nvmBase}/v18.0.0/bin/node`,
        `${nvmBase}/v22.14.0/bin/node`,
      ]),
      { [nvmBase]: ["v18.0.0", "v22.14.0"] },
    );
    const result = findNodeBinDir("", deps);
    expect(result).toBe(`${nvmBase}/v22.14.0/bin`);
  });

  it("respects NVM_DIR env var", () => {
    const customNvm = "/custom/nvm";
    const nvmBase = `${customNvm}/versions/node`;
    const deps: FindNodeDeps = {
      existsSync: (p: string) =>
        p === nvmBase || p === `${nvmBase}/v20.0.0/bin/node`,
      readdirSync: (p: string) => (p === nvmBase ? ["v20.0.0"] : []),
      homedir: () => "/home/testuser",
      platform: () => "linux",
      nvmDir: customNvm,
    };
    const result = findNodeBinDir("", deps);
    expect(result).toBe(`${nvmBase}/v20.0.0/bin`);
  });

  it("finds node via fnm on linux", () => {
    const fnmBase = "/home/testuser/.local/share/fnm/node-versions";
    const fnmBin = `${fnmBase}/v22.0.0/installation/bin`;
    const deps = makeDeps(new Set([fnmBase, `${fnmBin}/node`]), {
      [fnmBase]: ["v22.0.0"],
    });
    const result = findNodeBinDir("", deps);
    expect(result).toBe(fnmBin);
  });

  it("finds node via mise", () => {
    const miseBase = "/home/testuser/.local/share/mise/installs/node";
    const miseBin = `${miseBase}/22.14.0/bin`;
    const deps = makeDeps(new Set([miseBase, `${miseBin}/node`]), {
      [miseBase]: ["22.14.0"],
    });
    const result = findNodeBinDir("", deps);
    expect(result).toBe(miseBin);
  });

  it("finds node via volta", () => {
    const voltaBin = "/home/testuser/.volta/bin";
    const deps = makeDeps(new Set([`${voltaBin}/node`]));
    const result = findNodeBinDir("", deps);
    expect(result).toBe(voltaBin);
  });

  it("falls back to system paths", () => {
    const deps = makeDeps(new Set(["/usr/local/bin/node"]));
    const result = findNodeBinDir("", deps);
    expect(result).toBe("/usr/local/bin");
  });

  it("returns null when no node found anywhere", () => {
    const deps = makeDeps(new Set());
    const result = findNodeBinDir("", deps);
    expect(result).toBeNull();
  });
});
