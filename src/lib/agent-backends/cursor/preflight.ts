import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  CURSOR_SDK_DECLARED_DEPENDENCIES,
  CURSOR_SDK_ENTRY_FILES,
  CURSOR_SDK_LAZY_CHUNK_DIR,
  CURSOR_SDK_LAZY_CHUNK_PATTERN,
  CURSOR_SDK_MIN_LAZY_CHUNKS,
  CURSOR_SDK_MIN_NODE_MAJOR,
  CURSOR_SDK_MIN_NODE_MINOR,
  CURSOR_SDK_PACKAGE,
  CURSOR_SDK_PINNED_VERSION,
  cursorSdkExecutableAssetsForHost,
  cursorSdkPlatformPackageForHost,
} from "./sdk-pin";

/**
 * Layer 1 of the Cursor preflight (spec D3): the cheap static checks that run
 * in the server before any worker is spawned. Layer 2 — verifying the
 * credential through the SDK — only exists where the SDK runs and belongs to
 * the worker startup handshake.
 *
 * Every check fails closed and names the mismatch. Machine eligibility follows
 * the installed SDK platform package rather than an acceptance-evidence
 * allowlist.
 */

export type CursorPreflightFailureCode =
  | "node_version_unsupported"
  | "sdk_package_missing"
  | "sdk_version_mismatch"
  | "platform_package_missing"
  | "platform_package_version_mismatch"
  | "sdk_entry_missing"
  | "sdk_chunks_missing"
  | "sdk_dependency_missing"
  | "native_asset_missing"
  | "native_asset_not_executable";

/**
 * Recorded on success and failure alike. Deliberately limited to package
 * identity, versions, host, and the selected model — no credential material and
 * no filesystem paths that could carry one.
 */
export interface CursorPreflightDiagnostics {
  sdkPackage: string;
  requiredSdkVersion: string;
  installedSdkVersion: string | null;
  platformPackage: string;
  installedPlatformVersion: string | null;
  host: string;
  nodeVersion: string | null;
  requiredNodeVersion: string;
  model: string;
}

export type CursorStaticPreflightResult =
  | { ok: true; diagnostics: CursorPreflightDiagnostics }
  | {
      ok: false;
      code: CursorPreflightFailureCode;
      message: string;
      diagnostics: CursorPreflightDiagnostics;
    };

/**
 * The package-layout seam. Production reads node_modules; tests supply an
 * in-memory layout, so every failure mode is reachable without staging a
 * broken install on disk.
 */
export interface CursorPackageProbe {
  /** Installed version, or null when the package does not resolve at all. */
  version(packageName: string): Promise<string | null>;
  fileExists(packageName: string, relativePath: string): Promise<boolean>;
  listDirectory(
    packageName: string,
    relativePath: string,
  ): Promise<readonly string[]>;
  isExecutable(packageName: string, relativePath: string): Promise<boolean>;
}

export interface CursorStaticPreflightDeps {
  packages: CursorPackageProbe;
  host: { platform: string; arch: string };
  /**
   * Version string of the Node runtime that will execute the worker. Injected
   * rather than read from `process.versions`: the server may itself run under a
   * different runtime, and the worker's executable is the supervisor's choice.
   */
  workerNodeVersion(): Promise<string | null>;
}

export const CURSOR_REQUIRED_NODE_VERSION = `>=${CURSOR_SDK_MIN_NODE_MAJOR}.${CURSOR_SDK_MIN_NODE_MINOR}`;

