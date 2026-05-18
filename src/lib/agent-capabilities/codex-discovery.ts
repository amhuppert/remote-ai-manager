/**
 * Codex capability discovery primitives.
 *
 * Implements the design's authoritative skill discovery sources for Codex and
 * keeps Codex plugin discovery represented as `unavailable-pending-verification`
 * until an authoritative installed/enabled plugin source is verified. The
 * factory accepts a `readDir` seam so tests can drive the diagnostics path
 * without root-only filesystem corruption.
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
import { getErrorMessage } from "@/lib/errors";

import { parseFrontmatter } from "@/lib/commands";

import { redactAgentCapabilityText } from "./redaction";

import type {
  AgentCapabilityDiagnostic,
  AgentCapabilityDiscoveredItem,
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

export interface CodexDiscoveredSkill {
  itemId: string;
  source: "project" | "user" | "system";
  sourcePath: string;
  description: string;
  argumentHint?: string;
}

export interface CodexDiscoveryDiagnostic {
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

export interface CodexPluginDiscoveryResult {
  items: readonly never[];
  diagnostics: readonly CodexDiscoveryDiagnostic[];
  discoverySupport: "unavailable-pending-verification";
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

  // Content-sensitive signature: include each discovered item's id, source,
  // sourcePath, description, and argument hint. Discovered description is
  // parsed from the SKILL.md frontmatter/body, so an in-place edit to the
  // SKILL.md content changes the signature even when the item id is stable.
  for (const item of items) {
    signatureParts.push(
      `item:${item.source}:${item.itemId}:${item.sourcePath}:${item.description}:${item.argumentHint ?? ""}`,
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
}

export async function discoverCodexPlugins(
  _input: CodexPluginDiscoveryInput,
): Promise<CodexPluginDiscoveryResult> {
  // Verification gate: no authoritative Codex plugin source has been
  // identified. Discovery deliberately returns an empty inventory plus a
  // structured diagnostic so the UI panel can render in an unavailable state
  // and runtime composition refuses to emit configuration for this cascade.
  return {
    items: [],
    diagnostics: [
      {
        code: "codex-plugins-unavailable",
        severity: "warning",
        message:
          "Codex plugin discovery is unavailable: no authoritative installed/enabled plugin source has been verified for the installed Codex SDK.",
      },
    ],
    discoverySupport: "unavailable-pending-verification",
  };
}

// ---------------------------------------------------------------------------
// Canonical discovery surface
// ---------------------------------------------------------------------------
// The primitives above (`discoverCodexSkills` / `discoverCodexPlugins`) keep
// their local shape because they are the proven verification gates from task
// 1.1. The wrappers below adapt them to the canonical
// `AgentCapabilityDiscoveredItem` / `AgentCapabilityDiagnostic` shape used by
// the cascade resolver, API view, runtime composer, and discovery cache. This
// keeps the cross-cutting agent-capabilities subsystem on a single schema
// without re-doing the source-signature or verification-gate logic.

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
  discoverySupport: "unavailable-pending-verification";
}

export async function discoverCodexSkillsCanonical(
  input: CodexSkillDiscoveryInput,
): Promise<CodexCanonicalSkillDiscoveryResult> {
  const result = await discoverCodexSkills(input);

  const items: AgentCapabilityDiscoveredItem[] = result.items.map((skill) => ({
    itemId: skill.itemId,
    displayName: skill.itemId,
    capabilityKind: "skill",
    source: codexSkillSourceRef(skill.source, skill.sourcePath),
    nativeDefault: { enabled: true },
    runtimeVisibility: "source-only",
  }));

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
  const diagnostics: AgentCapabilityDiagnostic[] = result.diagnostics.map(
    (diag) => ({
      severity: diag.severity,
      code: diag.code,
      message: diag.message,
      cascadeKind: "codex-plugins",
      backend: "codex",
    }),
  );
  return {
    cascadeKind: "codex-plugins",
    items: [],
    diagnostics,
    // Plugin discovery has no native source to hash; a literal sentinel keeps
    // the cache key stable across refreshes until verification provides a
    // real source to sign.
    sourceSignature: "codex-plugins:unavailable-pending-verification",
    refreshedAt: new Date().toISOString(),
    discoverySupport: result.discoverySupport,
  };
}
