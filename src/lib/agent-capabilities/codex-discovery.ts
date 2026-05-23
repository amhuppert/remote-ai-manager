/**
 * Codex capability discovery primitives.
 *
 * Implements the design's authoritative skill discovery sources for Codex and
 * the Codex plugin discovery sources documented by `openai/codex`:
 *   - `~/.codex/config.toml` `[plugins."NAME"]` tables
 *   - `~/.codex/marketplaces/<marketplace>/<plugin-path>/.codex-plugin/plugin.json`
 *     manifests
 *
 * Each entry-point accepts injected `readDir`/`readFile` seams so tests can
 * exercise diagnostics paths without root-only filesystem corruption.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  readdir as fsReaddir,
  readFile as fsReadFile,
  stat as fsStat,
} from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/errors";

import { parseFrontmatter } from "@/lib/commands";

import { redactAgentCapabilityText } from "./redaction";

import type {
  AgentCapabilityDiagnostic,
  AgentCapabilityDiscoveredItem,
  AgentCapabilityDiscoverySupport,
  AgentCapabilitySourceRef,
} from "@/lib/schemas";

const logger = createLogger("agent-capabilities.codex-discovery");

export interface CodexSkillSource {
  /** Cascade-layer this source contributes to. */
  layer: "project" | "user" | "system";
  /** Path joined onto either the worktree (`project`) or home (`user`,
   * `system`) to produce an absolute skills directory. */
  relative: string;
  /** Source label retained on discovered items so the UI can render it. */
  source: "project" | "user" | "system";
}

export const CODEX_SKILL_DISCOVERY_PATHS: readonly CodexSkillSource[] = [
  { layer: "project", relative: ".agents/skills", source: "project" },
  { layer: "project", relative: ".codex/skills", source: "project" },
  { layer: "user", relative: ".agents/skills", source: "user" },
  { layer: "user", relative: ".codex/skills", source: "user" },
  { layer: "system", relative: ".codex/skills/.system", source: "system" },
];

interface CodexDiscoveredSkill {
  itemId: string;
  source: "project" | "user" | "system";
  sourcePath: string;
  description: string;
  argumentHint?: string;
  /** Set when this skill was discovered under a marketplace plugin directory
   * (`~/.codex/marketplaces/<marketplace>/<plugin-path>/skills/...`). The id
   * matches the owning plugin's `itemId` from `discoverCodexPlugins`. */
  owningPluginId?: string;
}

interface CodexDiscoveryDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  sourcePath?: string;
  source?: "project" | "user" | "system";
}

export interface CodexSkillDiscoveryResult {
  items: readonly CodexDiscoveredSkill[];
  diagnostics: readonly CodexDiscoveryDiagnostic[];
  sourceSignature: string;
}

interface CodexDiscoveredPlugin {
  /** Plugin id — bare name (e.g. `oh-my-codex`) for config-only plugins, or
   * `<name>@<marketplace>` for marketplace-sourced plugins. */
  itemId: string;
  displayName: string;
  description?: string;
  version?: string;
  enabled: boolean;
  /** Absolute path to the manifest file when discovered via a marketplace.
   * Omitted for config-only plugins (no native manifest exists). */
  sourcePath?: string;
  /** Absolute path to the plugin's root directory (parent of `.codex-plugin`).
   * Used by skill discovery to attribute plugin-bundled skills. */
  pluginPath?: string;
  /** Marketplace directory name when sourced from a marketplace. */
  marketplaceName?: string;
}

export interface CodexPluginDiscoveryResult {
  items: readonly CodexDiscoveredPlugin[];
  diagnostics: readonly CodexDiscoveryDiagnostic[];
  sourceSignature: string;
  discoverySupport: AgentCapabilityDiscoverySupport;
}

interface CodexDiscoveryDeps {
  readDir(
    dir: string,
  ): Promise<readonly { name: string; isDirectory: boolean }[]>;
  readFile(file: string): Promise<string>;
}

