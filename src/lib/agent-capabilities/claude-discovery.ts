/**
 * Claude capability discovery — skills, plugins, and sub-agents.
 *
 * Reads backend-native sources read-only:
 *   - Project skills: `<worktree>/.claude/skills/<id>/SKILL.md`
 *   - User skills:    `~/.claude/skills/<id>/SKILL.md`
 *   - Plugin-contributed skills + agents: under each enabled plugin path
 *   - Project agents: `<worktree>/.claude/agents/*.md`
 *   - User agents:    `~/.claude/agents/*.md`
 *   - Plugins:        `~/.claude/settings.json` (`enabledPlugins`) joined
 *                      with `~/.claude/plugins/installed_plugins.json`
 *
 * The discovered records carry only the cascade-public fields exposed via
 * `AgentCapabilityDiscoveredItem`. The raw native `enabledPlugins[id]` value
 * (which may be a boolean or extended object like `{ version: "1.2.0" }`) is
 * returned **separately** as adapter-private `nativeRecords` for the plugin
 * translator to use; it is never persisted in CC override state or surfaced
 * through the API/UI.
 *
 * Source/runtime failures surface as `agent-capability-source-unreadable`
 * diagnostics; one cascade's failure must not poison another cascade's items.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  readdir as fsReaddir,
  readFile as fsReadFile,
  stat as fsStat,
} from "node:fs/promises";
import path from "node:path";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { parseFrontmatter } from "@/lib/commands/service";

import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import { parseNativePluginEntries } from "@/lib/agent-backends/claude/runtime-config/plugin-native-records";
import { redactAgentCapabilityText } from "./redaction";

import type {
  AgentCapabilityDiagnostic,
  AgentCapabilityDiscoveredItem,
  AgentCapabilityNativeDefault,
  AgentCapabilitySourceRef,
} from "./schemas";

const logger = createLogger("agent-capabilities.claude-discovery");

interface ClaudeDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

interface ClaudeDiscoveryDeps {
  readDir(dir: string): Promise<readonly ClaudeDirEntry[]>;
  readFile(file: string): Promise<string>;
}

const defaultDeps: ClaudeDiscoveryDeps = {
  async readDir(dir) {
    const entries = await fsReaddir(dir, { withFileTypes: true });
    // Skills/agents are commonly installed as symlinks (e.g.
    // ~/.claude/skills/foo → ~/.agents/skills/foo). Dirent.isDirectory() and
    // isFile() return false for symlinks; stat the target so callers see the
    // resolved type and discover symlinked sources the same as direct ones.
    return Promise.all(
      entries.map(async (entry) => {
        if (entry.isSymbolicLink()) {
          try {
            const stats = await fsStat(path.join(dir, entry.name));
            return {
              name: entry.name,
              isDirectory: stats.isDirectory(),
              isFile: stats.isFile(),
            };
          } catch {
            return { name: entry.name, isDirectory: false, isFile: false };
          }
        }
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        };
      }),
    );
  },
  async readFile(file) {
    return fsReadFile(file, "utf-8");
  },
};

export interface ClaudeRuntimeProbe {
  supportedCommands?(): Promise<readonly { name: string }[]>;
  supportedAgents?(): Promise<readonly { name: string }[]>;
}

export interface ClaudeDiscoveryInput {
  worktreePath: string;
  home: string;
  readDir?: ClaudeDiscoveryDeps["readDir"];
  readFile?: ClaudeDiscoveryDeps["readFile"];
  runtimeProbe?: ClaudeRuntimeProbe;
}

export interface ClaudeSkillDiscoveryResult {
  items: readonly AgentCapabilityDiscoveredItem[];
  diagnostics: readonly AgentCapabilityDiagnostic[];
  sourceSignature: string;
}

export interface ClaudeAgentDiscoveryResult {
  items: readonly AgentCapabilityDiscoveredItem[];
  diagnostics: readonly AgentCapabilityDiagnostic[];
  sourceSignature: string;
}

interface ClaudePluginNativeRecordSnapshot {
  pluginId: string;
  nativeEnabled: boolean;
  /** Adapter-private. The literal `enabledPlugins[pluginId]` value from
   * `~/.claude/settings.json`. Kept on this snapshot (NOT on the public
   * discovered item) so the plugin translator can decide whether an override
   * is a no-op against the native shape without exposing extended config to
   * the API/UI. */
  nativeRawValue?:
    | boolean
    | readonly string[]
    | { readonly [k: string]: unknown };
  /** Resolved install path when available; needed for plugin-contributed
   * skill/agent discovery. */
  installPath?: string;
}

