import fs from "node:fs";
import path from "node:path";
import { debugInstrumentationManifestSchema } from "@/lib/schemas";
import type { DebugLogEntry, DebugInstrumentationManifest } from "@/types";

const DEBUG_DIR = ".debug";
const LOG_FILE = "logs.jsonl";
const MANIFEST_FILE = "instrumentation.json";

/** Returns the debug log ingestion URL for use in system prompts. */
export function getDebugLogUrl(conversationId: string): string {
  const host = process.env.CC_HOST ?? "localhost";
  const port = process.env.PORT ?? "3000";
  return `http://${host}:${port}/api/debug-logs?conversationId=${conversationId}`;
}

/** Creates .debug/ directory in the worktree if it doesn't exist. Returns the absolute path. */
export function ensureDebugDir(worktreePath: string): string {
  const debugDir = path.join(worktreePath, DEBUG_DIR);
  fs.mkdirSync(debugDir, { recursive: true });
  return debugDir;
}

/** Returns the absolute path to .debug/logs.jsonl in the worktree. */
export function getDebugLogPath(worktreePath: string): string {
  return path.join(worktreePath, DEBUG_DIR, LOG_FILE);
}

/** Appends a single NDJSON entry to the debug log file. */
export function appendDebugLogEntry(
  logFilePath: string,
  entry: DebugLogEntry,
): void {
  fs.appendFileSync(logFilePath, JSON.stringify(entry) + "\n", "utf-8");
}

/** Truncates the debug log file to empty. No-op if the file doesn't exist. */
export function clearDebugLog(logFilePath: string): void {
  try {
    fs.writeFileSync(logFilePath, "", "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Returns entry count and unique hypothesis IDs without full parsing. */
export function getDebugLogStats(logFilePath: string): {
  entryCount: number;
  hypothesesSeen: string[];
} {
  let content: string;
  try {
    content = fs.readFileSync(logFilePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entryCount: 0, hypothesesSeen: [] };
    }
    throw err;
  }

  const lines = content.trim().split("\n").filter(Boolean);
  const hypotheses = new Set<string>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { hypothesisId?: string | null };
      if (entry.hypothesisId) {
        hypotheses.add(entry.hypothesisId);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    entryCount: lines.length,
    hypothesesSeen: Array.from(hypotheses),
  };
}

// ============================================================
// Instrumentation Manifest (.debug/instrumentation.json)
// ============================================================

/** Returns the absolute path to .debug/instrumentation.json in the worktree. */
export function getManifestPath(worktreePath: string): string {
  return path.join(worktreePath, DEBUG_DIR, MANIFEST_FILE);
}

/** Reads and validates the instrumentation manifest. Returns null if not found. */
export function readManifest(
  worktreePath: string,
): DebugInstrumentationManifest | null {
  const manifestPath = getManifestPath(worktreePath);
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return debugInstrumentationManifestSchema.parse(JSON.parse(raw));
}

/** Deletes the instrumentation manifest. No-op if it doesn't exist. */
export function deleteManifest(worktreePath: string): void {
  try {
    fs.unlinkSync(getManifestPath(worktreePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