const defaultDeps: CodexDiscoveryDeps = {
  async readDir(dir) {
    const entries = await fsReaddir(dir, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  },
  async readFile(file) {
    return fsReadFile(file, "utf-8");
  },
};

export interface CodexSkillDiscoveryInput {
  worktreePath: string;
  home: string;
  readDir?: CodexDiscoveryDeps["readDir"];
  readFile?: CodexDiscoveryDeps["readFile"];
}

export async function discoverCodexSkills(
  input: CodexSkillDiscoveryInput,
): Promise<CodexSkillDiscoveryResult> {
  const deps: CodexDiscoveryDeps = {
    readDir: input.readDir ?? defaultDeps.readDir,
    readFile: input.readFile ?? defaultDeps.readFile,
  };

  const items: CodexDiscoveredSkill[] = [];
  const diagnostics: CodexDiscoveryDiagnostic[] = [];
  const signatureParts: string[] = [];

  for (const source of CODEX_SKILL_DISCOVERY_PATHS) {
    const base =
      source.layer === "project"
        ? path.join(input.worktreePath, source.relative)
        : path.join(input.home, source.relative);

    if (!existsSync(base)) {
      signatureParts.push(`${source.source}:${base}:missing`);
      continue;
    }

    const ignoreDirNames =
      source.relative === ".codex/skills" && source.layer === "user"
        ? new Set([".system"])
        : new Set<string>();

    try {
      await walkSkills(base, source.source, ignoreDirNames, deps, items);
      signatureParts.push(`${source.source}:${base}:ok`);
    } catch (err) {
      const message = redactAgentCapabilityText(getErrorMessage(err));
      diagnostics.push({
        code: "codex-skill-source-unreadable",
        severity: "warning",
        message,
        sourcePath: base,
        source: source.source,
      });
      signatureParts.push(`${source.source}:${base}:err:${message}`);
      logger.warn("codex_discovery.scan_error", {
        sourcePath: base,
        error: message,
      });
    }
  }

  // Plugin-bundled skills: enumerate installed Codex plugins and walk each
  // plugin's `skills/` directory, attributing discovered SKILL.md files to
  // their owning plugin. Mirrors `claude-discovery.ts` so the cascade resolver
  // inherits disable state from the plugin layer without extra wiring.
  const pluginResult = await discoverCodexPlugins({
    worktreePath: input.worktreePath,
    home: input.home,
    ...(input.readDir !== undefined ? { readDir: input.readDir } : {}),
    ...(input.readFile !== undefined ? { readFile: input.readFile } : {}),
  });
  for (const diag of pluginResult.diagnostics) {
    diagnostics.push(diag);
  }
  signatureParts.push(`plugins:${pluginResult.sourceSignature}`);

  for (const plugin of pluginResult.items) {
    if (!plugin.pluginPath) continue;
    if (!plugin.enabled) continue;
    const pluginSkillsDir = path.join(plugin.pluginPath, "skills");
    if (!existsSync(pluginSkillsDir)) {
      signatureParts.push(
        `plugin-skills:${plugin.itemId}:${pluginSkillsDir}:missing`,
      );
      continue;
    }
    try {
      await walkSkills(
        pluginSkillsDir,
        "user",
        new Set<string>(),
        deps,
        items,
        plugin.itemId,
      );
      signatureParts.push(
        `plugin-skills:${plugin.itemId}:${pluginSkillsDir}:ok`,
      );
    } catch (err) {
      const message = redactAgentCapabilityText(getErrorMessage(err));
      diagnostics.push({
        code: "codex-skill-source-unreadable",
        severity: "warning",
        message,
        sourcePath: pluginSkillsDir,
        source: "user",
      });
      signatureParts.push(
        `plugin-skills:${plugin.itemId}:${pluginSkillsDir}:err:${message}`,
      );
      logger.warn("codex_discovery.plugin_skills_scan_error", {
        sourcePath: pluginSkillsDir,
        pluginId: plugin.itemId,
        error: message,
      });
    }
  }

  // Content-sensitive signature: include each discovered item's id, source,
  // sourcePath, description, argument hint, and owning plugin id. Discovered
  // description is parsed from the SKILL.md frontmatter/body, so an in-place
  // edit to the SKILL.md content changes the signature even when the item id
  // is stable.
  for (const item of items) {
    signatureParts.push(
      `item:${item.source}:${item.itemId}:${item.sourcePath}:${item.description}:${item.argumentHint ?? ""}:${item.owningPluginId ?? ""}`,
    );
  }

  return {
    items,
    diagnostics,
    sourceSignature: createHash("sha256")
      .update(signatureParts.join("|"))
      .digest("hex"),
  };
}

async function walkSkills(
  base: string,
  source: "project" | "user" | "system",
  ignoreDirNames: ReadonlySet<string>,
  deps: CodexDiscoveryDeps,
  items: CodexDiscoveredSkill[],
  owningPluginId?: string,
): Promise<void> {
  const visit = async (dir: string): Promise<void> => {
    const skillFile = path.join(dir, "SKILL.md");
    if (existsSync(skillFile)) {
      const content = await deps.readFile(skillFile);
      const { fields, body } = parseFrontmatter(content);
      const skillId = path.basename(dir);
      const description =
        fields["description"] ??
        body
          .split("\n")
          .find((line) => line.trim().length > 0)
          ?.trim() ??
        "";
      items.push({
        itemId: skillId,
        source,
        sourcePath: skillFile,
        description,
        argumentHint: fields["argument-hint"],
        ...(owningPluginId !== undefined ? { owningPluginId } : {}),
      });
      return;
    }

    const entries = await deps.readDir(dir);
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (ignoreDirNames.has(entry.name)) continue;
      await visit(path.join(dir, entry.name));
    }
  };

  // Ensure the base directory itself is statable; otherwise propagate as an
  // unreadable-source diagnostic above.
  await fsStat(base);
  await visit(base);
}