export interface ClaudePluginDiscoveryResult {
  items: readonly AgentCapabilityDiscoveredItem[];
  diagnostics: readonly AgentCapabilityDiagnostic[];
  sourceSignature: string;
  nativeRecords: readonly ClaudePluginNativeRecordSnapshot[];
}

interface PluginResolution {
  records: ClaudePluginNativeRecordSnapshot[];
  diagnostics: AgentCapabilityDiagnostic[];
  signatureParts: string[];
}

type ClaudeSkillOverrideMode =
  | "on"
  | "name-only"
  | "user-invocable-only"
  | "off";

interface SkillDefaultsResolution {
  defaultsBySkillId: ReadonlyMap<string, AgentCapabilityNativeDefault>;
  diagnostics: AgentCapabilityDiagnostic[];
  signatureParts: string[];
}

function isClaudeSkillOverrideMode(
  value: unknown,
): value is ClaudeSkillOverrideMode {
  return (
    value === "on" ||
    value === "name-only" ||
    value === "user-invocable-only" ||
    value === "off"
  );
}

function nativeDefaultFromSkillOverride(
  mode: ClaudeSkillOverrideMode,
): AgentCapabilityNativeDefault {
  return {
    enabled: mode !== "off",
    mode,
  };
}

function nativeDefaultForSkill(
  skillId: string,
  defaultsBySkillId: ReadonlyMap<string, AgentCapabilityNativeDefault>,
): AgentCapabilityNativeDefault {
  return defaultsBySkillId.get(skillId) ?? { enabled: true };
}

async function resolveNativeSkillDefaults(
  input: ClaudeDiscoveryInput,
  deps: ClaudeDiscoveryDeps,
): Promise<SkillDefaultsResolution> {
  const settingsPath = path.join(input.home, ".claude", "settings.json");
  const defaultsBySkillId = new Map<string, AgentCapabilityNativeDefault>();
  const diagnostics: AgentCapabilityDiagnostic[] = [];
  const signatureParts: string[] = [];

  if (!existsSync(settingsPath)) {
    signatureParts.push(`skill-settings:${settingsPath}:missing`);
    return { defaultsBySkillId, diagnostics, signatureParts };
  }

  let settingsRaw: string;
  try {
    settingsRaw = await deps.readFile(settingsPath);
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      severity: "warning",
      code: "agent-capability-source-unreadable",
      message,
      cascadeKind: "claude-skills",
      backend: "claude",
      sourceRef: { kind: "user-file", path: settingsPath },
    });
    signatureParts.push(`skill-settings:${settingsPath}:err:${message}`);
    return { defaultsBySkillId, diagnostics, signatureParts };
  }

  let parsedSettings: { skillOverrides?: unknown };
  try {
    parsedSettings = JSON.parse(settingsRaw) as { skillOverrides?: unknown };
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      severity: "warning",
      code: "agent-capability-source-unreadable",
      message: `settings.json parse error: ${message}`,
      cascadeKind: "claude-skills",
      backend: "claude",
      sourceRef: { kind: "user-file", path: settingsPath },
    });
    signatureParts.push(`skill-settings:${settingsPath}:parse-err`);
    return { defaultsBySkillId, diagnostics, signatureParts };
  }

  signatureParts.push(
    `skill-settings:${settingsPath}:${createHash("sha256").update(settingsRaw).digest("hex")}`,
  );

  const skillOverrides = parsedSettings.skillOverrides;
  if (!skillOverrides || typeof skillOverrides !== "object") {
    return { defaultsBySkillId, diagnostics, signatureParts };
  }

  for (const [skillId, rawMode] of Object.entries(
    skillOverrides as Record<string, unknown>,
  )) {
    if (!isClaudeSkillOverrideMode(rawMode)) {
      diagnostics.push({
        severity: "warning",
        code: "agent-capability-source-unreadable",
        message: `settings.json skillOverrides contains an unsupported mode for skill "${skillId}".`,
        cascadeKind: "claude-skills",
        backend: "claude",
        sourceRef: { kind: "user-file", path: settingsPath },
      });
      continue;
    }
    defaultsBySkillId.set(skillId, nativeDefaultFromSkillOverride(rawMode));
  }

  return { defaultsBySkillId, diagnostics, signatureParts };
}

