import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLogger } from "@/lib/logging";
import type { CommandItem } from "@/types";

const logger = createLogger("commands");

// ============================================================
// Frontmatter Parser
// ============================================================

export interface FrontmatterResult {
  fields: Record<string, string>;
  body: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Extracts key: value pairs between --- delimiters at the start.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  if (!content.startsWith("---")) {
    return { fields: {}, body: content };
  }

  // Find the closing --- delimiter (must be on its own line)
  const closingIdx = content.indexOf("\n---", 3);
  if (closingIdx === -1) {
    return { fields: {}, body: content };
  }

  const frontmatterBlock = content.slice(4, closingIdx); // skip "---\n"
  const body = content.slice(closingIdx + 4).trimStart(); // skip "\n---"

  const fields: Record<string, string> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      fields[key] = value;
    }
  }

  return { fields, body };
}

// ============================================================
// Command Discovery
// ============================================================

/**
 * Scan a directory recursively for .md command files.
 * Subdirectories create namespace prefixes (e.g., kiro/spec-init.md → /kiro:spec-init).
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
        // Recurse into subdirectories with namespace prefix
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
              .find((l) => l.trim().length > 0)
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
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } catch (err) {
    logger.warn("commands.scan_error", {
      dir: dirPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return items;
}

/**
 * Scan a skills directory — each subdirectory is a skill.
 * The skill name is the directory name, prefixed with /.
 */
async function scanSkillsDir(
  dirPath: string,
  source: string,
): Promise<CommandItem[]> {
  if (!existsSync(dirPath)) return [];

  const items: CommandItem[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(dirPath, entry.name);
      // Look for SKILL.md or any .md file in the skill directory
      const skillFile = path.join(skillDir, "SKILL.md");

      let description = "";
      let argumentHint: string | undefined;

      if (existsSync(skillFile)) {
        try {
          const content = await readFile(skillFile, "utf-8");
          const { fields, body } = parseFrontmatter(content);
          description =
            fields["description"] ??
            body
              .split("\n")
              .find((l) => l.trim().length > 0)
              ?.trim() ??
            "";
          argumentHint = fields["argument-hint"];
        } catch {
          // Use empty description
        }
      }

      items.push({
        name: `/${entry.name}`,
        description,
        argumentHint,
        type: "skill",
        source,
      });
    }
  } catch (err) {
    logger.warn("commands.skills_scan_error", {
      dir: dirPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return items;
}

/**
 * Resolve enabled plugin paths from user settings and installed plugins cache.
 */
async function resolvePluginPaths(): Promise<
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
      enabledPlugins?: string[];
    };

    if (
      !settings.enabledPlugins ||
      !Array.isArray(settings.enabledPlugins) ||
      settings.enabledPlugins.length === 0
    ) {
      return [];
    }

    // Read installed plugins for cache path resolution
    let installed: Record<
      string,
      { cachePath?: string; marketplace?: string; version?: string }
    > = {};
    if (existsSync(installedPath)) {
      try {
        const installedRaw = await readFile(installedPath, "utf-8");
        installed = JSON.parse(installedRaw) as typeof installed;
      } catch {
        // Installed file malformed — continue without it
      }
    }

    for (const pluginId of settings.enabledPlugins) {
      const pluginInfo = installed[pluginId];
      if (pluginInfo?.cachePath && existsSync(pluginInfo.cachePath)) {
        const pluginName =
          pluginId.split("/").pop()?.replace(/^@/, "") ?? pluginId;
        plugins.push({ name: pluginName, path: pluginInfo.cachePath });
      }
    }
  } catch (err) {
    logger.warn("commands.plugin_resolution_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return plugins;
}

/**
 * Discover all available commands and skills from project, user, plugin, and built-in sources.
 * Returns a deduplicated list with priority: project > user > plugin > built-in.
 */
export async function discoverCommands(
  worktreePath: string,
): Promise<CommandItem[]> {
  const homeDir = os.homedir();
  const allItems: CommandItem[] = [];

  // 1. Project-level commands
  const projectCmdDir = path.join(worktreePath, ".claude", "commands");
  const projectItems = await scanCommandDir(projectCmdDir, "project");
  allItems.push(...projectItems);

  // 2. User-level commands
  const userCmdDir = path.join(homeDir, ".claude", "commands");
  const userCmdItems = await scanCommandDir(userCmdDir, "user");
  allItems.push(...userCmdItems);

  // 3. User-level skills
  const userSkillsDir = path.join(homeDir, ".claude", "skills");
  const userSkillItems = await scanSkillsDir(userSkillsDir, "user");
  allItems.push(...userSkillItems);

  // 4. Plugin commands and skills
  const pluginPaths = await resolvePluginPaths();
  for (const plugin of pluginPaths) {
    const pluginCmdDir = path.join(plugin.path, "commands");
    const pluginCmdItems = await scanCommandDir(pluginCmdDir, plugin.name);
    allItems.push(...pluginCmdItems);

    const pluginSkillsDir = path.join(plugin.path, "skills");
    const pluginSkillItems = await scanSkillsDir(pluginSkillsDir, plugin.name);
    allItems.push(...pluginSkillItems);
  }

  // Deduplicate: first occurrence wins (project > user > plugin)
  const seen = new Set<string>();
  const deduplicated: CommandItem[] = [];
  for (const item of allItems) {
    if (!seen.has(item.name)) {
      seen.add(item.name);
      deduplicated.push(item);
    }
  }

  return deduplicated;
}