export interface CodexPluginDiscoveryInput {
  worktreePath: string;
  home: string;
  readDir?: CodexDiscoveryDeps["readDir"];
  readFile?: CodexDiscoveryDeps["readFile"];
}

export async function discoverCodexPlugins(
  input: CodexPluginDiscoveryInput,
): Promise<CodexPluginDiscoveryResult> {
  const deps: CodexDiscoveryDeps = {
    readDir: input.readDir ?? defaultDeps.readDir,
    readFile: input.readFile ?? defaultDeps.readFile,
  };

  const items = new Map<string, CodexDiscoveredPlugin>();
  const diagnostics: CodexDiscoveryDiagnostic[] = [];
  const signatureParts: string[] = [];
  const configEnabledById = new Map<string, boolean>();

  logger.debug("codex_discovery.plugins.start", { home: input.home });

  const configPath = path.join(input.home, ".codex", "config.toml");
  if (existsSync(configPath)) {
    await loadCodexConfigPlugins(
      configPath,
      items,
      configEnabledById,
      diagnostics,
      signatureParts,
      deps,
    );
  } else {
    signatureParts.push(`config:${configPath}:missing`);
  }

  const marketplacesDir = path.join(input.home, ".codex", "marketplaces");
  if (existsSync(marketplacesDir)) {
    await loadCodexMarketplacePlugins(
      marketplacesDir,
      items,
      configEnabledById,
      diagnostics,
      signatureParts,
      deps,
    );
  } else {
    signatureParts.push(`marketplaces:${marketplacesDir}:missing`);
  }

  const result: CodexDiscoveredPlugin[] = Array.from(items.values()).sort(
    (a, b) => a.itemId.localeCompare(b.itemId),
  );

  for (const item of result) {
    signatureParts.push(
      `item:${item.itemId}:${item.enabled}:${item.displayName}:${item.description ?? ""}:${item.version ?? ""}:${item.sourcePath ?? ""}`,
    );
  }

  logger.info("codex_discovery.plugins.done", {
    configCount: configEnabledById.size,
    totalCount: result.length,
    diagnosticCount: diagnostics.length,
  });

  return {
    items: result,
    diagnostics,
    sourceSignature: createHash("sha256")
      .update(signatureParts.join("|"))
      .digest("hex"),
    discoverySupport: "available",
  };
}

