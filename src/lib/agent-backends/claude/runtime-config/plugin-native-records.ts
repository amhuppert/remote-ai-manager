/**
 * Claude plugin baselines, shared by adapter discovery and flag translation.
 * User, project, and local settings merge per plugin in native precedence
 * order. Extended native values remain private so no-op CC overrides leave
 * them intact.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ClaudePluginNativeRecord } from "./plugin-translator";

/**
 * Pure parser: the raw `enabledPlugins` value from settings.json → native
 * records. Unknown entry shapes are skipped.
 */
export function parseNativePluginEntries(
  enabledPlugins: unknown,
): ClaudePluginNativeRecord[] {
  const records: ClaudePluginNativeRecord[] = [];

  if (Array.isArray(enabledPlugins)) {
    for (const id of enabledPlugins as readonly unknown[]) {
      if (typeof id !== "string") continue;
      records.push({ pluginId: id, nativeEnabled: true, nativeRawValue: true });
    }
    return records;
  }

  if (enabledPlugins && typeof enabledPlugins === "object") {
    for (const [pluginId, raw] of Object.entries(
      enabledPlugins as Record<string, unknown>,
    )) {
      if (typeof raw === "boolean") {
        records.push({ pluginId, nativeEnabled: raw, nativeRawValue: raw });
      } else if (Array.isArray(raw)) {
        records.push({
          pluginId,
          nativeEnabled: true,
          nativeRawValue: raw as readonly string[],
        });
      } else if (raw && typeof raw === "object") {
        records.push({
          pluginId,
          nativeEnabled: true,
          nativeRawValue: raw as { readonly [k: string]: unknown },
        });
      }
    }
  }

  return records;
}

export interface ClaudePluginNativeRecordsDeps {
  readFile(filePath: string): Promise<string>;
  homeDir(): string;
}

const defaultDeps: ClaudePluginNativeRecordsDeps = {
  readFile: (filePath) => fs.readFile(filePath, "utf8"),
  homeDir: () => os.homedir(),
};

/**
 * Read effective native plugin records for the addressed working directory.
 * Returns `[]` when the file is absent; throws when it exists but cannot be
 * read or parsed, so callers can distinguish "no native config" from "native
 * config unknown" (the latter must not be treated as an empty delta basis).
 */
export async function readClaudePluginNativeRecords(
  deps: ClaudePluginNativeRecordsDeps = defaultDeps,
  worktreePath?: string,
): Promise<readonly ClaudePluginNativeRecord[]> {
  const paths = [path.join(deps.homeDir(), ".claude", "settings.json")];
  if (worktreePath)
    paths.push(
      path.join(worktreePath, ".claude", "settings.json"),
      path.join(worktreePath, ".claude", "settings.local.json"),
    );
  const records = new Map<string, ClaudePluginNativeRecord>();
  for (const settingsPath of paths) {
    let raw: string;
    try {
      raw = await deps.readFile(settingsPath);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT")
        continue;
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("enabledPlugins" in parsed))
      continue;
    for (const record of parseNativePluginEntries(parsed.enabledPlugins))
      records.set(record.pluginId, record);
  }
  return [...records.values()];
}
