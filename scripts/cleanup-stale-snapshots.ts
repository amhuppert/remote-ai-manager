#!/usr/bin/env bun
/**
 * One-time cleanup for conversation state left over from crash-loops.
 *
 * Symptom this fixes: state.json bloats with persisted XState machine
 * snapshots that were captured mid-execution (e.g. `value: {executing: "running"}`)
 * because a server crash interrupted the conversation. The SDK invocation
 * behind those snapshots is dead — they cannot resume — so the snapshot is
 * dead weight and the conversation's `status: "running"` is misleading.
 *
 * The cleanup:
 *   1. Backs up state.json next to itself.
 *   2. For every conversation, checks the persisted machineSnapshot:
 *        - resumable iff `status === "active"` AND
 *          `context.pendingQuestion != null` (waiting on a permission
 *          answer) — these are kept untouched.
 *        - everything else gets `machineSnapshot` cleared.
 *   3. If the conversation's surface status is stuck on
 *      "running"/"waiting_for_input" AND its snapshot wasn't resumable,
 *      resets status to "awaiting" and clears any stale pendingQuestion
 *      fields.
 *   4. Atomically rewrites state.json.
 *
 * Safe to run multiple times. Run: bun scripts/cleanup-stale-snapshots.ts
 */

import { existsSync } from "node:fs";
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { readConfig } from "../src/lib/config";

interface CleanupSummary {
  conversationsScanned: number;
  snapshotsCleared: number;
  resumableSnapshotsPreserved: number;
  statusesReset: number;
  bytesBefore: number;
  bytesAfter: number;
  changed: boolean;
  backupPath: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSnapshotResumable(snapshot: unknown): boolean {
  if (!isRecord(snapshot)) return false;
  if (snapshot["status"] !== "active") return false;
  const context = snapshot["context"];
  if (!isRecord(context)) return false;
  return context["pendingQuestion"] != null;
}

function cleanState(rawState: unknown): {
  rewritten: unknown;
  changed: boolean;
  summary: Pick<
    CleanupSummary,
    | "conversationsScanned"
    | "snapshotsCleared"
    | "resumableSnapshotsPreserved"
    | "statusesReset"
  >;
} {
  const state = structuredClone(rawState);
  const summary = {
    conversationsScanned: 0,
    snapshotsCleared: 0,
    resumableSnapshotsPreserved: 0,
    statusesReset: 0,
  };
  let changed = false;

  if (!isRecord(state)) return { rewritten: state, changed, summary };
  const projects = state["projects"];
  if (!isRecord(projects)) return { rewritten: state, changed, summary };

  for (const project of Object.values(projects)) {
    if (!isRecord(project)) continue;
    const sessions = project["sessions"];
    if (!isRecord(sessions)) continue;

    for (const session of Object.values(sessions)) {
      if (!isRecord(session)) continue;
      const conversations = session["conversations"];
      if (!Array.isArray(conversations)) continue;

      for (const conv of conversations) {
        if (!isRecord(conv)) continue;
        summary.conversationsScanned += 1;

        const snap = conv["machineSnapshot"];
        const hasSnap = snap != null;
        const resumable = hasSnap && isSnapshotResumable(snap);
        const staleStatus =
          conv["status"] === "running" ||
          conv["status"] === "waiting_for_input";

        if (hasSnap && !resumable) {
          conv["machineSnapshot"] = null;
          summary.snapshotsCleared += 1;
          changed = true;
        } else if (resumable) {
          summary.resumableSnapshotsPreserved += 1;
        }

        if (staleStatus && !resumable) {
          conv["status"] = "awaiting";
          conv["pendingQuestionId"] = null;
          conv["pendingQuestions"] = null;
          summary.statusesReset += 1;
          changed = true;
        }
      }
    }
  }

  return { rewritten: state, changed, summary };
}

async function backupStateFile(stateFilePath: string): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace(/-/g, "");
  const backupPath = `${stateFilePath}.cleanup-stale-snapshots.bak.${timestamp}`;
  await copyFile(stateFilePath, backupPath);
  return backupPath;
}

async function main(): Promise<void> {
  const config = await readConfig();
  const stateFilePath = config.stateFilePath;

  console.log("Stale Snapshot Cleanup\n");
  console.log(`State file: ${stateFilePath}\n`);

  if (!existsSync(stateFilePath)) {
    console.log("No state file found — nothing to clean.");
    return;
  }

  const bytesBefore = (await stat(stateFilePath)).size;
  const raw = await readFile(stateFilePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`State file is not valid JSON: ${message}`);
  }

  const { rewritten, changed, summary } = cleanState(parsed);

  let backupPath: string | null = null;
  let bytesAfter = bytesBefore;

  if (changed) {
    backupPath = await backupStateFile(stateFilePath);
    const tmpPath = `${stateFilePath}.tmp.${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(rewritten, null, 2), "utf-8");
    await rename(tmpPath, stateFilePath);
    bytesAfter = (await stat(stateFilePath)).size;
  }

  const result: CleanupSummary = {
    ...summary,
    bytesBefore,
    bytesAfter,
    changed,
    backupPath,
  };

  const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  console.log("Result:");
  console.log(`  Conversations scanned:        ${result.conversationsScanned}`);
  console.log(`  Snapshots cleared:            ${result.snapshotsCleared}`);
  console.log(
    `  Resumable snapshots kept:     ${result.resumableSnapshotsPreserved}`,
  );
  console.log(`  Statuses reset to "awaiting": ${result.statusesReset}`);
  console.log(`  State file size before:       ${fmtMB(result.bytesBefore)}`);
  console.log(`  State file size after:        ${fmtMB(result.bytesAfter)}`);
  console.log(
    `  State file rewritten:         ${result.changed ? "yes" : "no (already clean)"}`,
  );
  if (result.backupPath) {
    console.log(`  Backup written to:            ${result.backupPath}`);
  }
  console.log("\nDone.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Cleanup failed:", message);
  process.exit(1);
});