async function resolveNativePlugins(
  input: ClaudeDiscoveryInput,
  deps: ClaudeDiscoveryDeps,
): Promise<PluginResolution> {
  const settingsPath = path.join(input.home, ".claude", "settings.json");
  const installedPath = path.join(
    input.home,
    ".claude",
    "plugins",
    "installed_plugins.json",
  );

  const records: ClaudePluginNativeRecordSnapshot[] = [];
  const diagnostics: AgentCapabilityDiagnostic[] = [];
  const signatureParts: string[] = [];

  if (!existsSync(settingsPath)) {
    signatureParts.push(`settings:${settingsPath}:missing`);
    return { records, diagnostics, signatureParts };
  }

  let settingsRaw: string;
  try {
    settingsRaw = await deps.readFile(settingsPath);
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      severity: "warning",
      code: "agent-capability-source-unreadable",
      message,
      cascadeKind: "claude-plugins",
      backend: "claude",
      sourceRef: { kind: "user-file", path: settingsPath },
    });
    signatureParts.push(`settings:${settingsPath}:err:${message}`);
    return { records, diagnostics, signatureParts };
  }

  let parsedSettings: { enabledPlugins?: unknown };
  try {
    parsedSettings = JSON.parse(settingsRaw) as { enabledPlugins?: unknown };
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      severity: "warning",
      code: "agent-capability-source-unreadable",
      message: `settings.json parse error: ${message}`,
      cascadeKind: "claude-plugins",
      backend: "claude",
      sourceRef: { kind: "user-file", path: settingsPath },
    });
    signatureParts.push(`settings:${settingsPath}:parse-err`);
    return { records, diagnostics, signatureParts };
  }

  // Shared native-records parser — provider knowledge owned by the Claude
  // runtime-config adapter; imported here (capabilities → backends) so the
  // enabledPlugins shape is decoded in exactly one place.
  const nativeEntries = parseNativePluginEntries(parsedSettings.enabledPlugins);

  signatureParts.push(
    `settings:${settingsPath}:${createHash("sha256").update(settingsRaw).digest("hex")}`,
  );

  if (nativeEntries.length === 0) {
    return { records, diagnostics, signatureParts };
  }

  let installed: Record<
    string,
    Array<{ installPath?: string; cachePath?: string }>
  > = {};

  if (existsSync(installedPath)) {
    try {
      const raw = await deps.readFile(installedPath);
      const parsed = JSON.parse(raw) as {
        plugins?: typeof installed;
      };
      installed = parsed.plugins ?? {};
      signatureParts.push(
        `installed:${installedPath}:${createHash("sha256").update(raw).digest("hex")}`,
      );
    } catch (err) {
      const message = redactAgentCapabilityText(getErrorMessage(err));
      diagnostics.push({
        severity: "warning",
        code: "agent-capability-source-unreadable",
        message: `installed_plugins.json parse error: ${message}`,
        cascadeKind: "claude-plugins",
        backend: "claude",
        sourceRef: { kind: "user-file", path: installedPath },
      });
      signatureParts.push(`installed:${installedPath}:parse-err`);
    }
  } else {
    signatureParts.push(`installed:${installedPath}:missing`);
  }

  for (const entry of nativeEntries) {
    const installs = installed[entry.pluginId];
    const first = installs?.[0];
    const installPath = first?.installPath ?? first?.cachePath ?? undefined;
    records.push({
      pluginId: entry.pluginId,
      nativeEnabled: entry.nativeEnabled,
      nativeRawValue: entry.nativeRawValue,
      ...(installPath !== undefined ? { installPath } : {}),
    });
  }

  return { records, diagnostics, signatureParts };
}

interface ScanSkillContext {
  sourceRefForPath(skillFilePath: string): AgentCapabilitySourceRef;
  owningPluginId?: string;
  layerSignaturePrefix: string;
  nativeDefaultsBySkillId: ReadonlyMap<string, AgentCapabilityNativeDefault>;
}

