import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  CursorPackageProbe,
  CursorStaticPreflightDeps,
} from "./preflight";
import {
  createCursorPackageProbe,
  createCachedCursorPreflight,
  runCursorStaticPreflight,
} from "./preflight";
import {
  CURSOR_SDK_DECLARED_DEPENDENCIES,
  CURSOR_SDK_ENTRY_FILES,
  CURSOR_SDK_LAZY_CHUNK_DIR,
  CURSOR_SDK_MIN_LAZY_CHUNKS,
  CURSOR_SDK_PACKAGE,
  CURSOR_SDK_PINNED_VERSION,
  cursorSdkExecutableAssetsForHost,
  cursorSdkPlatformPackageForHost,
} from "./sdk-pin";

const API_KEY = "key_sentinel_do_not_leak";
const MODEL = "composer-2.5";

const LINUX_PLATFORM_PACKAGE = cursorSdkPlatformPackageForHost("linux-x64");
const DARWIN_PLATFORM_PACKAGE = cursorSdkPlatformPackageForHost("darwin-x64");
const DARWIN_ARM_PLATFORM_PACKAGE =
  cursorSdkPlatformPackageForHost("darwin-arm64");

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
 *
 * A real install carries exactly one platform package — the host's own — which
 * is why the layout takes the package rather than containing every one.
 */
