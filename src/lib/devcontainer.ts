import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { getConfigDirPath } from "./config";
import { createLogger } from "./logging";

const logger = createLogger("devcontainer");
const execFileAsync = promisify(execFile);

// ============================================================
// Types
// ============================================================

export interface ContainerInfo {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

export interface ContainerConfig {
  /** Path to devcontainer.json being used (project or default) */
  configPath: string;
  /** Whether this is the CSM default config */
  isDefault: boolean;
}

export interface PrerequisiteCheckResult {
  dockerAvailable: boolean;
  dockerPermissions: boolean;
  devcontainerCliAvailable: boolean;
  errors: string[];
}

export interface ReconcileAction {
  sessionName: string;
  action: "restarted" | "marked-unhealthy";
}

// ============================================================
// Constants
// ============================================================

/** Path to the bundled default devcontainer config */
const DEFAULTS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "devcontainer-defaults",
);

// ============================================================
// Prerequisite Checks (Task 3.1)
// ============================================================

/**
 * Verify Docker daemon, Docker user permissions, and devcontainer CLI are available.
 * Returns structured results with specific error messages and setup guidance.
 */
export async function checkPrerequisites(): Promise<PrerequisiteCheckResult> {
  const result: PrerequisiteCheckResult = {
    dockerAvailable: false,
    dockerPermissions: false,
    devcontainerCliAvailable: false,
    errors: [],
  };

  // Check Docker daemon
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    result.dockerAvailable = true;
    result.dockerPermissions = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("permission denied") ||
      message.includes("Got permission denied")
    ) {
      result.dockerAvailable = true;
      result.dockerPermissions = false;
      result.errors.push(
        "Docker permission denied. Add your user to the docker group: sudo usermod -aG docker $USER && newgrp docker",
      );
    } else if (
      message.includes("Cannot connect") ||
      message.includes("Is the docker daemon running")
    ) {
      result.errors.push(
        "Docker daemon is not running. Start it with: sudo systemctl start docker",
      );
    } else {
      result.errors.push(
        `Docker is not available. Install Docker: https://docs.docker.com/engine/install/ (${message})`,
      );
    }
  }

  // Check devcontainer CLI
  try {
    await execFileAsync("devcontainer", ["--version"], { timeout: 10_000 });
    result.devcontainerCliAvailable = true;
  } catch {
    result.errors.push(
      "devcontainer CLI is not installed. Install it with: npm install -g @devcontainers/cli",
    );
  }

  return result;
}

// ============================================================
// Config Resolution (Task 3.1)
// ============================================================

/**
 * Resolve which devcontainer.json to use for a project.
 * Checks for project-level `.devcontainer/devcontainer.json` first,
 * falls back to CSM's bundled default.
 */
export function resolveConfig(projectPath: string): ContainerConfig {
  const projectConfig = path.join(
    projectPath,
    ".devcontainer",
    "devcontainer.json",
  );

  if (existsSync(projectConfig)) {
    logger.info("devcontainer.config_resolved", {
      projectPath,
      configPath: projectConfig,
      isDefault: false,
    });
    return { configPath: projectConfig, isDefault: false };
  }

  const defaultConfig = path.join(DEFAULTS_DIR, "devcontainer.json");
  logger.info("devcontainer.config_resolved", {
    projectPath,
    configPath: defaultConfig,
    isDefault: true,
  });
  return { configPath: defaultConfig, isDefault: true };
}

// ============================================================
// Session Environment Preparation (Task 3.2)
// ============================================================

/**
 * Get the per-session host directory for .claude/ bind-mount.
 * Located under CSM's config/data directory.
 */
function getSessionClaudeDir(sessionName: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(sessionName)
    .digest("hex")
    .slice(0, 12);
  return path.join(
    getConfigDirPath(),
    "containers",
    `${sanitizeForDocker(sessionName)}-${hash}`,
  );
}

/**
 * Sanitize a session name for use in Docker container names and directory names.
 */