async function scanSkillsTree(
  baseDir: string,
  ctx: ScanSkillContext,
  deps: ClaudeDiscoveryDeps,
  items: AgentCapabilityDiscoveredItem[],
  diagnostics: AgentCapabilityDiagnostic[],
  signatureParts: string[],
): Promise<void> {
  if (!existsSync(baseDir)) {
    signatureParts.push(`${ctx.layerSignaturePrefix}:${baseDir}:missing`);
    return;
  }

  const visit = async (dir: string): Promise<void> => {
    const skillFile = path.join(dir, "SKILL.md");
    if (existsSync(skillFile)) {
      const content = await deps.readFile(skillFile);
      const { fields, body } = parseFrontmatter(content);
      const skillId = path.basename(dir);
      const displayName = fields["name"] ?? skillId;
      const description =
        fields["description"] ??
        body
          .split("\n")
          .find((line) => line.trim().length > 0)
          ?.trim() ??
        "";
      items.push({
        itemId: skillId,
        displayName,
        capabilityKind: "skill",
        source: ctx.sourceRefForPath(skillFile),
        nativeDefault: nativeDefaultForSkill(
          skillId,
          ctx.nativeDefaultsBySkillId,
        ),
        ...(ctx.owningPluginId !== undefined
          ? { owningPluginId: ctx.owningPluginId }
          : {}),
        runtimeVisibility: "source-only",
      });
      signatureParts.push(
        `${ctx.layerSignaturePrefix}:skill:${skillId}:${skillFile}:${displayName}:${description}:${fields["argument-hint"] ?? ""}`,
      );
      return;
    }

    const entries = await deps.readDir(dir);
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      await visit(path.join(dir, entry.name));
    }
  };

  try {
    await visit(baseDir);
    signatureParts.push(`${ctx.layerSignaturePrefix}:${baseDir}:ok`);
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      severity: "warning",
      code: "agent-capability-source-unreadable",
      message,
      cascadeKind: "claude-skills",
      backend: "claude",
    });
    signatureParts.push(
      `${ctx.layerSignaturePrefix}:${baseDir}:err:${message}`,
    );
    logger.warn("claude_discovery.skills_scan_error", {
      baseDir,
      error: message,
    });
  }
}

interface ScanAgentContext {
  sourceRefForPath(agentFilePath: string): AgentCapabilitySourceRef;
  owningPluginId?: string;
  layerSignaturePrefix: string;
}

async function scanAgentsDir(
  baseDir: string,
  ctx: ScanAgentContext,
  deps: ClaudeDiscoveryDeps,
  items: AgentCapabilityDiscoveredItem[],
  diagnostics: AgentCapabilityDiagnostic[],
  signatureParts: string[],
): Promise<void> {
  if (!existsSync(baseDir)) {
    signatureParts.push(`${ctx.layerSignaturePrefix}:${baseDir}:missing`);
    return;
  }
  try {
    const entries = await deps.readDir(baseDir);
    for (const entry of entries) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".md")) continue;
      const agentPath = path.join(baseDir, entry.name);
      const content = await deps.readFile(agentPath);
      const { fields, body } = parseFrontmatter(content);
      const agentId = entry.name.replace(/\.md$/, "");
      const displayName = fields["name"] ?? agentId;
      const description =
        fields["description"] ??
        body
          .split("\n")
          .find((line) => line.trim().length > 0)
          ?.trim() ??
        "";
      items.push({
        itemId: agentId,
        displayName,
        capabilityKind: "agent",
        source: ctx.sourceRefForPath(agentPath),
        nativeDefault: { enabled: true },
        ...(ctx.owningPluginId !== undefined
          ? { owningPluginId: ctx.owningPluginId }
          : {}),
        runtimeVisibility: "source-only",
      });
      signatureParts.push(
        `${ctx.layerSignaturePrefix}:agent:${agentId}:${agentPath}:${displayName}:${description}`,
      );
    }
    signatureParts.push(`${ctx.layerSignaturePrefix}:${baseDir}:ok`);
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      severity: "warning",
      code: "agent-capability-source-unreadable",
      message,
      cascadeKind: "claude-agents",
      backend: "claude",
    });
    signatureParts.push(
      `${ctx.layerSignaturePrefix}:${baseDir}:err:${message}`,
    );
    logger.warn("claude_discovery.agents_scan_error", {
      baseDir,
      error: message,
    });
  }
}