async function loadCodexConfigPlugins(
  configPath: string,
  items: Map<string, CodexDiscoveredPlugin>,
  configEnabledById: Map<string, boolean>,
  diagnostics: CodexDiscoveryDiagnostic[],
  signatureParts: string[],
  deps: CodexDiscoveryDeps,
): Promise<void> {
  let raw: string;
  try {
    raw = await deps.readFile(configPath);
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      code: "codex-config-toml-invalid",
      severity: "warning",
      message,
      sourcePath: configPath,
      source: "user",
    });
    signatureParts.push(`config:${configPath}:read-err:${message}`);
    logger.warn("codex_discovery.plugins.config_toml_unreadable", {
      sourcePath: configPath,
      error: message,
    });
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      code: "codex-config-toml-invalid",
      severity: "warning",
      message: `config.toml parse error: ${message}`,
      sourcePath: configPath,
      source: "user",
    });
    signatureParts.push(`config:${configPath}:parse-err:${message}`);
    logger.warn("codex_discovery.plugins.config_toml_invalid", {
      sourcePath: configPath,
      error: message,
    });
    return;
  }

  signatureParts.push(
    `config:${configPath}:${createHash("sha256").update(raw).digest("hex")}`,
  );

  const pluginsTable = parsed["plugins"];
  if (
    !pluginsTable ||
    typeof pluginsTable !== "object" ||
    Array.isArray(pluginsTable)
  ) {
    return;
  }

  for (const [pluginId, rawTable] of Object.entries(
    pluginsTable as Record<string, unknown>,
  )) {
    if (!rawTable || typeof rawTable !== "object" || Array.isArray(rawTable)) {
      continue;
    }
    const enabledRaw = (rawTable as Record<string, unknown>)["enabled"];
    const enabled = typeof enabledRaw === "boolean" ? enabledRaw : true;
    configEnabledById.set(pluginId, enabled);
    items.set(pluginId, {
      itemId: pluginId,
      displayName: pluginId,
      enabled,
    });
  }
}

async function loadCodexMarketplacePlugins(
  marketplacesDir: string,
  items: Map<string, CodexDiscoveredPlugin>,
  configEnabledById: Map<string, boolean>,
  diagnostics: CodexDiscoveryDiagnostic[],
  signatureParts: string[],
  deps: CodexDiscoveryDeps,
): Promise<void> {
  let topEntries: readonly { name: string; isDirectory: boolean }[];
  try {
    topEntries = await deps.readDir(marketplacesDir);
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      code: "codex-plugin-source-unreadable",
      severity: "warning",
      message,
      sourcePath: marketplacesDir,
      source: "user",
    });
    signatureParts.push(`marketplaces:${marketplacesDir}:err:${message}`);
    logger.warn("codex_discovery.plugins.marketplaces_unreadable", {
      sourcePath: marketplacesDir,
      error: message,
    });
    return;
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory) continue;
    const marketplacePath = path.join(marketplacesDir, entry.name);
    await walkMarketplaceForManifests(
      marketplacePath,
      entry.name,
      items,
      configEnabledById,
      diagnostics,
      signatureParts,
      deps,
    );
  }
}

async function walkMarketplaceForManifests(
  baseDir: string,
  marketplaceName: string,
  items: Map<string, CodexDiscoveredPlugin>,
  configEnabledById: Map<string, boolean>,
  diagnostics: CodexDiscoveryDiagnostic[],
  signatureParts: string[],
  deps: CodexDiscoveryDeps,
): Promise<void> {
  const visit = async (dir: string): Promise<void> => {
    const manifestPath = path.join(dir, ".codex-plugin", "plugin.json");
    if (existsSync(manifestPath)) {
      await loadCodexPluginManifest(
        manifestPath,
        dir,
        marketplaceName,
        items,
        configEnabledById,
        diagnostics,
        signatureParts,
        deps,
      );
      return;
    }
    let entries: readonly { name: string; isDirectory: boolean }[];
    try {
      entries = await deps.readDir(dir);
    } catch (err) {
      const message = redactAgentCapabilityText(getErrorMessage(err));
      diagnostics.push({
        code: "codex-plugin-source-unreadable",
        severity: "warning",
        message,
        sourcePath: dir,
        source: "user",
      });
      signatureParts.push(`marketplace-walk:${dir}:err:${message}`);
      logger.warn("codex_discovery.plugins.marketplace_walk_error", {
        sourcePath: dir,
        error: message,
      });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (entry.name === ".codex-plugin") continue;
      await visit(path.join(dir, entry.name));
    }
  };
  await visit(baseDir);
}

