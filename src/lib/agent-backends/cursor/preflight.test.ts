import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  CursorPackageProbe,
  CursorStaticPreflightDeps,
} from "./preflight";
import {
  createCursorPackageProbe,
  runCursorStaticPreflight,
} from "./preflight";
import {
  CURSOR_SDK_DECLARED_DEPENDENCIES,
  CURSOR_SDK_ENTRY_FILES,
  CURSOR_SDK_EXECUTABLE_ASSETS,
  CURSOR_SDK_LAZY_CHUNK_DIR,
  CURSOR_SDK_MIN_LAZY_CHUNKS,
  CURSOR_SDK_PACKAGE,
  CURSOR_SDK_PINNED_VERSION,
  CURSOR_SDK_PLATFORM_PACKAGE,
} from "./sdk-pin";

const API_KEY = "key_sentinel_do_not_leak";
const MODEL = "composer-2.5";

interface FakeInstall {
  versions: Map<string, string>;
  files: Set<string>;
  executables: Set<string>;
  chunkCount: number;
}

/**
 * An in-memory package layout standing in for node_modules. It is a real
 * implementation of the probe seam — every check reads it the same way it reads
 * the filesystem — so removing a production check makes a case below fail.
 */
function healthyInstall(): FakeInstall {
  const versions = new Map<string, string>([
    [CURSOR_SDK_PACKAGE, CURSOR_SDK_PINNED_VERSION],
    [CURSOR_SDK_PLATFORM_PACKAGE, CURSOR_SDK_PINNED_VERSION],
  ]);
  for (const dependency of CURSOR_SDK_DECLARED_DEPENDENCIES) {
    versions.set(dependency, "1.0.0");
  }

  const files = new Set<string>();
  for (const entry of CURSOR_SDK_ENTRY_FILES) {
    files.add(`${CURSOR_SDK_PACKAGE}:${entry}`);
  }
  const executables = new Set<string>();
  for (const asset of CURSOR_SDK_EXECUTABLE_ASSETS) {
    files.add(`${CURSOR_SDK_PLATFORM_PACKAGE}:${asset}`);
    executables.add(`${CURSOR_SDK_PLATFORM_PACKAGE}:${asset}`);
  }

  return {
    versions,
    files,
    executables,
    chunkCount: CURSOR_SDK_MIN_LAZY_CHUNKS,
  };
}

function probeFor(install: FakeInstall): CursorPackageProbe {
  return {
    async version(packageName) {
      return install.versions.get(packageName) ?? null;
    },
    async fileExists(packageName, relativePath) {
      return install.files.has(`${packageName}:${relativePath}`);
    },
    async listDirectory(packageName, relativePath) {
      if (
        packageName !== CURSOR_SDK_PACKAGE ||
        relativePath !== CURSOR_SDK_LAZY_CHUNK_DIR
      ) {
        return [];
      }
      return [
        "index.js",
        ...Array.from(
          { length: install.chunkCount },
          (_unused, index) => `${index + 100}.js`,
        ),
      ];
    },
    async isExecutable(packageName, relativePath) {
      return install.executables.has(`${packageName}:${relativePath}`);
    },
  };
}

function depsFor(
  install: FakeInstall,
  overrides: Partial<Omit<CursorStaticPreflightDeps, "packages">> = {},
): CursorStaticPreflightDeps {
  return {
    packages: probeFor(install),
    host: overrides.host ?? { platform: "linux", arch: "x64" },
    workerNodeVersion:
      overrides.workerNodeVersion ?? (async () => Promise.resolve("v22.13.0")),
  };
}

async function preflight(
  install: FakeInstall,
  overrides: Partial<Omit<CursorStaticPreflightDeps, "packages">> = {},
) {
  return runCursorStaticPreflight(
    { model: MODEL },
    depsFor(install, overrides),
  );
}

