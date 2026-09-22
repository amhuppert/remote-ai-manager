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
import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import type { BackendSkillCatalogFacet } from "@/lib/agent-backends/descriptor";
import type { CommandItem } from "@/lib/commands/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import { parseFrontmatter } from "./frontmatter";
export { parseFrontmatter } from "./frontmatter";
const logger = createLogger("commands");

export interface CommandDiscoveryOptions {
  capabilities?: ResolvedCapabilityCascade;
  resolveCapabilities?(): Promise<ResolvedCapabilityCascade>;
  conversationId?: string;
}

export interface CommandDiscoveryDependencies {
  getRuntime(
    conversationId: string,
  ):
    | Pick<
        ConversationBackendRuntime,
        "backend" | "status" | "getSkillCommands"
      >
    | undefined;
  getSkillCatalog(
    backend: AgentBackendId,
  ): BackendSkillCatalogFacet | undefined;
}

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

type CommandCandidate = CommandItem & { hidden?: boolean };

interface ScanSkillsOptions {
  userInvocableOnly?: boolean;
  pluginName?: string;
}

async function scanSkillsDir(
  dirPath: string,
  source: string,
  options: ScanSkillsOptions,
): Promise<CommandCandidate[]> {
  if (!existsSync(dirPath)) return [];

  const items: CommandCandidate[] = [];

  const walk = async (currentDir: string): Promise<void> => {
    const skillFile = path.join(currentDir, "SKILL.md");
    if (existsSync(skillFile)) {
      try {
        const content = await readFile(skillFile, "utf-8");
        const { fields, body } = parseFrontmatter(content);
        const skillId = path.basename(currentDir);
        const description =
          fields["description"] ??
          body
            .split("\n")
            .find((line) => line.trim().length > 0)
            ?.trim() ??
          "";
        const name = options.pluginName
          ? `/${options.pluginName}:${skillId}`
          : `/${skillId}`;

        items.push({
          name,
          description,
          argumentHint: fields["argument-hint"],
          type: "skill",
          source,
          hidden:
            options.userInvocableOnly && fields["user-invocable"] === "false",
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
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
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
              await walk(entryPath);
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

  await walk(dirPath);
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
): Promise<CommandCandidate[]> {
  const homeDir = os.homedir();
  const skills: CommandCandidate[] = [];
  const commands: CommandItem[] = [];

  const projectCmdDir = path.join(worktreePath, ".claude", "commands");
  commands.push(...(await scanCommandDir(projectCmdDir, "project")));

  // Claude resolves personal skills before project skills, and skills before
  // legacy commands. Hidden winners still reserve their names during dedup.
  const userSkillsDir = path.join(homeDir, ".claude", "skills");
  skills.push(
    ...(await scanSkillsDir(userSkillsDir, "user", {
      userInvocableOnly: true,
    })),
  );

  const userCmdDir = path.join(homeDir, ".claude", "commands");
  commands.push(...(await scanCommandDir(userCmdDir, "user")));

  const projectSkillsDir = path.join(worktreePath, ".claude", "skills");
  skills.push(
    ...(await scanSkillsDir(projectSkillsDir, "project", {
      userInvocableOnly: true,
    })),
  );

  const pluginPaths = await resolvePluginPaths();
  for (const plugin of pluginPaths) {
    const pluginCmdDir = path.join(plugin.path, "commands");
    commands.push(
      ...(await scanCommandDir(pluginCmdDir, plugin.name, plugin.name)),
    );

    const pluginSkillsDir = path.join(plugin.path, "skills");
    skills.push(
      ...(await scanSkillsDir(pluginSkillsDir, plugin.name, {
        userInvocableOnly: true,
        pluginName: plugin.name,
      })),
    );
  }

  return [...skills, ...commands];
}

/**
 * Discover the prompt autocomplete surface for the active backend. Each provider
 * owns its catalog source; a native catalog failure never falls back to a scan.
 */
export function createCommandDiscovery(
  dependencies: Partial<CommandDiscoveryDependencies> = {},
) {
  const deps: CommandDiscoveryDependencies = {
    getRuntime,
    getSkillCatalog: (backend) => getBackendDescriptor(backend).skillCatalog,
    ...dependencies,
  };
  const legacyDiscoverers: Partial<
    Record<
      AgentBackendId,
      (worktreePath: string) => Promise<CommandCandidate[]>
    >
  > = {
    claude: discoverClaudeItems,
    cursor: async (worktreePath) => {
      const catalog = await discoverCursorCatalog({
        worktreePath,
        home: os.homedir(),
        bundle: getPublishedManagedSkillBundle(),
      });
      return cursorSkillCommands(catalog.items);
    },
  };

  return async function discoverCommands(
    worktreePath: string,
    backend: AgentBackendId = "claude",
    options: CommandDiscoveryOptions = {},
  ): Promise<CommandItem[]> {
    return timed(
      logger,
      "commands.discover",
      { backend, worktreePath },
      async () => {
        const catalog = deps.getSkillCatalog(backend);
        let allItems: CommandCandidate[];
        if (catalog) {
          const capabilities = options.resolveCapabilities
            ? await options.resolveCapabilities()
            : options.capabilities;
          const runtime = options.conversationId
            ? deps.getRuntime(options.conversationId)
            : undefined;
          allItems =
            runtime?.backend === backend &&
            runtime.status === "alive" &&
            runtime.getSkillCommands
              ? await runtime.getSkillCommands(capabilities)
              : await catalog.getCommands({ worktreePath, capabilities });
        } else {
          const discoverLegacy = legacyDiscoverers[backend];
          if (!discoverLegacy) {
            throw new Error(`Backend "${backend}" has no skill catalog`);
          }
          allItems = await discoverLegacy(worktreePath);
        }

        const seen = new Set<string>();
        const deduplicated: CommandItem[] = [];
        for (const { hidden, ...item } of allItems) {
          const identity = JSON.stringify([item.name, item.skillPath]);
          if (!seen.has(identity)) {
            seen.add(identity);
            if (!hidden) deduplicated.push(item);
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
  };
}

export const discoverCommands = createCommandDiscovery();