function buildSignature(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

async function applyRuntimeVisibility(
  items: AgentCapabilityDiscoveredItem[],
  diagnostics: AgentCapabilityDiagnostic[],
  signatureParts: string[],
  nativeDefaultsBySkillId: ReadonlyMap<string, AgentCapabilityNativeDefault>,
  cascadeKind: "claude-skills" | "claude-agents",
  probe: undefined | (() => Promise<readonly { name: string }[]>),
): Promise<void> {
  if (!probe) return;
  try {
    const live = await probe();
    const names = new Set<string>(live.map((entry) => entry.name));
    signatureParts.push(
      `runtime:${cascadeKind}:${Array.from(names).sort().join(",")}`,
    );
    const knownItemIds = new Set(items.map((item) => item.itemId));
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item) continue;
      if (names.has(item.itemId)) {
        items[i] = { ...item, runtimeVisibility: "runtime-visible" };
      }
    }
    for (const name of names) {
      if (knownItemIds.has(name)) continue;
      items.push({
        itemId: name,
        displayName: name,
        capabilityKind: cascadeKind === "claude-skills" ? "skill" : "agent",
        source: { kind: "sdk-runtime" },
        nativeDefault:
          cascadeKind === "claude-skills"
            ? nativeDefaultForSkill(name, nativeDefaultsBySkillId)
            : { enabled: true },
        runtimeVisibility: "runtime-visible",
      });
    }
  } catch (err) {
    const message = redactAgentCapabilityText(getErrorMessage(err));
    diagnostics.push({
      severity: "warning",
      code: "agent-capability-source-unreadable",
      message: `Claude SDK runtime probe failed: ${message}`,
      cascadeKind,
      backend: "claude",
      sourceRef: { kind: "sdk-runtime" },
    });
    signatureParts.push(`runtime:${cascadeKind}:err:${message}`);
    logger.warn("claude_discovery.runtime_probe_error", {
      cascadeKind,
      error: message,
    });
  }
}

export async function discoverClaudeSkills(
  input: ClaudeDiscoveryInput,
): Promise<ClaudeSkillDiscoveryResult> {
  const deps: ClaudeDiscoveryDeps = {
    readDir: input.readDir ?? defaultDeps.readDir,
    readFile: input.readFile ?? defaultDeps.readFile,
  };

  const items: AgentCapabilityDiscoveredItem[] = [];
  const diagnostics: AgentCapabilityDiagnostic[] = [];
  const signatureParts: string[] = [];

  const skillDefaults = await resolveNativeSkillDefaults(input, deps);
  diagnostics.push(...skillDefaults.diagnostics);
  signatureParts.push(...skillDefaults.signatureParts);

  const projectSkillsDir = path.join(input.worktreePath, ".claude/skills");
  await scanSkillsTree(
    projectSkillsDir,
    {
      sourceRefForPath: (p) => ({ kind: "project-file", path: p }),
      layerSignaturePrefix: "project",
      nativeDefaultsBySkillId: skillDefaults.defaultsBySkillId,
    },
    deps,
    items,
    diagnostics,
    signatureParts,
  );

  const userSkillsDir = path.join(input.home, ".claude/skills");
  await scanSkillsTree(
    userSkillsDir,
    {
      sourceRefForPath: (p) => ({ kind: "user-file", path: p }),
      layerSignaturePrefix: "user",
      nativeDefaultsBySkillId: skillDefaults.defaultsBySkillId,
    },
    deps,
    items,
    diagnostics,
    signatureParts,
  );

  const pluginResolution = await resolveNativePlugins(input, deps);
  diagnostics.push(...pluginResolution.diagnostics);
  signatureParts.push(...pluginResolution.signatureParts);

  for (const record of pluginResolution.records) {
    if (!record.installPath) continue;
    if (!record.nativeEnabled) continue;
    const pluginSkillsDir = path.join(record.installPath, "skills");
    await scanSkillsTree(
      pluginSkillsDir,
      {
        sourceRefForPath: () => ({ kind: "plugin", pluginId: record.pluginId }),
        owningPluginId: record.pluginId,
        layerSignaturePrefix: `plugin:${record.pluginId}`,
        nativeDefaultsBySkillId: skillDefaults.defaultsBySkillId,
      },
      deps,
      items,
      diagnostics,
      signatureParts,
    );
  }

  await applyRuntimeVisibility(
    items,
    diagnostics,
    signatureParts,
    skillDefaults.defaultsBySkillId,
    "claude-skills",
    input.runtimeProbe?.supportedCommands?.bind(input.runtimeProbe),
  );

  return {
    items,
    diagnostics,
    sourceSignature: buildSignature(signatureParts),
  };
}