async function loadCodexPluginManifest(
  manifestPath: string,
  pluginDir: string,
  marketplaceName: string,
  items: Map<string, CodexDiscoveredPlugin>,
  configEnabledById: Map<string, boolean>,
  diagnostics: CodexDiscoveryDiagnostic[],
  signatureParts: string[],
  deps: CodexDiscoveryDeps,
): Promise<void> {
  let raw: string;
  try {
    raw = await deps.readFile(manifestPath);
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      code: "codex-plugin-manifest-invalid",
      severity: "warning",
      message,
      sourcePath: manifestPath,
      source: "user",
    });
    signatureParts.push(`manifest:${manifestPath}:read-err:${message}`);
    logger.warn("codex_discovery.plugins.manifest_unreadable", {
      sourcePath: manifestPath,
      error: message,
    });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      code: "codex-plugin-manifest-invalid",
      severity: "warning",
      message: `plugin.json parse error: ${message}`,
      sourcePath: manifestPath,
      source: "user",
    });
    signatureParts.push(`manifest:${manifestPath}:parse-err:${message}`);
    logger.warn("codex_discovery.plugins.manifest_invalid", {
      sourcePath: manifestPath,
      error: message,
    });
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push({
      code: "codex-plugin-manifest-invalid",
      severity: "warning",
      message: "plugin.json is not a JSON object",
      sourcePath: manifestPath,
      source: "user",
    });
    signatureParts.push(`manifest:${manifestPath}:non-object`);
    logger.warn("codex_discovery.plugins.manifest_invalid", {
      sourcePath: manifestPath,
      reason: "non-object",
    });
    return;
  }
  const obj = parsed as Record<string, unknown>;
  const name = obj["name"];
  if (typeof name !== "string" || name.length === 0) {
    diagnostics.push({
      code: "codex-plugin-manifest-invalid",
      severity: "warning",
      message: 'plugin.json missing required "name" field',
      sourcePath: manifestPath,
      source: "user",
    });
    signatureParts.push(`manifest:${manifestPath}:no-name`);
    logger.warn("codex_discovery.plugins.manifest_invalid", {
      sourcePath: manifestPath,
      reason: "missing-name",
    });
    return;
  }
  const itemId = `${name}@${marketplaceName}`;
  const displayName =
    typeof obj["displayName"] === "string"
      ? (obj["displayName"] as string)
      : name;
  const description =
    typeof obj["description"] === "string"
      ? (obj["description"] as string)
      : undefined;
  const version =
    typeof obj["version"] === "string" ? (obj["version"] as string) : undefined;

  const existing = items.get(itemId);
  const enabled = configEnabledById.has(itemId)
    ? (configEnabledById.get(itemId) as boolean)
    : (existing?.enabled ?? true);

  items.set(itemId, {
    itemId,
    displayName,
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
    enabled,
    sourcePath: manifestPath,
    pluginPath: pluginDir,
    marketplaceName,
  });
  signatureParts.push(
    `manifest:${manifestPath}:${createHash("sha256").update(raw).digest("hex")}`,
  );
}

// ---------------------------------------------------------------------------
// Canonical discovery surface
// ---------------------------------------------------------------------------
// The primitives above (`discoverCodexSkills` / `discoverCodexPlugins`) keep
// their local shape. The wrappers below adapt them to the canonical
// `AgentCapabilityDiscoveredItem` / `AgentCapabilityDiagnostic` shape used by
// the cascade resolver, API view, runtime composer, and discovery cache.