/** Accepts both `v22.13.0` and `22.13.0`; anything else is unusable. */
export function parseNodeVersion(
  version: string,
): { major: number; minor: number } | null {
  const matched = /^v?(\d+)\.(\d+)\./.exec(version.trim());
  if (matched === null) return null;
  const major = Number(matched[1]);
  const minor = Number(matched[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { major, minor };
}

function meetsNodeFloor(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (parsed === null) return false;
  if (parsed.major !== CURSOR_SDK_MIN_NODE_MAJOR) {
    return parsed.major > CURSOR_SDK_MIN_NODE_MAJOR;
  }
  return parsed.minor >= CURSOR_SDK_MIN_NODE_MINOR;
}

interface Probed {
  sdkVersion: string | null;
  platformVersion: string | null;
}

function diagnosticsFor(
  model: string,
  host: string,
  nodeVersion: string | null,
  probed: Probed,
): CursorPreflightDiagnostics {
  return {
    sdkPackage: CURSOR_SDK_PACKAGE,
    requiredSdkVersion: CURSOR_SDK_PINNED_VERSION,
    installedSdkVersion: probed.sdkVersion,
    platformPackage: cursorSdkPlatformPackageForHost(host),
    installedPlatformVersion: probed.platformVersion,
    host,
    nodeVersion,
    requiredNodeVersion: CURSOR_REQUIRED_NODE_VERSION,
    model,
  };
}

export async function runCursorStaticPreflight(
  input: { model: string },
  deps: CursorStaticPreflightDeps,
): Promise<CursorStaticPreflightResult> {
  const host = `${deps.host.platform}-${deps.host.arch}`;
  const platformPackage = cursorSdkPlatformPackageForHost(host);
  const probed: Probed = { sdkVersion: null, platformVersion: null };

  const fail = (
    code: CursorPreflightFailureCode,
    message: string,
    nodeVersion: string | null,
  ): CursorStaticPreflightResult => ({
    ok: false,
    code,
    message,
    diagnostics: diagnosticsFor(input.model, host, nodeVersion, probed),
  });

  const nodeVersion = await deps.workerNodeVersion();
  if (nodeVersion === null) {
    return fail(
      "node_version_unsupported",
      `Could not determine the worker Node version; ${CURSOR_REQUIRED_NODE_VERSION} is required.`,
      null,
    );
  }
  if (!meetsNodeFloor(nodeVersion)) {
    return fail(
      "node_version_unsupported",
      `Worker Node ${nodeVersion} is below the SDK floor ${CURSOR_REQUIRED_NODE_VERSION}.`,
      nodeVersion,
    );
  }

  probed.sdkVersion = await deps.packages.version(CURSOR_SDK_PACKAGE);
  if (probed.sdkVersion === null) {
    return fail(
      "sdk_package_missing",
      `${CURSOR_SDK_PACKAGE} is not installed.`,
      nodeVersion,
    );
  }
  if (probed.sdkVersion !== CURSOR_SDK_PINNED_VERSION) {
    return fail(
      "sdk_version_mismatch",
      `${CURSOR_SDK_PACKAGE} ${probed.sdkVersion} is installed but only ${CURSOR_SDK_PINNED_VERSION} is tested.`,
      nodeVersion,
    );
  }

  probed.platformVersion = await deps.packages.version(platformPackage);
  if (probed.platformVersion === null) {
    return fail(
      "platform_package_missing",
      `${platformPackage} is not installed.`,
      nodeVersion,
    );
  }
  if (probed.platformVersion !== CURSOR_SDK_PINNED_VERSION) {
    return fail(
      "platform_package_version_mismatch",
      `${platformPackage} ${probed.platformVersion} does not match the tested ${CURSOR_SDK_PINNED_VERSION}.`,
      nodeVersion,
    );
  }

  for (const entry of CURSOR_SDK_ENTRY_FILES) {
    if (!(await deps.packages.fileExists(CURSOR_SDK_PACKAGE, entry))) {
      return fail(
        "sdk_entry_missing",
        `${CURSOR_SDK_PACKAGE} is missing its Node entry point ${entry}.`,
        nodeVersion,
      );
    }
  }

  const chunkDirectory = await deps.packages.listDirectory(
    CURSOR_SDK_PACKAGE,
    CURSOR_SDK_LAZY_CHUNK_DIR,
  );
  const chunkCount = chunkDirectory.filter((name) =>
    CURSOR_SDK_LAZY_CHUNK_PATTERN.test(name),
  ).length;
  if (chunkCount < CURSOR_SDK_MIN_LAZY_CHUNKS) {
    return fail(
      "sdk_chunks_missing",
      `${CURSOR_SDK_PACKAGE} has ${chunkCount} lazy chunks in ${CURSOR_SDK_LAZY_CHUNK_DIR}; at least ${CURSOR_SDK_MIN_LAZY_CHUNKS} are required.`,
      nodeVersion,
    );
  }

  for (const dependency of CURSOR_SDK_DECLARED_DEPENDENCIES) {
    if ((await deps.packages.version(dependency)) === null) {
      return fail(
        "sdk_dependency_missing",
        `${CURSOR_SDK_PACKAGE} declares ${dependency}, which does not resolve.`,
        nodeVersion,
      );
    }
  }

  for (const asset of cursorSdkExecutableAssetsForHost(host)) {
    if (!(await deps.packages.fileExists(platformPackage, asset))) {
      return fail(
        "native_asset_missing",
        `${platformPackage} is missing the native asset ${asset}.`,
        nodeVersion,
      );
    }
    if (!(await deps.packages.isExecutable(platformPackage, asset))) {
      return fail(
        "native_asset_not_executable",
        `${platformPackage} asset ${asset} is present but not executable.`,
        nodeVersion,
      );
    }
  }

  return {
    ok: true,
    diagnostics: diagnosticsFor(input.model, host, nodeVersion, probed),
  };
}

function manifestVersion(manifest: unknown): string | null {
  if (manifest === null || typeof manifest !== "object") return null;
  const version: unknown = Reflect.get(manifest, "version");
  return typeof version === "string" && version.length > 0 ? version : null;
}

/**
 * Reads the real package layout. Packages are resolved by directory rather than
 * `require.resolve`, because the SDK's `exports` map does not expose
 * `./package.json` and its native assets are not exported subpaths at all.
 */
export function createCursorPackageProbe(
  nodeModulesDir: string,
): CursorPackageProbe {
  const resolve = (packageName: string, relativePath: string): string =>
    path.join(nodeModulesDir, packageName, relativePath);

  return {
    async version(packageName) {
      try {
        const manifest: unknown = JSON.parse(
          await readFile(resolve(packageName, "package.json"), "utf8"),
        );
        return manifestVersion(manifest);
      } catch {
        return null;
      }
    },
    async fileExists(packageName, relativePath) {
      try {
        await access(resolve(packageName, relativePath), constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async listDirectory(packageName, relativePath) {
      try {
        return await readdir(resolve(packageName, relativePath));
      } catch {
        return [];
      }
    },
    async isExecutable(packageName, relativePath) {
      try {
        await access(resolve(packageName, relativePath), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createCachedCursorPreflight(
  deps: CursorStaticPreflightDeps & { packageIdentity(): Promise<string> },
): (input: { model: string }) => Promise<CursorStaticPreflightResult> {
  let cached:
    | { identity: string; result: Promise<CursorStaticPreflightResult> }
    | undefined;
  return async (input) => {
    const identity = await deps.packageIdentity();
    if (cached?.identity !== identity) {
      cached = { identity, result: runCursorStaticPreflight(input, deps) };
    }
    const result = await cached.result;
    return {
      ...result,
      diagnostics: { ...result.diagnostics, model: input.model },
    };
  };
}

export const runProductionCursorPreflight = createCachedCursorPreflight({
  packages: createCursorPackageProbe(path.join(process.cwd(), "node_modules")),
  host: { platform: process.platform, arch: process.arch },
  workerNodeVersion: async () => process.version,
  async packageIdentity() {
    const manifest = path.join(
      process.cwd(),
      "node_modules",
      CURSOR_SDK_PACKAGE,
      "package.json",
    );
    try {
      const resolved = await realpath(manifest);
      return `${resolved}:${(await stat(resolved)).mtimeMs}`;
    } catch {
      return `${manifest}:missing`;
    }
  },
});
