import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { BuildInfo } from "@/lib/build-info";
import { createLogger } from "@/lib/logging";

const log = createLogger("agent-gateway");

export interface InstallCctlOptions {
  /** Built bundle to publish, normally <projectRoot>/dist/cctl/cctl.mjs. */
  bundlePath: string;
  configDir: string;
  /**
   * The running server's own build info. The bundle is published only when it
   * embeds the same stamp — the server-owns-the-binary invariant (doc 01 §3):
   * an agent session must never receive a cctl from a different build than
   * the server it talks to.
   */
  expectedBuildInfo: BuildInfo;
}

export type InstallCctlResult =
  | { installed: true; targetPath: string }
  | { installed: false; reason: "bundle_missing" | "stamp_mismatch" };

/**
 * Publish the server's own cctl bundle to <configDir>/bin/cctl (0755).
 * Atomic (temp write + rename) so an agent invoking cctl mid-install never
 * sees a torn file; idempotent so re-running register() is safe. A missing
 * or stamp-skewed bundle is never published — both `bun run build` and the
 * dev scripts regenerate build-info and rebuild the bundle before the server
 * starts, so either condition means the build pipeline is broken and is
 * logged as an error.
 */
export async function installCctl(
  options: InstallCctlOptions,
): Promise<InstallCctlResult> {
  const { bundlePath, configDir, expectedBuildInfo } = options;

  let contents: string;
  try {
    contents = await readFile(bundlePath, "utf-8");
  } catch {
    log.error("agent-gateway.cli_install_skipped", {
      bundlePath,
      reason: "bundle_missing",
    });
    return { installed: false, reason: "bundle_missing" };
  }

  // The generated build-info module serializes both fields into the bundle
  // source, so a same-build bundle always contains them verbatim.
  const stampMatches =
    contents.includes(expectedBuildInfo.sha) &&
    contents.includes(expectedBuildInfo.buildTime);
  if (!stampMatches) {
    log.error("agent-gateway.cli_install_skipped", {
      bundlePath,
      reason: "stamp_mismatch",
      expectedSha: expectedBuildInfo.sha,
      expectedBuildTime: expectedBuildInfo.buildTime,
    });
    return { installed: false, reason: "stamp_mismatch" };
  }

  const binDir = path.join(configDir, "bin");
  const targetPath = path.join(binDir, "cctl");
  const tempPath = path.join(binDir, `.cctl.tmp-${process.pid}`);

  await mkdir(binDir, { recursive: true });
  try {
    await writeFile(tempPath, contents, "utf-8");
    await chmod(tempPath, 0o755);
    await rename(tempPath, targetPath);
  } catch (err) {
    // Best-effort temp cleanup so a failed install can't strand temp files.
    await rm(tempPath, { force: true });
    throw err;
  }

  log.info("agent-gateway.cli_installed", { bundlePath, targetPath });
  return { installed: true, targetPath };
}
