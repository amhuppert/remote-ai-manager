import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallResult {
  hookScriptPath: string;
  settingsPath: string;
  actions: string[];
  hookScriptCreated: boolean;
  settingsUpdated: boolean;
}

// ---------------------------------------------------------------------------
// Hook events that CSM listens to
// ---------------------------------------------------------------------------

const CSM_HOOK_EVENTS = ["UserPromptSubmit", "Stop"] as const;

// ---------------------------------------------------------------------------
// generateHookScript
// ---------------------------------------------------------------------------

/** Generate the shell script content for the CSM hook handler. */
export function generateHookScript(): string {
  return `#!/usr/bin/env bash
# csm — Claude Session Manager hook handler
# Forwards Claude Code lifecycle events to the CSM API.

cat | curl -s -X POST http://localhost:3000/api/hooks \\
  -H "Content-Type: application/json" \\
  -d @- > /dev/null 2>&1 &
`;
}

// ---------------------------------------------------------------------------
// mergeHooksIntoSettings
// ---------------------------------------------------------------------------

/**
 * Merge CSM hook entries into an existing settings object.
 *
 * - Preserves all non-CSM hooks for the same events.
 * - Preserves hooks for events CSM does not use.
 * - Preserves all non-hook top-level keys.
 * - Replaces any existing CSM hooks (idempotent).
 */
export function mergeHooksIntoSettings(
  existing: Record<string, unknown>,
  hookCommand: string,
): Record<string, unknown> {
  const csmHookEntry = {
    hooks: [{ type: "command" as const, command: hookCommand }],
  };

  const existingHooks: Record<string, unknown[]> =
    existing.hooks != null && typeof existing.hooks === "object"
      ? { ...(existing.hooks as Record<string, unknown[]>) }
      : {};

  const mergedHooks: Record<string, unknown[]> = { ...existingHooks };

  for (const event of CSM_HOOK_EVENTS) {
    const eventEntries = Array.isArray(mergedHooks[event])
      ? mergedHooks[event]
      : [];

    // Keep only non-CSM entries
    const nonCsmEntries = eventEntries.filter((entry: unknown) => {
      const e = entry as { hooks?: Array<{ type?: string; command?: string }> };
      if (!e?.hooks || !Array.isArray(e.hooks)) return true;
      return !e.hooks.some(
        (h) =>
          h.type === "command" &&
          typeof h.command === "string" &&
          h.command.includes("csm"),
      );
    });

    mergedHooks[event] = [...nonCsmEntries, csmHookEntry];
  }

  return { ...existing, hooks: mergedHooks };
}

// ---------------------------------------------------------------------------
// installHooks
// ---------------------------------------------------------------------------

/**
 * Install the CSM hook script and patch ~/.claude/settings.json.
 *
 * 1. Creates ~/.claude/hooks/ if needed
 * 2. Writes csm-hook.sh (executable)
 * 3. Reads existing settings.json (or starts with {})
 * 4. Merges CSM hooks into settings
 * 5. Atomically writes settings.json (temp + rename)
 */
export async function installHooks(): Promise<InstallResult> {
  const actions: string[] = [];
  const home = os.homedir();

  // 1. Write hook script
  const hooksDir = path.join(home, ".claude", "hooks");
  const hookScriptPath = path.join(hooksDir, "csm-hook.sh");

  await mkdir(hooksDir, { recursive: true });
  actions.push(`Ensured directory exists: ${hooksDir}`);

  const scriptContent = generateHookScript();
  await writeFile(hookScriptPath, scriptContent, "utf-8");
  await chmod(hookScriptPath, 0o755);
  actions.push(`Wrote hook script: ${hookScriptPath}`);

  // 2. Read existing settings.json
  const settingsPath = path.join(home, ".claude", "settings.json");
  let existingSettings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(raw) as Record<string, unknown>;
      actions.push(`Read existing settings: ${settingsPath}`);
    } catch {
      actions.push("Could not parse existing settings, starting fresh");
    }
  } else {
    actions.push("No existing settings.json found, creating new");
  }

  // 3. Merge CSM hooks
  const mergedSettings = mergeHooksIntoSettings(
    existingSettings,
    hookScriptPath,
  );

  // 4. Atomic write (temp + rename)
  const tmpPath = `${settingsPath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(mergedSettings, null, 2), "utf-8");
  await rename(tmpPath, settingsPath);
  actions.push(`Updated settings: ${settingsPath}`);

  return {
    hookScriptPath,
    settingsPath,
    actions,
    hookScriptCreated: true,
    settingsUpdated: true,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point — runs when executed directly via `npx tsx`
// ---------------------------------------------------------------------------

const isDirectExecution =
  process.argv[1]?.endsWith("install-hooks.ts") ||
  process.argv[1]?.endsWith("install-hooks");

if (isDirectExecution) {
  installHooks()
    .then((result) => {
      console.log("CSM Hook Installer");
      console.log("==================");
      for (const action of result.actions) {
        console.log(`  * ${action}`);
      }
      console.log("\nDone. CSM hooks installed successfully.");
      console.log(
        "Restart any running Claude Code sessions for hooks to take effect.",
      );
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Failed to install hooks:", message);
      process.exit(1);
    });
}
