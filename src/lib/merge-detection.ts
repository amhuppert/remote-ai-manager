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
import { stopAllForSession } from "./dev-server-registry";
import {
  broadcast as defaultBroadcast,
  type BroadcastFn,
} from "./sse-broadcaster";
import { createLogger } from "./logging";
import { getErrorMessage } from "@/lib/errors";
import type { SessionFinishedEvent } from "@/types";

import { getGlobalValue, setGlobalValue } from "./global-singleton";

const logger = createLogger("merge-detection");

// ============================================================
// globalThis Singleton (HMR-safe)
// ============================================================

const INTERVAL_KEY = "__cc_merge_detection_interval" as const;

function getInterval(): ReturnType<typeof setInterval> | null {
  return getGlobalValue<ReturnType<typeof setInterval>>(INTERVAL_KEY) ?? null;
}

function setIntervalRef(ref: ReturnType<typeof setInterval> | null): void {
  setGlobalValue(INTERVAL_KEY, ref);
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
export async function checkAllSessionsForMerge(
  broadcast: BroadcastFn = defaultBroadcast,
): Promise<number> {
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

          // Stop all dev servers before marking session as finished (best-effort)
          try {
            await stopAllForSession({ projectPath, sessionName });
          } catch {
            // best-effort: don't block merge detection
          }

          await setSessionFinished(projectPath, sessionName);
          logger.info("merge-detection.persisted", {
            sessionName,
            branchName,
            method: "ancestor",
          });
          broadcastSessionFinished(
            projectPath,
            sessionName,
            branchName,
            "ancestor",
            broadcast,
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

          // Stop all dev servers before marking session as finished (best-effort)
          try {
            await stopAllForSession({ projectPath, sessionName });
          } catch {
            // best-effort: don't block merge detection
          }

          await setSessionFinished(projectPath, sessionName);
          logger.info("merge-detection.persisted", {
            sessionName,
            branchName,
            method: "commit-message",
          });
          broadcastSessionFinished(
            projectPath,
            sessionName,
            branchName,
            "commit-message",
            broadcast,
          );
          detectedCount++;
        }
      } catch (err) {
        logger.warn("merge-detection.check_failed", {
          projectPath,
          sessionName,
          branchName,
          error: getErrorMessage(err),
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
  broadcast: BroadcastFn,
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
      error: getErrorMessage(err),
    });
  });

  // Schedule recurring checks
  const ref = setInterval(() => {
    void checkAllSessionsForMerge().catch((err) => {
      logger.error("merge-detection.cycle_failed", {
        error: getErrorMessage(err),
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