export async function discoverClaudeAgents(
  input: ClaudeDiscoveryInput,
): Promise<ClaudeAgentDiscoveryResult> {
  const deps: ClaudeDiscoveryDeps = {
    readDir: input.readDir ?? defaultDeps.readDir,
    readFile: input.readFile ?? defaultDeps.readFile,
  };

  const items: AgentCapabilityDiscoveredItem[] = [];
  const diagnostics: AgentCapabilityDiagnostic[] = [];
  const signatureParts: string[] = [];

  const projectAgentsDir = path.join(input.worktreePath, ".claude/agents");
  await scanAgentsDir(
    projectAgentsDir,
    {
      sourceRefForPath: (p) => ({ kind: "project-file", path: p }),
      layerSignaturePrefix: "project",
    },
    deps,
    items,
    diagnostics,
    signatureParts,
  );

  const userAgentsDir = path.join(input.home, ".claude/agents");
  await scanAgentsDir(
    userAgentsDir,
    {
      sourceRefForPath: (p) => ({ kind: "user-file", path: p }),
      layerSignaturePrefix: "user",
    },
    deps,
    items,
    diagnostics,
    signatureParts,
  );

  const pluginResolution = await resolveNativePlugins(input, deps);
  diagnostics.push(...pluginResolution.diagnostics);
  signatureParts.push(...pluginResolution.signatureParts);

  for (const record of pluginResolution.records) {
    if (!record.installPath) continue;
    if (!record.nativeEnabled) continue;
    const pluginAgentsDir = path.join(record.installPath, "agents");
    await scanAgentsDir(
      pluginAgentsDir,
      {
        sourceRefForPath: () => ({ kind: "plugin", pluginId: record.pluginId }),
        owningPluginId: record.pluginId,
        layerSignaturePrefix: `plugin:${record.pluginId}`,
      },
      deps,
      items,
      diagnostics,
      signatureParts,
    );
  }

  await applyRuntimeVisibility(
    items,
    diagnostics,
    signatureParts,
    new Map<string, AgentCapabilityNativeDefault>(),
    "claude-agents",
    input.runtimeProbe?.supportedAgents?.bind(input.runtimeProbe),
  );

  return {
    items,
    diagnostics,
    sourceSignature: buildSignature(signatureParts),
  };
}

export async function discoverClaudePlugins(
  input: ClaudeDiscoveryInput,
): Promise<ClaudePluginDiscoveryResult> {
  const deps: ClaudeDiscoveryDeps = {
    readDir: input.readDir ?? defaultDeps.readDir,
    readFile: input.readFile ?? defaultDeps.readFile,
  };

  const resolution = await resolveNativePlugins(input, deps);
  const items: AgentCapabilityDiscoveredItem[] = resolution.records.map(
    (record) => ({
      itemId: record.pluginId,
      displayName: record.pluginId,
      capabilityKind: "plugin",
      source: {
        kind: "user-file",
        path: path.join(input.home, ".claude", "settings.json"),
      },
      nativeDefault: { enabled: record.nativeEnabled },
      runtimeVisibility: "source-only",
    }),
  );

  return {
    items,
    diagnostics: resolution.diagnostics,
    sourceSignature: buildSignature(resolution.signatureParts),
    nativeRecords: resolution.records,
  };
}

/**
 * Live-runtime probe for the conversation's Claude SDK session, when one is
 * alive: skills/agents discovery cross-checks source files against what the
 * runtime actually loaded. Claude-owned by construction (the probe ports are
 * Claude SDK surfaces), so the identity check lives here beside the discovery
 * it feeds — never in a backend-neutral consumer.
 */
export function getClaudeRuntimeProbe(
  conversationId: string,
): ClaudeRuntimeProbe | undefined {
  const runtime = getRuntime(conversationId);
  if (!runtime || runtime.backend !== "claude" || runtime.status !== "alive") {
    return undefined;
  }
  if (!runtime.supportedCommands && !runtime.supportedAgents) {
    return undefined;
  }
  return {
    ...(runtime.supportedCommands
      ? { supportedCommands: runtime.supportedCommands.bind(runtime) }
      : {}),
    ...(runtime.supportedAgents
      ? { supportedAgents: runtime.supportedAgents.bind(runtime) }
      : {}),
  };
}