describe("cursor static preflight", () => {
  it("passes on the tested baseline and records secret-free diagnostics", async () => {
    const result = await preflight(healthyInstall());

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toStrictEqual({
      sdkPackage: CURSOR_SDK_PACKAGE,
      requiredSdkVersion: CURSOR_SDK_PINNED_VERSION,
      installedSdkVersion: CURSOR_SDK_PINNED_VERSION,
      platformPackage: CURSOR_SDK_PLATFORM_PACKAGE,
      installedPlatformVersion: CURSOR_SDK_PINNED_VERSION,
      host: "linux-x64",
      testedHost: "linux-x64",
      nodeVersion: "v22.13.0",
      requiredNodeVersion: ">=22.13",
      model: MODEL,
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("rejects a Node version below the SDK floor", async () => {
    for (const nodeVersion of ["v22.12.0", "v20.19.4", "v18.0.0"]) {
      const result = await preflight(healthyInstall(), {
        workerNodeVersion: async () => Promise.resolve(nodeVersion),
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("node_version_unsupported");
      expect(result.message).toContain(nodeVersion);
      expect(result.diagnostics.nodeVersion).toBe(nodeVersion);
    }
  });

  it("accepts Node at and above the floor", async () => {
    for (const nodeVersion of ["v22.13.0", "v22.14.2", "v24.1.0", "23.0.0"]) {
      const result = await preflight(healthyInstall(), {
        workerNodeVersion: async () => Promise.resolve(nodeVersion),
      });
      expect(result.ok).toBe(true);
    }
  });

  it("fails closed when the worker Node version cannot be determined", async () => {
    const result = await preflight(healthyInstall(), {
      workerNodeVersion: async () => Promise.resolve(null),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("node_version_unsupported");
  });

  it("fails closed on an untested host combination, naming the mismatch", async () => {
    for (const host of [
      { platform: "darwin", arch: "arm64" },
      { platform: "linux", arch: "arm64" },
      { platform: "win32", arch: "x64" },
    ]) {
      const result = await preflight(healthyInstall(), { host });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("host_unsupported");
      expect(result.message).toContain(`${host.platform}-${host.arch}`);
      expect(result.message).toContain("linux-x64");
      expect(result.diagnostics.host).toBe(`${host.platform}-${host.arch}`);
    }
  });

  it("fails closed when the SDK package is absent", async () => {
    const install = healthyInstall();
    install.versions.delete(CURSOR_SDK_PACKAGE);

    const result = await preflight(install);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("sdk_package_missing");
    expect(result.message).toContain(CURSOR_SDK_PACKAGE);
    expect(result.diagnostics.installedSdkVersion).toBeNull();
  });

  it("fails closed on an untested SDK version, naming both versions", async () => {
    const install = healthyInstall();
    install.versions.set(CURSOR_SDK_PACKAGE, "1.0.29");

    const result = await preflight(install);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("sdk_version_mismatch");
    expect(result.message).toContain("1.0.29");
    expect(result.message).toContain(CURSOR_SDK_PINNED_VERSION);
    expect(result.diagnostics.installedSdkVersion).toBe("1.0.29");
  });

  it("fails closed when the platform package is missing or mismatched", async () => {
    const missing = healthyInstall();
    missing.versions.delete(CURSOR_SDK_PLATFORM_PACKAGE);
    const missingResult = await preflight(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.code).toBe("platform_package_missing");
      expect(missingResult.message).toContain(CURSOR_SDK_PLATFORM_PACKAGE);
    }

    const mismatched = healthyInstall();
    mismatched.versions.set(CURSOR_SDK_PLATFORM_PACKAGE, "1.0.27");
    const mismatchedResult = await preflight(mismatched);
    expect(mismatchedResult.ok).toBe(false);
    if (!mismatchedResult.ok) {
      expect(mismatchedResult.code).toBe("platform_package_version_mismatch");
      expect(mismatchedResult.message).toContain("1.0.27");
      expect(mismatchedResult.diagnostics.installedPlatformVersion).toBe(
        "1.0.27",
      );
    }
  });

  it("fails closed when a normal Node entry point is absent", async () => {
    for (const entry of CURSOR_SDK_ENTRY_FILES) {
      const install = healthyInstall();
      install.files.delete(`${CURSOR_SDK_PACKAGE}:${entry}`);

      const result = await preflight(install);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("sdk_entry_missing");
      expect(result.message).toContain(entry);
    }
  });

  it("fails closed when the lazy chunks are incomplete", async () => {
    const install = healthyInstall();
    install.chunkCount = CURSOR_SDK_MIN_LAZY_CHUNKS - 1;

    const result = await preflight(install);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("sdk_chunks_missing");
    expect(result.message).toContain(String(CURSOR_SDK_MIN_LAZY_CHUNKS));
  });

  it("fails closed when a declared SDK dependency does not resolve", async () => {
    for (const dependency of CURSOR_SDK_DECLARED_DEPENDENCIES) {
      const install = healthyInstall();
      install.versions.delete(dependency);

      const result = await preflight(install);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("sdk_dependency_missing");
      expect(result.message).toContain(dependency);
    }
  });

  it("fails closed when a native asset is missing or not executable", async () => {
    for (const asset of CURSOR_SDK_EXECUTABLE_ASSETS) {
      const absent = healthyInstall();
      absent.files.delete(`${CURSOR_SDK_PLATFORM_PACKAGE}:${asset}`);
      const absentResult = await preflight(absent);
      expect(absentResult.ok).toBe(false);
      if (!absentResult.ok) {
        expect(absentResult.code).toBe("native_asset_missing");
        expect(absentResult.message).toContain(asset);
      }

      // Present but mode-stripped: the SDK would fail mid-turn instead of at
      // load, which is exactly what preflight exists to prevent.
      const notExecutable = healthyInstall();
      notExecutable.executables.delete(
        `${CURSOR_SDK_PLATFORM_PACKAGE}:${asset}`,
      );
      const notExecutableResult = await preflight(notExecutable);
      expect(notExecutableResult.ok).toBe(false);
      if (!notExecutableResult.ok) {
        expect(notExecutableResult.code).toBe("native_asset_not_executable");
        expect(notExecutableResult.message).toContain(asset);
      }
    }
  });

  it("reports the host mismatch before any package probe runs", async () => {
    // An untested host has no installed platform package, so probing first
    // would report a confusing missing-package error instead of the real cause.
    const probed: string[] = [];
    const install = healthyInstall();
    const base = probeFor(install);
    const result = await runCursorStaticPreflight(
      { model: MODEL },
      {
        packages: {
          async version(packageName) {
            probed.push(packageName);
            return base.version(packageName);
          },
          fileExists: base.fileExists,
          listDirectory: base.listDirectory,
          isExecutable: base.isExecutable,
        },
        host: { platform: "darwin", arch: "arm64" },
        workerNodeVersion: async () => Promise.resolve("v22.13.0"),
      },
    );

    expect(result.ok).toBe(false);
    expect(probed).toStrictEqual([]);
  });

  it("carries diagnostics on every failure without leaking secrets", async () => {
    const install = healthyInstall();
    install.versions.set(CURSOR_SDK_PACKAGE, "1.0.29");

    const result = await preflight(install);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result).sort()).toStrictEqual([
      "code",
      "diagnostics",
      "message",
      "ok",
    ]);
    expect(result.diagnostics.model).toBe(MODEL);
    expect(result.diagnostics.host).toBe("linux-x64");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("apikey");
  });
});

describe("cursor static preflight against the installed SDK", () => {
  // Proves the pinned constants, the real node_modules probe, and the checks
  // agree with what is actually installed — the in-memory layout above cannot
  // catch a constant that no longer matches the shipped package.
  it("passes on this host with the real package probe", async () => {
    const result = await runCursorStaticPreflight(
      { model: MODEL },
      {
        packages: createCursorPackageProbe(
          path.join(process.cwd(), "node_modules"),
        ),
        host: { platform: process.platform, arch: process.arch },
        workerNodeVersion: async () =>
          Promise.resolve(`v${process.versions.node}`),
      },
    );

    if (process.platform !== "linux" || process.arch !== "x64") {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("host_unsupported");
      return;
    }

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expect(result.diagnostics.installedSdkVersion).toBe(
      CURSOR_SDK_PINNED_VERSION,
    );
    expect(result.diagnostics.installedPlatformVersion).toBe(
      CURSOR_SDK_PINNED_VERSION,
    );
  });
});
