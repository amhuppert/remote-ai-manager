// @vitest-inputs package.json
import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

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

const repositoryRoot = process.cwd();
const nodeModules = path.join(repositoryRoot, "node_modules");

/**
 * Package managers install only the platform package that matches the host, so
 * installed-layout checks can speak for this host alone.
 */
const hostPlatformPackage = cursorSdkPlatformPackageForHost(
  `${process.platform}-${process.arch}`,
);

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function dependencyRange(manifest: unknown, name: string): string {
  expect(manifest).toBeTypeOf("object");
  if (manifest === null || typeof manifest !== "object") return "";
  const dependencies = Reflect.get(manifest, "dependencies");
  if (dependencies === null || typeof dependencies !== "object") return "";
  const range = Reflect.get(dependencies, name);
  return typeof range === "string" ? range : "";
}

function optionalDependencyEntries(manifest: unknown): [string, string][] {
  if (manifest === null || typeof manifest !== "object") return [];
  const dependencies = Reflect.get(manifest, "optionalDependencies");
  if (dependencies === null || typeof dependencies !== "object") return [];
  return Object.entries(dependencies).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

function manifestVersion(manifest: unknown): string {
  if (manifest === null || typeof manifest !== "object") return "";
  const version = Reflect.get(manifest, "version");
  return typeof version === "string" ? version : "";
}

describe("cursor SDK pin", () => {
  it("pins the SDK and its published platform packages exactly", async () => {
    const manifest = await readJson(path.join(repositoryRoot, "package.json"));
    const installedSdk = await readJson(
      path.join(nodeModules, CURSOR_SDK_PACKAGE, "package.json"),
    );

    expect(dependencyRange(manifest, CURSOR_SDK_PACKAGE)).toBe(
      CURSOR_SDK_PINNED_VERSION,
    );
    const platformPackages = optionalDependencyEntries(installedSdk).filter(
      ([name]) => name.startsWith("@cursor/sdk-"),
    );
    expect(platformPackages.length).toBeGreaterThan(0);
    for (const [platformPackage, version] of platformPackages) {
      expect(version).toBe(CURSOR_SDK_PINNED_VERSION);
      const host = platformPackage.slice("@cursor/sdk-".length);
      expect(cursorSdkPlatformPackageForHost(host)).toBe(platformPackage);
    }
  });

  it("resolves the SDK and this host's platform package at the pinned version", async () => {
    for (const packageName of [CURSOR_SDK_PACKAGE, hostPlatformPackage]) {
      const installed = await readJson(
        path.join(nodeModules, packageName, "package.json"),
      );
      expect(manifestVersion(installed)).toBe(CURSOR_SDK_PINNED_VERSION);
    }
  });

  it("exposes the normal Node entry points and their lazy chunks", async () => {
    const sdkRoot = path.join(nodeModules, CURSOR_SDK_PACKAGE);

    for (const entry of CURSOR_SDK_ENTRY_FILES) {
      const entryStat = await stat(path.join(sdkRoot, entry));
      expect(entryStat.isFile()).toBe(true);
      expect(entryStat.size).toBeGreaterThan(0);
    }

    const chunkDirectory = await readdir(
      path.join(sdkRoot, CURSOR_SDK_LAZY_CHUNK_DIR),
    );
    const chunks = chunkDirectory.filter((name) =>
      CURSOR_SDK_LAZY_CHUNK_PATTERN.test(name),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(CURSOR_SDK_MIN_LAZY_CHUNKS);
  });

  it("declares the SDK Node floor the worker preflight enforces", async () => {
    const installed = await readJson(
      path.join(nodeModules, CURSOR_SDK_PACKAGE, "package.json"),
    );
    expect(installed).toBeTypeOf("object");
    const engines =
      installed !== null && typeof installed === "object"
        ? Reflect.get(installed, "engines")
        : undefined;
    const nodeRange =
      engines !== null && typeof engines === "object"
        ? Reflect.get(engines, "node")
        : undefined;

    expect(nodeRange).toBe(
      `>=${CURSOR_SDK_MIN_NODE_MAJOR}.${CURSOR_SDK_MIN_NODE_MINOR}`,
    );
  });

  it("resolves every dependency the SDK declares", async () => {
    const installed = await readJson(
      path.join(nodeModules, CURSOR_SDK_PACKAGE, "package.json"),
    );
    const declared =
      installed !== null && typeof installed === "object"
        ? Reflect.get(installed, "dependencies")
        : undefined;
    expect(declared).toBeTypeOf("object");
    expect(Object.keys(declared as object).sort()).toEqual([
      ...CURSOR_SDK_DECLARED_DEPENDENCIES,
    ]);

    for (const dependency of CURSOR_SDK_DECLARED_DEPENDENCIES) {
      const dependencyManifest = await readJson(
        path.join(nodeModules, dependency, "package.json"),
      );
      expect(manifestVersion(dependencyManifest).length).toBeGreaterThan(0);
    }
  });

  it("ships executable platform assets for this host", async () => {
    const platformRoot = path.join(nodeModules, hostPlatformPackage);

    for (const asset of cursorSdkExecutableAssetsForHost(
      `${process.platform}-${process.arch}`,
    )) {
      const assetPath = path.join(platformRoot, asset);
      await expect(access(assetPath, constants.X_OK)).resolves.toBeUndefined();
      expect((await stat(assetPath)).size).toBeGreaterThan(0);
    }
  });
});