function codexSkillSourceRef(
  layer: "project" | "user" | "system",
  filePath: string,
): AgentCapabilitySourceRef {
  if (layer === "project") return { kind: "project-file", path: filePath };
  if (layer === "user") return { kind: "user-file", path: filePath };
  return { kind: "system-file", path: filePath };
}

function codexDiagnosticSourceRef(
  layer: "project" | "user" | "system" | undefined,
  filePath: string,
): AgentCapabilitySourceRef {
  if (layer === "user") return { kind: "user-file", path: filePath };
  if (layer === "system") return { kind: "system-file", path: filePath };
  return { kind: "project-file", path: filePath };
}

export interface CodexCanonicalSkillDiscoveryResult {
  cascadeKind: "codex-skills";
  items: readonly AgentCapabilityDiscoveredItem[];
  diagnostics: readonly AgentCapabilityDiagnostic[];
  sourceSignature: string;
  refreshedAt: string;
}

export interface CodexCanonicalPluginDiscoveryResult {
  cascadeKind: "codex-plugins";
  items: readonly AgentCapabilityDiscoveredItem[];
  diagnostics: readonly AgentCapabilityDiagnostic[];
  sourceSignature: string;
  refreshedAt: string;
  discoverySupport: AgentCapabilityDiscoverySupport;
}

export async function discoverCodexSkillsCanonical(
  input: CodexSkillDiscoveryInput,
): Promise<CodexCanonicalSkillDiscoveryResult> {
  const result = await discoverCodexSkills(input);

  const items: AgentCapabilityDiscoveredItem[] = result.items.map((skill) => {
    const source: AgentCapabilitySourceRef =
      skill.owningPluginId !== undefined
        ? { kind: "plugin", pluginId: skill.owningPluginId }
        : codexSkillSourceRef(skill.source, skill.sourcePath);
    return {
      itemId: skill.itemId,
      displayName: skill.itemId,
      capabilityKind: "skill",
      source,
      nativeDefault: { enabled: true },
      ...(skill.owningPluginId !== undefined
        ? { owningPluginId: skill.owningPluginId }
        : {}),
      runtimeVisibility: "source-only",
    };
  });

  const diagnostics: AgentCapabilityDiagnostic[] = result.diagnostics.map(
    (diag) => ({
      severity: diag.severity,
      code: diag.code,
      message: diag.message,
      cascadeKind: "codex-skills",
      backend: "codex",
      ...(diag.sourcePath !== undefined
        ? {
            sourceRef: codexDiagnosticSourceRef(diag.source, diag.sourcePath),
          }
        : {}),
    }),
  );

  return {
    cascadeKind: "codex-skills",
    items,
    diagnostics,
    sourceSignature: result.sourceSignature,
    refreshedAt: new Date().toISOString(),
  };
}

export async function discoverCodexPluginsCanonical(
  input: CodexPluginDiscoveryInput,
): Promise<CodexCanonicalPluginDiscoveryResult> {
  const result = await discoverCodexPlugins(input);
  const configPath = path.join(input.home, ".codex", "config.toml");

  const items: AgentCapabilityDiscoveredItem[] = result.items.map((plugin) => {
    const source: AgentCapabilitySourceRef = {
      kind: "user-file",
      path: plugin.sourcePath ?? configPath,
    };
    return {
      itemId: plugin.itemId,
      displayName: plugin.displayName,
      capabilityKind: "plugin",
      source,
      nativeDefault: { enabled: plugin.enabled },
      runtimeVisibility: "source-only",
    };
  });

  const diagnostics: AgentCapabilityDiagnostic[] = result.diagnostics.map(
    (diag) => ({
      severity: diag.severity,
      code: diag.code,
      message: diag.message,
      cascadeKind: "codex-plugins",
      backend: "codex",
      ...(diag.sourcePath !== undefined
        ? {
            sourceRef: codexDiagnosticSourceRef(diag.source, diag.sourcePath),
          }
        : {}),
    }),
  );

  return {
    cascadeKind: "codex-plugins",
    items,
    diagnostics,
    sourceSignature: result.sourceSignature,
    refreshedAt: new Date().toISOString(),
    discoverySupport: result.discoverySupport,
  };
}
