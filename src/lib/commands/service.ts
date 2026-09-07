import {
  discoverCursorCatalog,
  cursorSkillCommands,
} from "@/lib/agent-backends/cursor/capability-catalog";
import { getPublishedManagedSkillBundle } from "@/lib/managed-skills/service";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";
import { getErrorMessage } from "@/lib/shared/errors";
import { skillTriggerPrefixForBackend } from "@/lib/agent-backends/catalog";
import { discoverCodexPlugins } from "@/lib/agent-capabilities/codex-discovery";
import type { SkillTriggerPrefix } from "@/lib/agent-backends/descriptor";
import type { CommandItem } from "@/lib/commands/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { parseFrontmatter } from "./frontmatter";
export { parseFrontmatter, type FrontmatterResult } from "./frontmatter";
const logger = createLogger("commands");

// ============================================================
// Command Discovery
// ============================================================

/**
 * Scan a directory recursively for .md command files.
 * Subdirectories create namespace prefixes (e.g., review/security.md → /review:security).
 */
async function scanCommandDir(
  dirPath: string,
  source: string,
  namespace?: string,
): Promise<CommandItem[]> {
  if (!existsSync(dirPath)) return [];

  const items: CommandItem[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const subItems = await scanCommandDir(fullPath, source, entry.name);
        items.push(...subItems);
      } else if (entry.name.endsWith(".md")) {
        try {
          const content = await readFile(fullPath, "utf-8");
          const { fields, body } = parseFrontmatter(content);

          const baseName = entry.name.replace(/\.md$/, "");
          const commandName = namespace
            ? `/${namespace}:${baseName}`
            : `/${baseName}`;

          const description =
            fields["description"] ??
            body
              .split("\n")
              .find((line) => line.trim().length > 0)
              ?.trim() ??
            "";

          items.push({
            name: commandName,
            description,
            argumentHint: fields["argument-hint"],
            type: "command",
            source,
          });
        } catch (err) {
          logger.warn("commands.parse_error", {
            file: fullPath,
            error: getErrorMessage(err),
          });
        }
      }
    }
  } catch (err) {
    logger.warn("commands.scan_error", {
      dir: dirPath,
      error: getErrorMessage(err),
    });
  }

  return items;
}

interface ScanSkillsOptions {
  itemPrefix: SkillTriggerPrefix;
  pluginName?: string;
  namespace?: string;
  ignoreDirNames?: Set<string>;
}

async function scanSkillsDir(
  dirPath: string,
  source: string,
  options: ScanSkillsOptions,
): Promise<CommandItem[]> {
  if (!existsSync(dirPath)) return [];

  const items: CommandItem[] = [];

  const walk = async (
    currentDir: string,
    activeNamespace?: string,
    symlinkNamespaceCandidate?: string,
  ): Promise<void> => {
    const skillFile = path.join(currentDir, "SKILL.md");
    if (existsSync(skillFile)) {
      try {
        const content = await readFile(skillFile, "utf-8");
        const { fields, body } = parseFrontmatter(content);
        const skillId = path.basename(currentDir);
        const qualifiedSkillId = activeNamespace
          ? `${activeNamespace}:${skillId}`
          : skillId;
        const description =
          fields["description"] ??
          body
            .split("\n")
            .find((line) => line.trim().length > 0)
            ?.trim() ??
          "";
        const name =
          options.itemPrefix === "$"
            ? `$${qualifiedSkillId}`
            : options.pluginName
              ? `/${options.pluginName}:${skillId}`
              : `/${skillId}`;

        items.push({
          name,
          description,
          argumentHint: fields["argument-hint"],
          type: "skill",
          source,
        });
      } catch (err) {
        logger.warn("commands.skill_parse_error", {
          dir: currentDir,
          error: getErrorMessage(err),
        });
      }
      return;
    }

    try {
      // A symlink can be either one skill or a namespaced container of skills.
      // Promote its alias only after proving the symlink root has no SKILL.md;
      // this preserves flat linked skill names while matching Codex's
      // `container:skill` naming for roots such as `command-center`.
      const descendantNamespace =
        options.itemPrefix === "$"
          ? (symlinkNamespaceCandidate ?? activeNamespace)
          : undefined;
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (options.ignoreDirNames?.has(entry.name)) continue;
        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath, descendantNamespace);
          continue;
        }
        // Skills are commonly installed as symlinks (e.g. ~/.claude/skills/foo
        // → ~/.agents/skills/foo). Resolve symlinks so directory targets are
        // walked the same as real directories. Dirent.isDirectory() returns
        // false for symlinks even when they point to directories.
        if (entry.isSymbolicLink()) {
          try {
            const stats = await stat(entryPath);
            if (stats.isDirectory()) {
              await walk(entryPath, descendantNamespace, entry.name);
            }
          } catch (err) {
            logger.warn("commands.skills_symlink_error", {
              path: entryPath,
              error: getErrorMessage(err),
            });
          }
        }
      }
    } catch (err) {
      logger.warn("commands.skills_scan_error", {
        dir: currentDir,
        error: getErrorMessage(err),
      });
    }
  };

  await walk(dirPath, options.namespace);
  return items;
}