function sanitizeForDocker(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Generate a container name from a session name.
 * Pattern: csm-<sanitized-session>-<short-hash>
 */
export function containerName(sessionName: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(sessionName)
    .digest("hex")
    .slice(0, 8);
  return `csm-${sanitizeForDocker(sessionName)}-${hash}`;
}

/**
 * Prepare the per-session .claude/ host directory with hook configuration.
 *
 * Creates:
 * - Host directory for .claude/ bind-mount
 * - Hook script that uses host.docker.internal for CSM connectivity
 * - settings.json with UserPromptSubmit and Stop hook configurations
 *
 * Returns the host .claude/ directory path.
 */
export async function prepareSessionEnvironment(
  sessionName: string,
  projectPath: string,
  csmPort: number,
): Promise<string> {
  const claudeDir = getSessionClaudeDir(sessionName);
  await mkdir(claudeDir, { recursive: true });

  // Generate hook script
  const hookScript = generateHookScript(csmPort);
  const hookScriptPath = path.join(claudeDir, "csm-hook.sh");
  await writeFile(hookScriptPath, hookScript, { mode: 0o755 });

  // Generate settings.json with hook configurations
  const settings = generateClaudeSettings();
  const settingsPath = path.join(claudeDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));

  // Write onboarding.json (mounted to /home/node/.claude.json in container).
  // Required for Claude Code to accept OAuth credentials without interactive onboarding.
  const onboardingPath = path.join(claudeDir, "onboarding.json");
  await writeFile(
    onboardingPath,
    JSON.stringify({ hasCompletedOnboarding: true }, null, 2),
  );

  logger.info("devcontainer.environment_prepared", {
    sessionName,
    claudeDir,
    projectPath,
  });

  return claudeDir;
}

/**
 * Generate the hook script that runs inside the container.
 * Uses host.docker.internal to reach CSM on the host.
 * Injects session identity (CSM_PROJECT_PATH, CSM_SESSION_NAME) via jq.
 */
function generateHookScript(csmPort: number): string {
  return `#!/usr/bin/env bash
# CSM Hook Script - Auto-generated, do not edit
# Forwards Claude Code lifecycle events to CSM via host.docker.internal

# Read stdin (hook event JSON from Claude Code)
input=$(cat)

# Inject session identity fields and POST to CSM
echo "$input" | jq --arg project "$CSM_PROJECT_PATH" --arg session "$CSM_SESSION_NAME" \\
  '. + {csm_project_path: $project, csm_session_name: $session}' \\
  | curl -s -X POST "http://host.docker.internal:${csmPort}/api/hooks" \\
  -H "Content-Type: application/json" -d @- > /dev/null 2>&1 &
`;
}

/**
 * Generate Claude settings.json with hook configurations for
 * UserPromptSubmit and Stop events.
 */
function generateClaudeSettings(): Record<string, unknown> {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: "/home/node/.claude/csm-hook.sh",
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "/home/node/.claude/csm-hook.sh",
            },
          ],
        },
      ],
    },
  };
}

/**
 * Build the environment variables to pass into the container.
 *
 * Supports three authentication methods (checked in order):
 * 1. ANTHROPIC_API_KEY env var — direct Anthropic API billing
 * 2. CLAUDE_CODE_OAUTH_TOKEN env var — OAuth token injection
 * 3. ~/.claude/.credentials.json — Claude Max/Pro credentials (copied by prepareSessionEnvironment)
 *
 * Throws if none of the three are available.
 */
