/**
 * Claude delivery of the Command Center managed skill bundle.
 *
 * The published bundle attaches to every normal launch as an SDK-local
 * plugin. A user-installed copy of the same plugin (marketplace install)
 * needs deterministic precedence: an installed copy that is
 * version-equivalent to the bundle makes the attachment redundant, and any
 * other enabled copy is suppressed for the session through the flag-layer
 * `enabledPlugins` delta — the running server controls the skill version its
 * agents see, and user configuration files are never written.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { getPublishedManagedSkillBundle } from "@/lib/managed-skills/service";
import type { ManagedSkillBundle } from "@/lib/managed-skills/schemas";

import { readClaudePluginNativeRecords } from "./runtime-config/plugin-native-records";
import type { ClaudePluginNativeRecord } from "./runtime-config/plugin-translator";

const logger = createLogger("claude:managed-skills");

/** The bundle's plugin name; installed ids are `<name>@<marketplace>`. */
const MANAGED_PLUGIN_NAME = "command-center";

export interface ClaudeManagedSkillsAttachment {
  plugins: Array<{ type: "local"; path: string; skipMcpDiscovery: true }>;
  /**
   * Flag-layer `Settings.enabledPlugins` delta suppressing non-equivalent
   * user copies for this session only. Never persisted.
   */
  enabledPluginsOverride: Record<string, boolean>;
}

export interface ClaudeManagedSkillsDeps {
  readNativeRecords(): Promise<readonly ClaudePluginNativeRecord[]>;
  /** Version of the user-installed plugin, or null when undeterminable. */
  readInstalledPluginVersion(pluginId: string): Promise<string | null>;
}

const EMPTY_ATTACHMENT: ClaudeManagedSkillsAttachment = {
  plugins: [],
  enabledPluginsOverride: {},
};

export async function resolveClaudeManagedSkillsAttachment(
  bundle: ManagedSkillBundle | null,
  deps: ClaudeManagedSkillsDeps,
): Promise<ClaudeManagedSkillsAttachment> {
  if (!bundle) return EMPTY_ATTACHMENT;

  const attachment: ClaudeManagedSkillsAttachment = {
    plugins: [{ type: "local", path: bundle.root, skipMcpDiscovery: true }],
    enabledPluginsOverride: {},
  };

  let records: readonly ClaudePluginNativeRecord[];
  try {
    records = await deps.readNativeRecords();
  } catch (err) {
    // Unknown native state: attach authoritatively but do not emit blind
    // suppression entries for ids we cannot enumerate.
    logger.warn("claude_managed_skills.native_records_unreadable", {
      error: getErrorMessage(err),
    });
    return attachment;
  }

  const enabledCopies = records.filter(
    (record) =>
      record.nativeEnabled &&
      record.pluginId.startsWith(`${MANAGED_PLUGIN_NAME}@`),
  );
  if (enabledCopies.length === 0) return attachment;

  const versions = await Promise.all(
    enabledCopies.map((record) =>
      deps.readInstalledPluginVersion(record.pluginId),
    ),
  );
  const allEquivalent = versions.every((version) => version === bundle.version);
  if (allEquivalent) {
    // The user's installed copies already provide exactly this content;
    // attaching would load the same plugin twice.
    logger.info("claude_managed_skills.native_copy_equivalent", {
      bundleVersion: bundle.version,
      pluginIds: enabledCopies.map((record) => record.pluginId),
    });
    return EMPTY_ATTACHMENT;
  }

  for (const record of enabledCopies) {
    attachment.enabledPluginsOverride[record.pluginId] = false;
  }
  logger.info("claude_managed_skills.native_copy_suppressed", {
    bundleVersion: bundle.version,
    suppressedPluginIds: Object.keys(attachment.enabledPluginsOverride),
  });
  return attachment;
}

// ---------------------------------------------------------------------------
// Production deps + launch entrypoint
// ---------------------------------------------------------------------------

interface InstalledPluginsFile {
  plugins?: Record<string, Array<{ installPath?: string; cachePath?: string }>>;
}

async function readInstalledPluginVersionFromDisk(
  pluginId: string,
): Promise<string | null> {
  try {
    const installedPath = path.join(
      os.homedir(),
      ".claude",
      "plugins",
      "installed_plugins.json",
    );
    const parsed = JSON.parse(
      await fs.readFile(installedPath, "utf-8"),
    ) as InstalledPluginsFile;
    const entries = parsed.plugins?.[pluginId] ?? [];
    for (const entry of entries) {
      const root = entry.installPath ?? entry.cachePath;
      if (!root) continue;
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(root, ".claude-plugin", "plugin.json"),
          "utf-8",
        ),
      ) as { version?: unknown };
      if (typeof manifest.version === "string") return manifest.version;
    }
    return null;
  } catch {
    return null;
  }
}

const productionDeps: ClaudeManagedSkillsDeps = {
  readNativeRecords: () => readClaudePluginNativeRecords(),
  readInstalledPluginVersion: readInstalledPluginVersionFromDisk,
};

/**
 * Launch-path entrypoint used by the conversation runtime and task runner.
 * Reads the startup-published bundle; without one (startup publish failed,
 * or a test process) it resolves to an empty attachment and the launch
 * proceeds without managed skills.
 */
export async function resolveClaudeManagedSkillsForLaunch(): Promise<ClaudeManagedSkillsAttachment> {
  const bundle = getPublishedManagedSkillBundle();
  if (!bundle) return EMPTY_ATTACHMENT;
  try {
    return await resolveClaudeManagedSkillsAttachment(bundle, productionDeps);
  } catch (err) {
    logger.error("claude_managed_skills.resolve_failed", {
      error: getErrorMessage(err),
    });
    return EMPTY_ATTACHMENT;
  }
}
