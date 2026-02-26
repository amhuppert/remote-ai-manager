/**
 * Background merge detection — periodically checks whether session
 * branches have been merged into local main and marks them finished.
 *
 * Uses a globalThis singleton for HMR-safe interval management.
 */

import path from "node:path";
import { readState, setSessionFinished } from "./state";
import { readConfig } from "./config";
import {
  isBranchAncestorOfMain,
  isBranchMentionedInMainLog,
} from "./git-operations";
import { broadcast } from "./sse-broadcaster";
import { createLogger } from "./logging";
import type { SessionFinishedEvent } from "@/types";

const logger = createLogger("merge-detection");

// ============================================================
// globalThis Singleton (HMR-safe)
// ============================================================

const INTERVAL_KEY = "__csm_merge_detection_interval" as const;

function getInterval(): ReturnType<typeof setInterval> | null {
  const g = globalThis as unknown as Record<string, unknown>;
  return (g[INTERVAL_KEY] as ReturnType<typeof setInterval> | null) ?? null;
}

function setIntervalRef(ref: ReturnType<typeof setInterval> | null): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g[INTERVAL_KEY] = ref;
}

// ============================================================
// Core Detection Logic
// ============================================================

/**
 * Check all non-finished sessions across all projects.
 * For each, run the two-strategy detection:
 * 1. git merge-base --is-ancestor <branch> main
 * 2. git log main --grep=<branchName>
 *
 * Returns the number of sessions newly detected as merged.
 */
export async function checkAllSessionsForMerge(): Promise<number> {
  const state = await readState();
  let detectedCount = 0;

  for (const [projectPath, project] of Object.entries(state.projects)) {
    for (const session of Object.values(project.sessions)) {
      if (session.finished) continue;

      const { branchName, sessionName } = session;

      try {
        // Strategy 1: ancestor check (regular merge)
        const isAncestor = await isBranchAncestorOfMain(
          projectPath,
          branchName,
        );

        if (isAncestor) {
          logger.info("merge-detection.detected", {
            projectPath,
            sessionName,
            branchName,
            method: "ancestor",
          });

          await setSessionFinished(projectPath, sessionName);
          broadcastSessionFinished(
            projectPath,
            sessionName,
            branchName,
            "ancestor",
          );
          detectedCount++;
          continue;
        }

        // Strategy 2: commit message search (squash/rebase merge)
        const isMentioned = await isBranchMentionedInMainLog(
          projectPath,
          branchName,
        );

        if (isMentioned) {
          logger.info("merge-detection.detected", {
            projectPath,
            sessionName,
            branchName,
            method: "commit-message",
          });

          await setSessionFinished(projectPath, sessionName);
          broadcastSessionFinished(
            projectPath,
            sessionName,
            branchName,
            "commit-message",
          );
          detectedCount++;
        }
      } catch (err) {
        logger.warn("merge-detection.check_failed", {
          projectPath,
          sessionName,
          branchName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (detectedCount > 0) {
    logger.info("merge-detection.cycle_complete", { detectedCount });
  }

  return detectedCount;
}

// ============================================================
// SSE Broadcast Helper
// ============================================================

function broadcastSessionFinished(
  projectPath: string,
  sessionName: string,
  branchName: string,
  detectionMethod: "ancestor" | "commit-message",
): void {
  const projectName = path.basename(projectPath);

  const event: SessionFinishedEvent = {
    type: "session-finished",
    projectName,
    sessionName,
    branchName,
    detectionMethod,
  };
  broadcast(event);
}

// ============================================================
// Lifecycle — Start / Stop
// ============================================================

/**
 * Start the background merge detection interval.
 * Safe to call multiple times — clears any existing interval first.
 */
export async function startMergeDetection(): Promise<void> {
  stopMergeDetection();

  const config = await readConfig();
  const intervalMs = config.mergeCheckIntervalMs ?? 5 * 60 * 1000;

  logger.info("merge-detection.start", { intervalMs });

  // Fire initial check immediately (fire-and-forget)
  void checkAllSessionsForMerge().catch((err) => {
    logger.error("merge-detection.initial_check_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Schedule recurring checks
  const ref = setInterval(() => {
    void checkAllSessionsForMerge().catch((err) => {
      logger.error("merge-detection.cycle_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  // Unref to avoid keeping the process alive
  if (typeof ref === "object" && "unref" in ref) {
    ref.unref();
  }

  setIntervalRef(ref);
}

/**
 * Stop the background merge detection interval.
 */
export function stopMergeDetection(): void {
  const existing = getInterval();
  if (existing) {
    clearInterval(existing);
    setIntervalRef(null);
    logger.info("merge-detection.stop");
  }
}

/** Reset state for testing — do not use in production */
export function _resetForTesting(): void {
  stopMergeDetection();
}