export function buildContainerEnv(
  projectPath: string,
  sessionName: string,
): Record<string, string> {
  const env: Record<string, string> = {
    CSM_PROJECT_PATH: projectPath,
    CSM_SESSION_NAME: sessionName,
    DEVCONTAINER: "true",
  };

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
  }

  const oauthToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }

  // If no env-var auth is set, the container relies on .credentials.json
  // copied into the session's .claude/ directory by prepareSessionEnvironment.
  if (!apiKey && !oauthToken) {
    const hostCredentials = path.join(
      os.homedir(),
      ".claude",
      ".credentials.json",
    );
    if (!existsSync(hostCredentials)) {
      throw new Error(
        "No authentication method available for container sessions. " +
          "Set ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or sign in with " +
          "Claude Max (credentials at ~/.claude/.credentials.json).",
      );
    }
  }

  return env;
}

// ============================================================
// Container Start (Task 3.3)
// ============================================================

/**
 * Build and start a container for a session using `devcontainer up`.
 *
 * Uses --workspace-folder pointing to the host worktree.
 * For CSM default config, uses --config flag.
 * Parses JSON output to capture containerId, remoteUser, remoteWorkspaceFolder.
 */
export async function startContainer(
  worktreePath: string,
  claudeDir: string,
  envVars: Record<string, string>,
  config: ContainerConfig,
): Promise<ContainerInfo> {
  const args = ["up", "--workspace-folder", worktreePath];

  // For CSM default config, use --config flag to avoid copying into worktree
  if (config.isDefault) {
    args.push("--config", config.configPath);
  }

  // Build additional mounts for .claude/ directory and onboarding config
  const claudeMount = `type=bind,source=${claudeDir},target=/home/node/.claude`;
  args.push("--mount", claudeMount);

  // Mount onboarding.json as ~/.claude.json so Claude Code skips interactive onboarding.
  // Required for OAuth credential-based auth to work non-interactively.
  const onboardingMount = `type=bind,source=${path.join(claudeDir, "onboarding.json")},target=/home/node/.claude.json`;
  args.push("--mount", onboardingMount);

  // Bind-mount the host's credentials file (read-only) for Claude Max/Pro OAuth.
  // This way all containers share the live host credentials — token refreshes
  // on the host are immediately visible without stale copies.
  const hostCredentials = path.join(
    os.homedir(),
    ".claude",
    ".credentials.json",
  );
  if (existsSync(hostCredentials)) {
    const credentialsMount = `type=bind,source=${hostCredentials},target=/home/node/.claude/.credentials.json`;
    args.push("--mount", credentialsMount);
  }

  // Pass environment variables
  for (const [key, value] of Object.entries(envVars)) {
    args.push("--remote-env", `${key}=${value}`);
  }

  logger.info("devcontainer.starting", {
    worktreePath,
    configPath: config.configPath,
    isDefault: config.isDefault,
  });

  const startTime = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync("devcontainer", args, {
      timeout: 600_000, // 10 minutes for build + start
    });

    if (stderr) {
      logger.debug("devcontainer.up_stderr", { stderr: stderr.slice(0, 2000) });
    }

    // Parse JSON output from devcontainer up
    const output = parseDevcontainerUpOutput(stdout);

    const durationMs = Date.now() - startTime;
    logger.info("devcontainer.started", {
      containerId: output.containerId,
      remoteUser: output.remoteUser,
      durationMs,
    });

    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("devcontainer.start_failed", {
      worktreePath,
      error: message,
    });
    throw new Error(`Failed to start container: ${message}`);
  }
}

/**
 * Parse the JSON output from `devcontainer up`.
 * The output contains { outcome, containerId, remoteUser, remoteWorkspaceFolder }.
 */
function parseDevcontainerUpOutput(stdout: string): ContainerInfo {
  // devcontainer up outputs JSON, possibly after some log lines
  // Find the last JSON object in the output
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith("{")) {
      try {
        const parsed = JSON.parse(line) as {
          outcome?: string;
          containerId?: string;
          remoteUser?: string;
          remoteWorkspaceFolder?: string;
        };

        if (parsed.outcome === "error") {
          throw new Error(`devcontainer up failed: ${JSON.stringify(parsed)}`);
        }

        if (!parsed.containerId) {
          throw new Error("devcontainer up output missing containerId");
        }

        return {
          containerId: parsed.containerId,
          remoteUser: parsed.remoteUser ?? "node",
          remoteWorkspaceFolder: parsed.remoteWorkspaceFolder ?? "/workspace",
        };
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError) continue;
        throw parseErr;
      }
    }
  }

  throw new Error(
    `Failed to parse devcontainer up output: ${stdout.slice(0, 500)}`,
  );
}

