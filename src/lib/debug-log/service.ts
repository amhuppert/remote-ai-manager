import fs from "node:fs";
import path from "node:path";
import { debugInstrumentationManifestSchema } from "@/lib/debug-log/schemas";
import type {
  DebugLogEntry,
  DebugInstrumentationManifest,
} from "@/lib/debug-log/schemas";
const DEBUG_DIR = ".debug";
const LOG_FILE = "logs.jsonl";
const MANIFEST_FILE = "instrumentation.json";

/**
 * Returns the debug log ingestion URL for use in system prompts.
 *
 * Honors `CC_PUBLIC_URL` when set (e.g. `https://my-host.tailscale.ts.net:3000`)
 * so remote/Tailscale clients can POST back. Falls back to
 * `http://${CC_HOST ?? localhost}:${PORT ?? 3000}` for local dev.
 *
 * The `bun run dev` script sets `PORT` explicitly (defaulting to 3000) and
 * passes the same value to `next dev -p`, so this fallback always reports
 * the port the server is actually listening on. When running a second CC
 * (e.g. self-debugging), start it with `PORT=3001 bun run dev` so log POSTs
 * land on the CC instance the user is operating, not the main one.
 */
/** @public Accessed via dynamic `import()` in actor-implementations. */
export function getDebugLogUrl(conversationId: string): string {
  const baseUrl = process.env.CC_PUBLIC_URL;
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/api/debug-logs?conversationId=${conversationId}`;
  }
  const host = process.env.CC_HOST ?? "localhost";
  const port = process.env.PORT ?? "3000";
  return `http://${host}:${port}/api/debug-logs?conversationId=${conversationId}`;
}

/**
 * Creates `.debug/<conversationId>/` directory in the worktree if it doesn't
 * exist. Returns the absolute path to the per-conversation debug directory.
 */
export function ensureDebugDir(
  worktreePath: string,
  conversationId: string,
): string {
  const debugDir = path.join(worktreePath, DEBUG_DIR, conversationId);
  fs.mkdirSync(debugDir, { recursive: true });
  return debugDir;
}

/** Returns the absolute path to `.debug/<conversationId>/logs.jsonl`. */
export function getDebugLogPath(
  worktreePath: string,
  conversationId: string,
): string {
  return path.join(worktreePath, DEBUG_DIR, conversationId, LOG_FILE);
}

/**
 * Returns the absolute path to `.debug/<conversationId>/instrumentation.json`.
 */
export function getDebugManifestPath(
  worktreePath: string,
  conversationId: string,
): string {
  return path.join(worktreePath, DEBUG_DIR, conversationId, MANIFEST_FILE);
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
// Instrumentation Manifest (.debug/<conversationId>/instrumentation.json)
// ============================================================

/** Reads and validates the instrumentation manifest. Returns null if not found. */
export function readManifest(
  worktreePath: string,
  conversationId: string,
): DebugInstrumentationManifest | null {
  const manifestPath = getDebugManifestPath(worktreePath, conversationId);
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
export function deleteManifest(
  worktreePath: string,
  conversationId: string,
): void {
  try {
    fs.unlinkSync(getDebugManifestPath(worktreePath, conversationId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export interface CleanupReport {
  removedInstrumentation: boolean;
  filesModified: string[];
  grepVerificationPassed: boolean;
  acknowledgesManifestDeletionContract: boolean;
  notes: string;
}

export interface CleanupVerificationResult {
  ok: boolean;
  failedConditions: string[];
  missingFiles: string[];
  remediationPrompt: string | null;
}

/**
 * Cross-check the agent's self-reported cleanup result against the
 * persisted instrumentation manifest. The agent is not trusted to advance
 * cleanup unilaterally — every probe file declared in the manifest must
 * appear in `filesModified`, and every boolean self-report must be true.
 *
 * On a passing verification the caller (the verifyCleanup actor) is
 * expected to delete the manifest as a separate step; this helper is
 * pure (no filesystem mutation beyond the manifest read).
 */
export function verifyCleanupAgainstManifest(
  worktreePath: string,
  conversationId: string,
  cleanup: CleanupReport,
): CleanupVerificationResult {
  const failedConditions: string[] = [];
  const missingFiles: string[] = [];

  if (!cleanup.removedInstrumentation) {
    failedConditions.push("removedInstrumentation must be true");
  }
  if (!cleanup.grepVerificationPassed) {
    failedConditions.push("grepVerificationPassed must be true");
  }
  if (!cleanup.acknowledgesManifestDeletionContract) {
    failedConditions.push("acknowledgesManifestDeletionContract must be true");
  }

  let manifest: DebugInstrumentationManifest | null;
  try {
    manifest = readManifest(worktreePath, conversationId);
  } catch (err) {
    return {
      ok: false,
      failedConditions: [
        `instrumentation manifest is malformed: ${(err as Error).message}`,
      ],
      missingFiles: [],
      remediationPrompt: buildRemediationPrompt(
        [`instrumentation manifest is malformed: ${(err as Error).message}`],
        [],
      ),
    };
  }

  if (manifest === null) {
    failedConditions.push(
      "instrumentation manifest is missing — cannot verify cleanup",
    );
  } else {
    const reported = new Set(cleanup.filesModified);
    const expected = new Set(manifest.probes.map((p) => p.file));
    for (const file of expected) {
      if (!reported.has(file)) {
        missingFiles.push(file);
      }
    }
  }

  const ok = failedConditions.length === 0 && missingFiles.length === 0;

  return {
    ok,
    failedConditions,
    missingFiles,
    remediationPrompt: ok
      ? null
      : buildRemediationPrompt(failedConditions, missingFiles),
  };
}

function buildRemediationPrompt(
  failedConditions: string[],
  missingFiles: string[],
): string {
  const lines: string[] = [
    "Cleanup verification failed. Address every issue below and re-run cleanup.",
  ];
  if (failedConditions.length > 0) {
    lines.push("", "Self-reported conditions that did not pass:");
    for (const c of failedConditions) {
      lines.push(`- ${c}`);
    }
  }
  if (missingFiles.length > 0) {
    lines.push(
      "",
      "Probe files declared in .debug/<conversationId>/instrumentation.json that you did not list in `filesModified`:",
    );
    for (const f of missingFiles) {
      lines.push(`- ${f}`);
    }
    lines.push(
      "",
      "Re-open each missing file, remove every `@debug-probe` marker, and rerun the cleanup turn with the complete list.",
    );
  }
  return lines.join("\n");
}