/**
 * Resolve enabled plugin paths from user settings and installed plugins cache.
 * @public Accessed via dynamic `import()` in actor-implementations.
 */
export async function resolvePluginPaths(): Promise<
  Array<{ name: string; path: string }>
> {
  const homeDir = os.homedir();
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  const installedPath = path.join(
    homeDir,
    ".claude",
    "plugins",
    "installed_plugins.json",
  );

  const plugins: Array<{ name: string; path: string }> = [];

  try {
    if (!existsSync(settingsPath)) return [];

    const settingsRaw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw) as {
      enabledPlugins?: Record<string, boolean> | string[];
    };

    let enabledPluginIds: string[] = [];
    if (settings.enabledPlugins) {
      if (Array.isArray(settings.enabledPlugins)) {
        enabledPluginIds = settings.enabledPlugins;
      } else if (typeof settings.enabledPlugins === "object") {
        enabledPluginIds = Object.entries(settings.enabledPlugins)
          .filter(([, enabled]) => enabled)
          .map(([id]) => id);
      }
    }

    if (enabledPluginIds.length === 0) {
      return [];
    }

    interface InstalledPluginsFile {
      version?: number;
      plugins?: Record<
        string,
        Array<{
          installPath?: string;
          cachePath?: string;
          version?: string;
          scope?: string;
        }>
      >;
    }

    let installedData: InstalledPluginsFile = {};
    if (existsSync(installedPath)) {
      try {
        const installedRaw = await readFile(installedPath, "utf-8");
        installedData = JSON.parse(installedRaw) as InstalledPluginsFile;
      } catch {
        // Installed file malformed — continue without it
      }
    }

    const installed = installedData.plugins ?? installedData;

    for (const pluginId of enabledPluginIds) {
      const pluginInstalls = installed[pluginId as keyof typeof installed];
      if (pluginInstalls && Array.isArray(pluginInstalls)) {
        const pluginInfo = pluginInstalls[0];
        const pluginPath = pluginInfo?.installPath ?? pluginInfo?.cachePath;
        if (pluginPath && existsSync(pluginPath)) {
          const pluginName = pluginId.split("@")[0] ?? pluginId;
          plugins.push({ name: pluginName, path: pluginPath });
        }
      }
    }
  } catch (err) {
    logger.warn("commands.plugin_resolution_error", {
      error: getErrorMessage(err),
    });
  }

  return plugins;
}

async function discoverClaudeItems(
  worktreePath: string,
  itemPrefix: SkillTriggerPrefix,
): Promise<CommandItem[]> {
  const homeDir = os.homedir();
  const allItems: CommandItem[] = [];

  const projectCmdDir = path.join(worktreePath, ".claude", "commands");
  allItems.push(...(await scanCommandDir(projectCmdDir, "project")));

  const projectSkillsDir = path.join(worktreePath, ".claude", "skills");
  allItems.push(
    ...(await scanSkillsDir(projectSkillsDir, "project", { itemPrefix })),
  );

  const userCmdDir = path.join(homeDir, ".claude", "commands");
  allItems.push(...(await scanCommandDir(userCmdDir, "user")));

  const userSkillsDir = path.join(homeDir, ".claude", "skills");
  allItems.push(
    ...(await scanSkillsDir(userSkillsDir, "user", { itemPrefix })),
  );

  const pluginPaths = await resolvePluginPaths();
  for (const plugin of pluginPaths) {
    const pluginCmdDir = path.join(plugin.path, "commands");
    allItems.push(
      ...(await scanCommandDir(pluginCmdDir, plugin.name, plugin.name)),
    );

    const pluginSkillsDir = path.join(plugin.path, "skills");
    allItems.push(
      ...(await scanSkillsDir(pluginSkillsDir, plugin.name, {
        itemPrefix,
        pluginName: plugin.name,
      })),
    );
  }

  return allItems;
}

