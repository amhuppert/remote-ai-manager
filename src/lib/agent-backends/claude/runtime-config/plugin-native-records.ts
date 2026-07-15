/**
 * Reader for Claude's native plugin enablement records.
 *
 * `~/.claude/settings.json`'s `enabledPlugins` accepts
 * `string[] | Record<pluginId, boolean | string[] | object>`; the entries are
 * provider knowledge the plugin translator needs to compute a minimal
 * flag-layer delta (see `plugin-translator.ts`). This module is the single
 * parser for that shape: the runtime-config adapter reads records itself at
 * apply/creation time, and capability discovery (above the seam) imports
 * `parseNativePluginEntries` so the knowledge is never duplicated.
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
 * Read the current native plugin records from `~/.claude/settings.json`.
 * Returns `[]` when the file is absent; throws when it exists but cannot be
 * read or parsed, so callers can distinguish "no native config" from "native
 * config unknown" (the latter must not be treated as an empty delta basis).
 */
export async function readClaudePluginNativeRecords(
  deps: ClaudePluginNativeRecordsDeps = defaultDeps,
): Promise<readonly ClaudePluginNativeRecord[]> {
  const settingsPath = path.join(deps.homeDir(), ".claude", "settings.json");
  let raw: string;
  try {
    raw = await deps.readFile(settingsPath);
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as { enabledPlugins?: unknown };
  return parseNativePluginEntries(parsed.enabledPlugins);
}
