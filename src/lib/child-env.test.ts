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

  it("strips NODE_ENV", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const env = buildChildEnv();
    expect(env.NODE_ENV).toBeUndefined();
  });

  it("strips __NEXT_ prefixed vars", () => {
    process.env.__NEXT_FOO = "bar";
    const env = buildChildEnv();
    expect(env.__NEXT_FOO).toBeUndefined();
  });

  it("strips __TURBOPACK_ prefixed vars", () => {
    process.env.__TURBOPACK_FOO = "bar";
    const env = buildChildEnv();
    expect(env.__TURBOPACK_FOO).toBeUndefined();
  });

  it("strips NODE_CHANNEL_ prefixed vars", () => {
    process.env.NODE_CHANNEL_FD = "3";
    const env = buildChildEnv();
    expect(env.NODE_CHANNEL_FD).toBeUndefined();
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
