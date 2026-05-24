import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readRepoConfig } from "../projects/repo-config";
import type { DevServerConfig } from "./schemas";
import type { PerRepoConfig } from "../config/schemas";

// ============================================================
// Preset Definitions
// ============================================================

export interface DevServerPresetDefinition {
  id: string;
  name: string;
  description: string;
  badge: string;
  basePort: number;
  serverName: string;
  command: string;
  scriptFileName: string;
}

const PRESETS: DevServerPresetDefinition[] = [
  {
    id: "nextjs",
    name: "Next.js",
    description: "Dev server with automatic port detection and HMR support",
    badge: "N",
    basePort: 3000,
    serverName: "nextjs",
    command: ".cc/dev-servers/nextjs.sh",
    scriptFileName: "nextjs.sh",
  },
  {
    id: "storybook",
    name: "Storybook",
    description: "Component workshop with auto port allocation",
    badge: "S",
    basePort: 6006,
    serverName: "storybook",
    command: ".cc/dev-servers/storybook.sh",
    scriptFileName: "storybook.sh",
  },
];

// ============================================================
// Registry Functions
// ============================================================

export function getPresets(): DevServerPresetDefinition[] {
  return PRESETS;
}

export function getPreset(id: string): DevServerPresetDefinition | undefined {
  return PRESETS.find((p) => p.id === id);
}

/**
 * Scan hint for status-reconciliation port discovery. Returned only for known
 * presets — custom servers must wait until Phase 7's explicit config lands
 * before reconciliation can guess port ranges on their behalf.
 */
export interface DevServerScanHint {
  basePort: number;
  rangeSize: number;
}

const DEFAULT_SCAN_RANGE_SIZE = 100;

export function getPresetScanHint(
  serverName: string,
): DevServerScanHint | null {
  const preset = PRESETS.find((p) => p.serverName === serverName);
  if (!preset) return null;
  return { basePort: preset.basePort, rangeSize: DEFAULT_SCAN_RANGE_SIZE };
}

// ============================================================
// Script Generation
// ============================================================

export function generateHelperScript(): string {
  return `#!/bin/sh
# CC Dev Server Helpers — shared port detection and worktree ownership functions
# Installed by CC (Claude Code). Intended to be committed to the repo.

# Detect platform: "Darwin" = macOS, "Linux" = Linux
CC_OS="$(uname -s)"

# Get the PID listening on a TCP port. Prints PID or empty string.
# Args: $1 = port
get_pid_on_port() {
  local port="\$1"
  local pid=""

  if [ "\$CC_OS" = "Darwin" ]; then
    # macOS — lsof is the standard tool
    pid=$(lsof -ti tcp:"\$port" -sTCP:LISTEN 2>/dev/null | head -1)
  else
    # Linux — try ss first (grep -oP requires GNU grep), fallback to lsof
    if command -v ss >/dev/null 2>&1; then
      pid=$(ss -tlnp sport = :"\$port" 2>/dev/null | grep -oP 'pid=\\K[0-9]+' | head -1)
    fi
    if [ -z "\$pid" ] && command -v lsof >/dev/null 2>&1; then
      pid=$(lsof -ti tcp:"\$port" -sTCP:LISTEN 2>/dev/null | head -1)
    fi
  fi

  echo "\$pid"
}

# Resolve the working directory of a process.
# Args: $1 = pid
get_process_cwd() {
  local pid="\$1"

  if [ "\$CC_OS" = "Darwin" ]; then
    # macOS — use lsof to resolve process working directory
    lsof -a -p "\$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-
  else
    # Linux — use /proc filesystem
    if [ -d "/proc/\$pid" ]; then
      readlink "/proc/\$pid/cwd" 2>/dev/null
    fi
  fi
}

# Check if a port is available, owned by this worktree, or in conflict.
# Args: $1 = port, $2 = expected worktree path
# Exit codes: 0 = available, 1 = owned (same worktree), 2 = conflict
check_port() {
  local port="\$1"
  local expected_cwd="\$2"

  local pid
  pid=$(get_pid_on_port "\$port")

  # No process on this port — available
  if [ -z "\$pid" ]; then
    return 0
  fi

  # Process found — check if it belongs to our worktree
  local process_cwd
  process_cwd=$(get_process_cwd "\$pid")

  if [ -z "\$process_cwd" ]; then
    # Cannot determine cwd — treat as conflict
    return 2
  fi

  # Normalize paths (resolve symlinks)
  local norm_expected norm_actual
  norm_expected=$(cd "\$expected_cwd" 2>/dev/null && pwd -P)
  norm_actual=$(cd "\$process_cwd" 2>/dev/null && pwd -P)

  if [ "\$norm_expected" = "\$norm_actual" ]; then
    return 1
  fi

  return 2
}

# Scan the configured range (base port inclusive, then upward) for a port
# already owned by this worktree. Lets us adopt an externally started dev
# server before starting a duplicate on a different free port.
# Args: $1 = base port, $2 = expected worktree path
# Prints the owned port number on success.
# Exit codes: 0 = found owned port, 1 = no owned port in range
find_owned_port() {
  local base_port="\$1"
  local expected_cwd="\$2"
  local port="\$base_port"
  local attempts=100

  while [ "\$attempts" -gt 0 ]; do
    check_port "\$port" "\$expected_cwd"
    if [ \$? -eq 1 ]; then
      echo "\$port"
      return 0
    fi
    port=$((port + 1))
    attempts=$((attempts - 1))
  done

  return 1
}

# Scan from the base port (inclusive) upward for the first truly free port.
# Owned and conflicting ports are both skipped — adoption is handled
# separately by find_owned_port so callers should run that first.
# Args: $1 = base port, $2 = expected worktree path
# Prints the available port number on success.
# Exit codes: 0 = found available port, 2 = no available port in range
find_available_port() {
  local base_port="\$1"
  local expected_cwd="\$2"
  local port="\$base_port"
  local attempts=100

  while [ "\$attempts" -gt 0 ]; do
    check_port "\$port" "\$expected_cwd"
    if [ \$? -eq 0 ]; then
      echo "\$port"
      return 0
    fi
    port=$((port + 1))
    attempts=$((attempts - 1))
  done

  echo "ERROR: Could not find an available port after scanning from \$base_port" >&2
  return 2
}
`;
}

