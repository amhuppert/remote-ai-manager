import path from "node:path";

/**
 * Pure config-dir resolution rule, shared by the server (loader.ts) and the
 * cctl bundle (src/cli/core.ts). Kept dependency-free — bundling it into the
 * CLI must not drag in the config loader, schemas, or logging.
 *
 * Priority:
 * 1. CC_CONFIG_DIR env var (explicit override)
 * 2. OS-appropriate default, with a "cc-dev" suffix when CC_ENV=dev to
 *    isolate dev-server state from production.
 */

export interface ConfigDirHost {
  platform: string;
  homedir: string;
}

export function resolveConfigDirFrom(
  env: Record<string, string | undefined>,
  host: ConfigDirHost,
): string {
  const override = env["CC_CONFIG_DIR"];
  if (override) {
    return override;
  }

  const dirName = env["CC_ENV"] === "dev" ? "cc-dev" : "cc";

  if (host.platform === "darwin") {
    return path.join(host.homedir, "Library", "Application Support", dirName);
  }
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg) {
    return path.join(xdg, dirName);
  }
  return path.join(host.homedir, ".config", dirName);
}