// ============================================================
// Container Exec (Task 3.3)
// ============================================================

/**
 * Execute a command inside a running container via `devcontainer exec`.
 * Returns a ChildProcess with piped stdio, compatible with existing
 * readline-based NDJSON parsing.
 *
 * @param projectPath - The project root (used to resolve devcontainer config)
 * @param worktreePath - The worktree path mounted in the container
 * @param command - Command and arguments to run inside the container
 * @param env - Environment variables to pass via --remote-env
 */
export function execInContainer(
  projectPath: string,
  worktreePath: string,
  command: string[],
  env: Record<string, string>,
): ChildProcess {
  const config = resolveConfig(projectPath);
  const args = ["exec", "--workspace-folder", worktreePath];

  // For CSM default config, pass --config so devcontainer CLI can find it
  if (config.isDefault) {
    args.push("--config", config.configPath);
  }

  // Pass environment variables
  for (const [key, value] of Object.entries(env)) {
    args.push("--remote-env", `${key}=${value}`);
  }

  // Append the actual command
  args.push(...command);

  logger.info("devcontainer.exec", {
    worktreePath,
    command: command.join(" "),
  });

  return spawn("devcontainer", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ============================================================
// Container Cleanup (Task 3.4)
// ============================================================

/**
 * Stop and remove a container by ID.
 * Uses Docker CLI directly (more reliable than devcontainer down).
 * Handles cases where container is already stopped or doesn't exist.
 */
export async function stopAndRemoveContainer(
  containerId: string,
): Promise<void> {
  logger.info("devcontainer.stopping", { containerId });

  // Stop the container (ignore errors if already stopped)
  try {
    await execFileAsync("docker", ["stop", containerId], {
      timeout: 30_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("No such container") && !msg.includes("is not running")) {
      logger.warn("devcontainer.stop_warning", {
        containerId,
        error: msg,
      });
    }
  }

  // Remove the container (ignore errors if already removed)
  try {
    await execFileAsync("docker", ["rm", "-f", containerId], {
      timeout: 15_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("No such container")) {
      logger.warn("devcontainer.remove_warning", {
        containerId,
        error: msg,
      });
    }
  }

  logger.info("devcontainer.removed", { containerId });
}

/**
 * Get recent logs from a container.
 */
export async function getContainerLogs(
  containerId: string,
  tail: number = 100,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["logs", "--tail", String(tail), containerId],
      { timeout: 10_000 },
    );
    // docker logs outputs stdout and stderr separately
    return stdout + stderr;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to get container logs: ${msg}`);
  }
}

/**
 * Check if a container is currently running.
 */
export async function isContainerRunning(
  containerId: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", containerId],
      { timeout: 10_000 },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Reconcile sessions with stale or missing containers.
 * Checks each session's container ID against actual Docker state.
 */
export async function reconcileContainers(
  sessions: Array<{ containerId: string | null; sessionName: string }>,
): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];

  for (const session of sessions) {
    if (!session.containerId) continue;

    const running = await isContainerRunning(session.containerId);

    if (!running) {
      logger.warn("devcontainer.stale_container", {
        sessionName: session.sessionName,
        containerId: session.containerId,
      });

      // Mark as unhealthy — we can't restart without the full context
      actions.push({
        sessionName: session.sessionName,
        action: "marked-unhealthy",
      });
    }
  }

  if (actions.length > 0) {
    logger.info("devcontainer.reconciliation_complete", {
      totalChecked: sessions.filter((s) => s.containerId).length,
      actions,
    });
  }

  return actions;
}