function healthyInstall(
  platformPackage: string = LINUX_PLATFORM_PACKAGE,
  host = "linux-x64",
): FakeInstall {
  const versions = new Map<string, string>([
    [CURSOR_SDK_PACKAGE, CURSOR_SDK_PINNED_VERSION],
    [platformPackage, CURSOR_SDK_PINNED_VERSION],
  ]);
  for (const dependency of CURSOR_SDK_DECLARED_DEPENDENCIES) {
    versions.set(dependency, "1.0.0");
  }

  const files = new Set<string>();
  for (const entry of CURSOR_SDK_ENTRY_FILES) {
    files.add(`${CURSOR_SDK_PACKAGE}:${entry}`);
  }
  const executables = new Set<string>();
  for (const asset of cursorSdkExecutableAssetsForHost(host)) {
    files.add(`${platformPackage}:${asset}`);
    executables.add(`${platformPackage}:${asset}`);
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
  it("passes on the linux baseline and records secret-free diagnostics", async () => {
    const result = await preflight(healthyInstall());

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toStrictEqual({
      sdkPackage: CURSOR_SDK_PACKAGE,
      requiredSdkVersion: CURSOR_SDK_PINNED_VERSION,
      installedSdkVersion: CURSOR_SDK_PINNED_VERSION,
      platformPackage: LINUX_PLATFORM_PACKAGE,
      installedPlatformVersion: CURSOR_SDK_PINNED_VERSION,
      host: "linux-x64",
      nodeVersion: "v22.13.0",
      requiredNodeVersion: ">=22.13",
      model: MODEL,
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("passes on darwin-x64 and checks the darwin platform package", async () => {
    const result = await preflight(healthyInstall(DARWIN_PLATFORM_PACKAGE), {
      host: { platform: "darwin", arch: "x64" },
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics.host).toBe("darwin-x64");
    expect(result.diagnostics.platformPackage).toBe(DARWIN_PLATFORM_PACKAGE);
    expect(result.diagnostics.installedPlatformVersion).toBe(
      CURSOR_SDK_PINNED_VERSION,
    );
  });

  it("passes on darwin-arm64 when the SDK platform package is installed", async () => {
    const result = await preflight(
      healthyInstall(DARWIN_ARM_PLATFORM_PACKAGE),
      {
        host: { platform: "darwin", arch: "arm64" },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics.host).toBe("darwin-arm64");
    expect(result.diagnostics.platformPackage).toBe(
      DARWIN_ARM_PLATFORM_PACKAGE,
    );
  });

  it("uses installed platform packages without an evidence allowlist", async () => {
    const hosts = [
      { platform: "linux", arch: "arm64" },
      { platform: "win32", arch: "x64" },
      { platform: "freebsd", arch: "riscv64" },
    ];

    for (const host of hosts) {
      const hostName = `${host.platform}-${host.arch}`;
      const platformPackage = cursorSdkPlatformPackageForHost(hostName);
      const result = await preflight(
        healthyInstall(platformPackage, hostName),
        { host },
      );

      expect(result.ok).toBe(true);
      expect(result.diagnostics.platformPackage).toBe(platformPackage);
    }
  });

  it("selects the platform package by host, not by what happens to resolve", async () => {
    // A linux platform package present on a darwin host proves nothing about
    // darwin's native assets, so the darwin package is the one that must exist.
    const result = await preflight(healthyInstall(LINUX_PLATFORM_PACKAGE), {
      host: { platform: "darwin", arch: "x64" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("platform_package_missing");
    expect(result.message).toContain(DARWIN_PLATFORM_PACKAGE);
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

  it("fails when the current machine's platform package is absent", async () => {
    const host = { platform: "darwin", arch: "arm64" };
    const result = await preflight(healthyInstall(), { host });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("platform_package_missing");
    expect(result.message).toContain(DARWIN_ARM_PLATFORM_PACKAGE);
    expect(result.diagnostics.host).toBe("darwin-arm64");
    expect(result.diagnostics.platformPackage).toBe(
      DARWIN_ARM_PLATFORM_PACKAGE,
    );
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
    missing.versions.delete(LINUX_PLATFORM_PACKAGE);
    const missingResult = await preflight(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.code).toBe("platform_package_missing");
      expect(missingResult.message).toContain(LINUX_PLATFORM_PACKAGE);
    }

    const mismatched = healthyInstall();
    mismatched.versions.set(LINUX_PLATFORM_PACKAGE, "1.0.27");
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
    for (const asset of cursorSdkExecutableAssetsForHost("linux-x64")) {
      const absent = healthyInstall();
      absent.files.delete(`${LINUX_PLATFORM_PACKAGE}:${asset}`);
      const absentResult = await preflight(absent);
      expect(absentResult.ok).toBe(false);
      if (!absentResult.ok) {
        expect(absentResult.code).toBe("native_asset_missing");
        expect(absentResult.message).toContain(asset);
      }

      // Present but mode-stripped: the SDK would fail mid-turn instead of at
      // load, which is exactly what preflight exists to prevent.
      const notExecutable = healthyInstall();
      notExecutable.executables.delete(`${LINUX_PLATFORM_PACKAGE}:${asset}`);
      const notExecutableResult = await preflight(notExecutable);
      expect(notExecutableResult.ok).toBe(false);
      if (!notExecutableResult.ok) {
        expect(notExecutableResult.code).toBe("native_asset_not_executable");
        expect(notExecutableResult.message).toContain(asset);
      }
    }
  });

  it("checks the SDK install before the machine's derived platform package", async () => {
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
    expect(probed).toStrictEqual([
      CURSOR_SDK_PACKAGE,
      DARWIN_ARM_PLATFORM_PACKAGE,
    ]);
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

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expect(result.diagnostics.installedSdkVersion).toBe(
      CURSOR_SDK_PINNED_VERSION,
    );
    expect(result.diagnostics.installedPlatformVersion).toBe(
      CURSOR_SDK_PINNED_VERSION,
    );
  });
});

describe("cached Cursor preflight", () => {
  it("shares the check until package identity changes, preserving each launch model", async () => {
    const install = healthyInstall();
    let identity = "/sdk/package.json:1";
    let checks = 0;
    const check = createCachedCursorPreflight({
      ...depsFor(install),
      packageIdentity: async () => identity,
      workerNodeVersion: async () => {
        checks += 1;
        return "v22.13.0";
      },
    });
    const results = await Promise.all([
      check({ model: "first" }),
      check({ model: "second" }),
    ]);
    expect(checks).toBe(1);
    expect(results.map((result) => result.diagnostics.model)).toEqual([
      "first",
      "second",
    ]);
    install.versions.set(CURSOR_SDK_PACKAGE, "broken");
    expect((await check({ model: MODEL })).ok).toBe(true);
    identity = "/sdk/package.json:2";
    expect((await check({ model: MODEL })).ok).toBe(false);
    expect((await check({ model: MODEL })).ok).toBe(false);
    expect(checks).toBe(2);
    identity = "/other-sdk/package.json:2";
    await check({ model: MODEL });
    expect(checks).toBe(3);
  });
});
