import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildInfo } from "@/lib/build-info";
import { installCctl } from "./install-cli";

const BUILD: BuildInfo = {
  sha: "abc1234",
  buildTime: "2026-07-02T10:00:00.000Z",
};

/** A bundle stamped like the real one — BUILD_INFO serialized into the source. */
function stampedBundle(info: BuildInfo, body = "console.log(1);"): string {
  return `#!/usr/bin/env node\nvar BUILD_INFO={sha:${JSON.stringify(info.sha)},buildTime:${JSON.stringify(info.buildTime)}};\n${body}\n`;
}

let dir: string;
let bundlePath: string;
let configDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cc-install-"));
  bundlePath = path.join(dir, "cctl.mjs");
  configDir = path.join(dir, "config");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("installCctl", () => {
  it("installs the bundle to <configDir>/bin/cctl with mode 0755", async () => {
    await writeFile(bundlePath, stampedBundle(BUILD));

    const result = await installCctl({
      bundlePath,
      configDir,
      expectedBuildInfo: BUILD,
    });

    expect(result.installed).toBe(true);
    const target = path.join(configDir, "bin", "cctl");
    expect(await readFile(target, "utf-8")).toContain("console.log(1)");
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  it("is idempotent — re-running replaces the target and leaves no temp files", async () => {
    await writeFile(bundlePath, stampedBundle(BUILD, "v1"));
    await installCctl({ bundlePath, configDir, expectedBuildInfo: BUILD });
    await writeFile(bundlePath, stampedBundle(BUILD, "v2"));

    const result = await installCctl({
      bundlePath,
      configDir,
      expectedBuildInfo: BUILD,
    });

    expect(result.installed).toBe(true);
    const binDir = path.join(configDir, "bin");
    expect(await readFile(path.join(binDir, "cctl"), "utf-8")).toContain("v2");
    expect(await readdir(binDir)).toEqual(["cctl"]);
  });

  it("skips with bundle_missing when the bundle does not exist", async () => {
    const result = await installCctl({
      bundlePath,
      configDir,
      expectedBuildInfo: BUILD,
    });

    expect(result).toEqual({ installed: false, reason: "bundle_missing" });
    // No bin dir side effects.
    await expect(stat(path.join(configDir, "bin", "cctl"))).rejects.toThrow();
  });

  it("refuses to publish a bundle whose stamp differs from the server's", async () => {
    const stale: BuildInfo = {
      sha: "old0000",
      buildTime: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(bundlePath, stampedBundle(stale));

    const result = await installCctl({
      bundlePath,
      configDir,
      expectedBuildInfo: BUILD,
    });

    expect(result).toEqual({ installed: false, reason: "stamp_mismatch" });
    await expect(stat(path.join(configDir, "bin", "cctl"))).rejects.toThrow();
  });

  it("does not replace a previously published cctl with a stale bundle", async () => {
    await writeFile(bundlePath, stampedBundle(BUILD, "current"));
    await installCctl({ bundlePath, configDir, expectedBuildInfo: BUILD });

    const stale: BuildInfo = {
      sha: "old0000",
      buildTime: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(bundlePath, stampedBundle(stale, "stale"));
    const result = await installCctl({
      bundlePath,
      configDir,
      expectedBuildInfo: BUILD,
    });

    expect(result).toEqual({ installed: false, reason: "stamp_mismatch" });
    const target = path.join(configDir, "bin", "cctl");
    expect(await readFile(target, "utf-8")).toContain("current");
  });
});