export function generatePresetScript(
  presetId: string,
  subdir?: string,
): string {
  const preset = getPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown preset: ${presetId}`);
  }

  const frameworkCommand =
    presetId === "nextjs"
      ? 'npx next dev --port "$PORT"'
      : 'npx storybook dev --port "$PORT"';

  // When subdir is provided, the script cd's into the subdirectory and uses
  // it for port ownership checks (the process cwd will be the subdir).
  const hasSubdir = !!subdir;
  const cwdVar = hasSubdir ? "APP_DIR" : "WORKTREE_DIR";

  const subdirBlock = hasSubdir
    ? `APP_DIR="$WORKTREE_DIR/${subdir}"

# Verify the subdirectory exists
if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: ${subdir}/ directory not found at $APP_DIR" >&2
  exit 1
fi

`
    : "";

  // Next.js uses .next/dev/lock to prevent concurrent instances. When CC kills
  // a dev server process group, the lock isn't cleaned up, causing subsequent
  // starts to fail. By the time we reach exec, port checks already confirmed
  // no server is running for this worktree, so any lock file is stale.
  const lockCleanup = presetId === "nextjs" ? 'rm -f ".next/dev/lock"\n' : "";

  const execLine = hasSubdir
    ? `cd "$APP_DIR" && ${lockCleanup}exec ${frameworkCommand}`
    : `${lockCleanup}exec ${frameworkCommand}`;

  const comment = hasSubdir
    ? `# CC Dev Server — ${preset.name} (subdir: ${subdir}/)`
    : `# CC Dev Server — ${preset.name}`;

  return `#!/bin/sh
${comment}
# Installed by CC (Claude Code). Intended to be committed to the repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_helpers.sh"

BASE_PORT=${preset.basePort}
WORKTREE_DIR="$(pwd)"
${subdirBlock}# Pass 1: adopt an externally started server anywhere in the scan range.
# Prevents launching a duplicate when an owned server already runs on a
# later port (e.g. base port free, but our server is on BASE+4).
ADOPT_PORT=$(find_owned_port "$BASE_PORT" "$${cwdVar}")
if [ $? -eq 0 ]; then
  echo "CC_PORT=$ADOPT_PORT"
  exit 0
fi

# Pass 2: no owned server — pick the lowest available port and start one.
PORT=$(find_available_port "$BASE_PORT" "$${cwdVar}")
if [ $? -ne 0 ]; then
  echo "ERROR: no available port for ${preset.name} starting at $BASE_PORT" >&2
  exit 1
fi

echo "CC_PORT=$PORT"
${execLine}
`;
}

