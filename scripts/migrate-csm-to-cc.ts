#!/usr/bin/env bun
/**
 * One-time migration: rename "csm" → "cc"
 *
 * Migrates:
 * 1. Config directory: ~/.config/csm/ → ~/.config/cc/
 *    (or ~/Library/Application Support/csm/ → .../cc/ on macOS)
 * 2. State file: rewrites "csm" source values to "cc" in state.json
 * 3. Log file: renames csm-debug.log → cc-debug.log (inside the dir)
 *
 * Safe to run multiple times — skips steps that are already done.
 * Run: bun scripts/migrate-csm-to-cc.ts
 */

import { rename, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function getOldConfigDir(): string {
  if (os.platform() === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "csm");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg
    ? path.join(xdg, "csm")
    : path.join(os.homedir(), ".config", "csm");
}

function getNewConfigDir(): string {
  if (os.platform() === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "cc");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg ? path.join(xdg, "cc") : path.join(os.homedir(), ".config", "cc");
}

/** Replace all "csm" source values with "cc" in state.json */
async function migrateStateFile(configDir: string): Promise<boolean> {
  const stateFile = path.join(configDir, "state.json");
  if (!existsSync(stateFile)) {
    console.log("  [skip] state.json not found");
    return false;
  }

  const raw = await readFile(stateFile, "utf-8");
  const state = JSON.parse(raw);
  let changed = false;

  // Walk all projects → sessions → conversations and fix source fields
  const projects = state.projects ?? {};
  for (const projectState of Object.values(projects) as Record<
    string,
    unknown
  >[]) {
    const sessions = (projectState.sessions ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const session of Object.values(sessions)) {
      if (session.source === "csm") {
        session.source = "cc";
        changed = true;
      }
      for (const conv of (session.conversations ?? []) as Record<
        string,
        unknown
      >[]) {
        if (conv.source === "csm") {
          conv.source = "cc";
          changed = true;
        }
      }
    }
  }

  if (changed) {
    await writeFile(stateFile, JSON.stringify(state, null, 2), "utf-8");
    console.log("  [done] state.json: rewrote source values csm → cc");
  } else {
    console.log("  [skip] state.json: no csm source values found");
  }
  return changed;
}

/** Rename csm-debug.log → cc-debug.log */
async function migrateLogFile(configDir: string): Promise<boolean> {
  const oldLog = path.join(configDir, "csm-debug.log");
  const newLog = path.join(configDir, "cc-debug.log");

  if (existsSync(newLog)) {
    console.log("  [skip] cc-debug.log already exists");
    return false;
  }
  if (!existsSync(oldLog)) {
    console.log("  [skip] csm-debug.log not found");
    return false;
  }

  await rename(oldLog, newLog);
  console.log("  [done] csm-debug.log → cc-debug.log");
  return true;
}

async function main(): Promise<void> {
  console.log("CSM → CC migration\n");

  const oldDir = getOldConfigDir();
  const newDir = getNewConfigDir();

  // Step 1: Rename config directory
  console.log("Step 1: Config directory");
  if (existsSync(newDir)) {
    console.log(`  [skip] ${newDir} already exists`);
  } else if (!existsSync(oldDir)) {
    console.log(`  [skip] ${oldDir} not found (nothing to migrate)`);
    return;
  } else {
    await rename(oldDir, newDir);
    console.log(`  [done] ${oldDir} → ${newDir}`);
  }

  // Step 2: Migrate state file (source field values)
  console.log("\nStep 2: State file source values");
  await migrateStateFile(newDir);

  // Step 3: Rename log file
  console.log("\nStep 3: Log file");
  await migrateLogFile(newDir);

  console.log("\nMigration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
