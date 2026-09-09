/**
 * Reading this run's structured log as evidence.
 *
 * The probe settles its continuity claims against durable state, and the log
 * the run wrote is part of that state: it records what the runtime factory was
 * actually handed, which no after-the-fact reading of a conversation row can
 * recover.
 */

import { readFileSync } from "node:fs";

export interface LogLine {
  message?: string;
  operationId?: string;
  conversationId?: string;
  hasResumeRef?: boolean;
  costUsd?: number | null;
}

/** One `checkpoint.fresh_runtime`, with how its runtime was created. */
export interface CheckpointRuntimeCreation {
  /** Null when no creation line precedes the fresh-runtime line. */
  hasResumeRef: boolean | null;
}

/** The structured log at this config directory, as parsed records. */
export function readRunLog(configDir: string): LogLine[] {
  let raw: string;
  try {
    raw = readFileSync(`${configDir}/logs/global.log`, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogLine];
      } catch {
        return [];
      }
    });
}

export function countEvents(
  log: readonly LogLine[],
  message: string,
  operationId?: string,
): number {
  return log.filter(
    (line) =>
      line.message === message &&
      (operationId === undefined || line.operationId === operationId),
  ).length;
}

/**
 * How each runtime created to receive this checkpoint's seed was created.
 *
 * `checkpoint.fresh_runtime` names the operation but not the handle; the
 * `prompt.runtime_create` immediately before it is the same creation, and its
 * `hasResumeRef` is the direct observation R9.4 asks for — that the continued
 * conversation neither resumed nor forked the retired provider session. A
 * fresh-runtime line on its own would still be written by a delivery that
 * resumed, which is exactly the failure worth being able to see.
 */
export function checkpointRuntimeCreations(
  log: readonly LogLine[],
  operationId: string,
): readonly CheckpointRuntimeCreation[] {
  const creations: CheckpointRuntimeCreation[] = [];
  log.forEach((line, index) => {
    if (
      line.message !== "checkpoint.fresh_runtime" ||
      line.operationId !== operationId
    ) {
      return;
    }
    for (let back = index - 1; back >= 0; back -= 1) {
      const candidate = log[back];
      if (candidate?.message === "prompt.runtime_create") {
        creations.push({ hasResumeRef: candidate.hasResumeRef ?? null });
        return;
      }
    }
    creations.push({ hasResumeRef: null });
  });
  return creations;
}

/**
 * The cost of each completed ordinary turn, in the order the actor settled
 * them.
 *
 * A turn the probe submits itself reports its cost on the handle it holds. A
 * turn delivered from the queue settles inside the conversation actor, which
 * owns no handle the caller can await — but the actor records the same
 * measurement here. Reading the completions that appear across a drain is what
 * lets a queued delivery report its actual price instead of `unavailable`.
 *
 * `prompt.complete` carries no attempt id, so correlation is positional. That
 * is sound only because the probe drives one conversation at a time in a
 * datastore nothing else writes to; a caller that observes more than one new
 * completion across a drain has lost the correlation and must not guess.
 */
export function promptCompletionCosts(
  log: readonly LogLine[],
): readonly (number | null)[] {
  return log
    .filter((line) => line.message === "prompt.complete")
    .map((line) => (typeof line.costUsd === "number" ? line.costUsd : null));
}
