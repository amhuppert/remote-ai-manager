import { getPublishedManagedSkillBundle } from "@/lib/managed-skills/service";
/**
 * Native skill inventory and a bounded reader for installed Codex plugins.
 * Skill identities, native defaults, plugin ownership, and invocation remain
 * adapter-owned; shared capability resolution receives only the catalog.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

import {
  discoverCodexSkillInventory,
  discoverCodexSkillCommands,
} from "./skill-discovery";
import type { CodexNativeSkill } from "./skill-catalog";
import { codexSkillIdentity } from "./skill-identity";

import { redactAgentCapabilityText } from "../capability-redaction";

import type {
  CapabilityCatalogDiagnostic as AgentCapabilityDiagnostic,
  AgentCapabilityDiscoveredItem,
  AgentCapabilityDiscoverySupport,
  AgentCapabilitySourceRef,
} from "../capability-catalog";

const logger = createLogger("agent-capabilities.codex-discovery");

interface CodexDiscoveryDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  sourcePath?: string;
  source?: "project" | "user" | "system";
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
  listSkills?(worktreePath: string): Promise<readonly CodexNativeSkill[]>;
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

  const pluginCacheDir = path.join(input.home, ".codex", "plugins", "cache");
  if (existsSync(pluginCacheDir)) {
    await loadCodexMarketplacePlugins(
      pluginCacheDir,
      items,
      configEnabledById,
      diagnostics,
      signatureParts,
      deps,
    );
  } else {
    signatureParts.push(`plugin-cache:${pluginCacheDir}:missing`);
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
  const skills = await (input.listSkills ?? discoverCodexSkillInventory)(
    input.worktreePath,
  );
  const managedRoot =
    path.join(input.worktreePath, ".agents", "skills", "command-center") +
    path.sep;
  const bundleRoot = getPublishedManagedSkillBundle()?.skillsRoot;
  const items: AgentCapabilityDiscoveredItem[] = skills
    .filter(
      (skill) =>
        !skill.path.startsWith(managedRoot) &&
        !(bundleRoot && skill.path.startsWith(bundleRoot + path.sep)),
    )
    .map((skill) => ({
      itemId: codexSkillIdentity(skill.path, input.worktreePath, input.home),
      displayName: skill.name,
      capabilityKind: "skill",
      source: skill.pluginId
        ? { kind: "plugin", pluginId: skill.pluginId }
        : {
            kind:
              skill.scope === "repo"
                ? "project-file"
                : skill.scope === "user"
                  ? "user-file"
                  : "system-file",
            path: skill.path,
          },
      nativeDefault: { enabled: skill.enabled },
      ...(skill.pluginId ? { owningPluginId: skill.pluginId } : {}),
      runtimeVisibility: "source-only",
    }));
  return {
    cascadeKind: "codex-skills",
    items,
    diagnostics: [],
    sourceSignature: createHash("sha256")
      .update(JSON.stringify(items))
      .digest("hex"),
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

export const codexCapabilityCatalog: import("../capability-catalog").BackendCapabilityCatalogFacet =
  {
    discover(input) {
      if (input.kind === "plugins") return discoverCodexPluginsCanonical(input);
      if (input.kind === "skills") return discoverCodexSkillsCanonical(input);
      throw new Error("Codex does not expose managed agent selection");
    },
  };
import type { BackendSkillCatalogFacet } from "../descriptor";
import {
  translateCodexRuntimeCapabilities,
  mergeCodexNativeSkillSelectors,
} from "./runtime-config";

export const codexSkillCatalog: BackendSkillCatalogFacet = {
  async getCommands({ worktreePath, capabilities }) {
    const config = capabilities
      ? translateCodexRuntimeCapabilities(capabilities, worktreePath).config
      : {};
    return discoverCodexSkillCommands(worktreePath, {
      ...(await mergeCodexNativeSkillSelectors(config, worktreePath)),
    });
  },
};