async function discoverCodexItems(
  worktreePath: string,
  itemPrefix: SkillTriggerPrefix,
): Promise<CommandItem[]> {
  const homeDir = os.homedir();
  const allItems: CommandItem[] = [];

  allItems.push(
    ...(await scanSkillsDir(
      path.join(worktreePath, ".agents", "skills"),
      "project",
      {
        itemPrefix,
      },
    )),
  );
  allItems.push(
    ...(await scanSkillsDir(
      path.join(worktreePath, ".codex", "skills"),
      "project",
      {
        itemPrefix,
      },
    )),
  );
  allItems.push(
    ...(await scanSkillsDir(path.join(homeDir, ".agents", "skills"), "user", {
      itemPrefix,
    })),
  );
  allItems.push(
    ...(await scanSkillsDir(path.join(homeDir, ".codex", "skills"), "user", {
      itemPrefix,
      ignoreDirNames: new Set([".system"]),
    })),
  );
  allItems.push(
    ...(await scanSkillsDir(
      path.join(homeDir, ".codex", "skills", ".system"),
      "system",
      { itemPrefix },
    )),
  );

  const pluginResult = await discoverCodexPlugins({
    worktreePath,
    home: homeDir,
  });
  for (const plugin of pluginResult.items) {
    if (!plugin.enabled || !plugin.pluginPath) continue;
    const pluginName = codexPluginName(plugin.itemId);
    allItems.push(
      ...(await scanSkillsDir(
        path.join(plugin.pluginPath, "skills"),
        pluginName,
        {
          itemPrefix,
          pluginName,
          namespace: pluginName,
        },
      )),
    );
  }

  return allItems;
}

function codexPluginName(pluginId: string): string {
  const marketplaceSeparator = pluginId.lastIndexOf("@");
  return marketplaceSeparator > 0
    ? pluginId.slice(0, marketplaceSeparator)
    : pluginId;
}

/**
 * The discovery mechanism per backend — a TOTAL map, so registering a backend
 * forces a deliberate decision about where (or whether) its command surface is
 * scanned. It replaced a `codex ? … : claude` fallback whose else-branch quietly
 * pointed every other backend at Claude's `.claude/` directories (spec D14).
 *
 */
const DISCOVERERS: Record<
  AgentBackendId,
  (
    worktreePath: string,
    itemPrefix: SkillTriggerPrefix,
  ) => Promise<CommandItem[]>
> = {
  claude: discoverClaudeItems,
  codex: discoverCodexItems,
  cursor: async (worktreePath) => {
    const catalog = await discoverCursorCatalog({
      worktreePath,
      home: os.homedir(),
      bundle: getPublishedManagedSkillBundle(),
    });
    return cursorSkillCommands(catalog.items);
  },
};

/**
 * Discover the prompt autocomplete surface for the active backend.
 * Returns a deduplicated list with priority based on scan order.
 */
export async function discoverCommands(
  worktreePath: string,
  backend: AgentBackendId = "claude",
): Promise<CommandItem[]> {
  return timed(
    logger,
    "commands.discover",
    { backend, worktreePath },
    async () => {
      const itemPrefix = skillTriggerPrefixForBackend(backend);
      const allItems = await DISCOVERERS[backend](worktreePath, itemPrefix);

      const seen = new Set<string>();
      const deduplicated: CommandItem[] = [];
      for (const item of allItems) {
        if (!seen.has(item.name)) {
          seen.add(item.name);
          deduplicated.push(item);
        }
      }

      logger.info("commands.discovered", {
        backend,
        worktreePath,
        itemCount: deduplicated.length,
      });

      return deduplicated;
    },
    (result) => ({ itemCount: result.length }),
  );
}
