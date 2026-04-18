#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readConfig } from "../src/lib/config";

interface CleanupSummary {
  sessionsScanned: number;
  sessionsCleared: number;
  activeExecutionsCleared: number;
  archivedExecutionsCleared: number;
  workflowsDirRemoved: boolean;
  stateFileRewritten: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clearGraphWorkflowState(rawState: unknown): {
  rewritten: unknown;
  changed: boolean;
  summary: Pick<
    CleanupSummary,
    | "sessionsScanned"
    | "sessionsCleared"
    | "activeExecutionsCleared"
    | "archivedExecutionsCleared"
  >;
} {
  const state = structuredClone(rawState);
  const summary = {
    sessionsScanned: 0,
    sessionsCleared: 0,
    activeExecutionsCleared: 0,
    archivedExecutionsCleared: 0,
  };
  let changed = false;

  if (!isRecord(state)) {
    return { rewritten: state, changed, summary };
  }

  const projects = state["projects"];
  if (!isRecord(projects)) {
    return { rewritten: state, changed, summary };
  }

  for (const project of Object.values(projects)) {
    if (!isRecord(project)) continue;
    const sessions = project["sessions"];
    if (!isRecord(sessions)) continue;

    for (const session of Object.values(sessions)) {
      if (!isRecord(session)) continue;
      summary.sessionsScanned += 1;

      const hadActiveKey = "graphWorkflowExecution" in session;
      const hadHistoryKey = "graphWorkflowExecutionHistory" in session;
      const activeValue = session["graphWorkflowExecution"];
      const historyValue = session["graphWorkflowExecutionHistory"];

      if (activeValue != null) summary.activeExecutionsCleared += 1;
      if (Array.isArray(historyValue) && historyValue.length > 0) {
        summary.archivedExecutionsCleared += historyValue.length;
      }

      if (hadActiveKey || hadHistoryKey) {
        delete session["graphWorkflowExecution"];
        delete session["graphWorkflowExecutionHistory"];
        summary.sessionsCleared += 1;
        changed = true;
      }
    }
  }

  return { rewritten: state, changed, summary };
}

async function cleanStateFile(stateFilePath: string): Promise<{
  stateFileRewritten: boolean;
  sessionsScanned: number;
  sessionsCleared: number;
  activeExecutionsCleared: number;
  archivedExecutionsCleared: number;
}> {
  if (!existsSync(stateFilePath)) {
    console.log(`State file not found at ${stateFilePath} — skipping.`);
    return {
      stateFileRewritten: false,
      sessionsScanned: 0,
      sessionsCleared: 0,
      activeExecutionsCleared: 0,
      archivedExecutionsCleared: 0,
    };
  }

  const raw = await readFile(stateFilePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`State file is not valid JSON: ${message}`);
  }

  const { rewritten, changed, summary } = clearGraphWorkflowState(parsed);

  if (changed) {
    const tmpPath = `${stateFilePath}.tmp.${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(rewritten, null, 2), "utf-8");
    await rename(tmpPath, stateFilePath);
  }

  return { stateFileRewritten: changed, ...summary };
}

async function removeWorkflowsDir(workflowsDir: string): Promise<boolean> {
  if (!existsSync(workflowsDir)) {
    return false;
  }
  await rm(workflowsDir, { recursive: true, force: true });
  return true;
}

async function main(): Promise<void> {
  const config = await readConfig();
  const stateFilePath = config.stateFilePath;
  const configDir = path.dirname(stateFilePath);
  const workflowsDir = path.join(configDir, "workflows");

  console.log("Graph Workflow State Cleanup\n");
  console.log(`State file:    ${stateFilePath}`);
  console.log(`Workflows dir: ${workflowsDir}\n`);

  const stateResult = await cleanStateFile(stateFilePath);
  const workflowsDirRemoved = await removeWorkflowsDir(workflowsDir);

  const summary: CleanupSummary = {
    ...stateResult,
    workflowsDirRemoved,
  };

  console.log("Result:");
  console.log(`  Sessions scanned:            ${summary.sessionsScanned}`);
  console.log(`  Sessions cleared:            ${summary.sessionsCleared}`);
  console.log(
    `  Active executions cleared:   ${summary.activeExecutionsCleared}`,
  );
  console.log(
    `  Archived executions cleared: ${summary.archivedExecutionsCleared}`,
  );
  console.log(
    `  State file rewritten:        ${summary.stateFileRewritten ? "yes" : "no (already clean)"}`,
  );
  console.log(
    `  Workflows dir removed:       ${summary.workflowsDirRemoved ? "yes" : "no (did not exist)"}`,
  );
  console.log("\nDone.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Cleanup failed:", message);
  process.exit(1);
});