// ============================================================
// Simplified Preset Config (cc-assigned strategy)
// ============================================================

const SIMPLIFIED_FRAMEWORK_COMMANDS: Record<string, string> = {
  nextjs: 'npx next dev --port "$CC_ASSIGNED_PORT"',
  storybook: 'npx storybook dev --port "$CC_ASSIGNED_PORT"',
};

const SIMPLIFIED_DEFAULT_RANGE = 100;
const SIMPLIFIED_DEFAULT_READINESS_TIMEOUT_MS = 60_000;

/**
 * Build a simplified cc-assigned dev server entry for a known preset. The
 * resulting config delegates port assignment, env injection, and readiness
 * waiting to CC instead of relying on a generated shell script.
 */
export function buildSimplifiedPresetEntry(
  presetId: string,
  subdir?: string,
): DevServerConfig {
  const preset = getPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown preset: ${presetId}`);
  }

  const command = SIMPLIFIED_FRAMEWORK_COMMANDS[presetId];
  if (!command) {
    throw new Error(`No simplified command template for preset: ${presetId}`);
  }

  const entry: DevServerConfig = {
    name: preset.serverName,
    command,
    port: {
      strategy: "cc-assigned",
      base: preset.basePort,
      range: SIMPLIFIED_DEFAULT_RANGE,
    },
    readiness: {
      type: "tcp",
      timeoutMs: SIMPLIFIED_DEFAULT_READINESS_TIMEOUT_MS,
    },
  };

  if (subdir) {
    entry.cwd = subdir;
  }

  return entry;
}

// ============================================================
// Preset Installation
// ============================================================

export interface InstallPresetResult {
  installedFiles: string[];
  configUpdated: boolean;
}

export async function installPreset(params: {
  projectPath: string;
  presetId: string;
  subdir?: string;
  legacy?: boolean;
}): Promise<InstallPresetResult> {
  const { projectPath, presetId, subdir, legacy = false } = params;

  const preset = getPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown preset: ${presetId}`);
  }

  const installed = await getInstalledPresets(projectPath);
  if (installed.includes(presetId)) {
    throw new Error(
      `Preset '${preset.name}' is already installed (server name '${preset.serverName}' exists in devServers)`,
    );
  }

  const installedFiles: string[] = [];
  let newEntry: DevServerConfig;

  if (legacy) {
    const scriptsDir = path.join(projectPath, ".cc", "dev-servers");
    await mkdir(scriptsDir, { recursive: true });

    const helpersPath = path.join(scriptsDir, "_helpers.sh");
    await writeFile(helpersPath, generateHelperScript(), { mode: 0o755 });
    installedFiles.push(".cc/dev-servers/_helpers.sh");

    const presetScriptPath = path.join(scriptsDir, preset.scriptFileName);
    await writeFile(presetScriptPath, generatePresetScript(presetId, subdir), {
      mode: 0o755,
    });
    installedFiles.push(`.cc/dev-servers/${preset.scriptFileName}`);

    newEntry = { name: preset.serverName, command: preset.command };
  } else {
    newEntry = buildSimplifiedPresetEntry(presetId, subdir);
  }

  const configPath = path.join(projectPath, "CommandCenter.json");
  let config: PerRepoConfig;
  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw) as PerRepoConfig;
  } catch {
    config = { initScriptPath: null };
  }

  const devServers = config.devServers ?? [];
  devServers.push(newEntry);
  config = { ...config, devServers };

  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  installedFiles.push("CommandCenter.json");

  return { installedFiles, configUpdated: true };
}

export async function getInstalledPresets(
  projectPath: string,
): Promise<string[]> {
  const repoConfig = await readRepoConfig(projectPath);
  if (!repoConfig?.devServers) return [];

  const configuredNames = new Set(repoConfig.devServers.map((s) => s.name));
  return PRESETS.filter((p) => configuredNames.has(p.serverName)).map(
    (p) => p.id,
  );
}
