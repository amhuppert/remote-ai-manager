/**
 * Per-workflow collaboration artifacts sidecar store.
 *
 * Collaboration phase outputs (`initial_draft`, `cross_review`,
 * `proposed_changes`, `counter_proposal`, `resolution_decision`,
 * `open_conflicts`, `final_answer`) form an unbounded append-only stream over
 * a run. Persisting that stream inside the SQLite envelope blob means every
 * lifecycle `upsert` re-serializes the whole array — the root of the
 * `workflow_envelopes` write cost. This module moves the stream out to a
 * durable per-workflow JSONL sidecar file, mirroring how conversation
 * transcripts already work (`@/lib/prompt/transcript`): the file lives under
 * the OS config dir (`<configDir>/collab-artifacts/<workflowId>.jsonl`),
 * OUTSIDE the session worktree, so it is durable across worktree removal and
 * process restart.
 *
 * The envelope blob keeps only bounded lifecycle/config state; consumers that
 * need the stream read it back from the sidecar.
 *
 * The store is generic over the entry shape because the two collaboration
 * paths persist different shapes:
 *
 *  - the user-invoked path (`envelope.ts`) appends raw `CollaborationArtifact`
 *    values (including `open_conflicts`, which is load-bearing for resume),
 *  - the graph-workflow path (`workflow-envelope.ts`) appends
 *    `CollaborationWorkflowArtifactEntry` wrappers.
 *
 * Readers supply the schema for the shape they expect; malformed lines are
 * skipped (and logged) rather than failing the whole read.
 */

import { appendFile, readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { parseJsonlWithIndex } from "@/lib/shared/read-jsonl";

const logger = createLogger("workflows.collaboration.artifacts");

const ARTIFACTS_DIRNAME = "collab-artifacts";

function getCollaborationArtifactsDir(configDir?: string): string {
  return path.join(configDir ?? getConfigDirPath(), ARTIFACTS_DIRNAME);
}

async function ensureCollaborationArtifactsDir(
  configDir?: string,
): Promise<void> {
  const dir = getCollaborationArtifactsDir(configDir);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Absolute path to the sidecar JSONL file for a workflow's artifact stream.
 * Lives under `<configDir>/collab-artifacts/` so it survives worktree removal
 * exactly like transcripts. Ensures the parent directory exists.
 */
export async function getCollaborationArtifactsPath(
  workflowId: string,
  configDir?: string,
): Promise<string> {
  await ensureCollaborationArtifactsDir(configDir);
  return path.join(
    getCollaborationArtifactsDir(configDir),
    `${workflowId}.jsonl`,
  );
}

/**
 * Append a single artifact entry to the workflow's sidecar as one JSONL line.
 * The append is the durability sink; the run keeps its own in-memory
 * accumulator as the in-run source of truth (see `envelope.ts`).
 */
export async function appendCollaborationArtifact(
  workflowId: string,
  entry: unknown,
  configDir?: string,
): Promise<void> {
  const filePath = await getCollaborationArtifactsPath(workflowId, configDir);
  const line = JSON.stringify(entry) + "\n";
  await appendFile(filePath, line, "utf-8");
  logger.debug("collaboration.artifacts.appended", {
    workflowId,
    bytes: line.length,
  });
}

/** A source line that parsed as JSON but failed schema validation, with its
 * TRUE zero-based index in the sidecar file (counting skipped blank/malformed
 * lines) so a diagnostic can name the on-disk line to repair. */
export interface ArtifactInvalidLine {
  lineIndex: number;
  issues: string;
}

/** A source line that failed `JSON.parse`, with its true zero-based index. */
export interface ArtifactParseFailure {
  lineIndex: number;
  error: string;
}

export interface ParsedArtifactLines<T> {
  entries: T[];
  parseFailures: ArtifactParseFailure[];
  invalidLines: ArtifactInvalidLine[];
}

/**
 * Parse and schema-validate a sidecar JSONL blob, keeping the TRUE source line
 * index for every skipped line. Pure over its inputs (no I/O, no logging) so
 * the diagnostic-coordinate behavior is directly testable: a schema-invalid
 * line preceded by blank/malformed lines must report its original file line,
 * not the compacted array position.
 */
export function parseAndValidateArtifactLines<T>(
  raw: string,
  schema: z.ZodType<T>,
): ParsedArtifactLines<T> {
  const entries: T[] = [];
  const parseFailures: ArtifactParseFailure[] = [];
  const invalidLines: ArtifactInvalidLine[] = [];

  const parsedLines = parseJsonlWithIndex(raw, {
    onError: (_line, lineIndex, err) => {
      parseFailures.push({ lineIndex, error: getErrorMessage(err) });
    },
  });
  for (const { value, lineIndex } of parsedLines) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      invalidLines.push({
        lineIndex,
        issues: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
          .join("; "),
      });
      continue;
    }
    entries.push(parsed.data);
  }

  return { entries, parseFailures, invalidLines };
}

/**
 * Read a workflow's artifact stream back from its sidecar, in append order.
 *
 * Returns `[]` when the file is absent (no artifacts written yet, or the run
 * never produced any). Each non-empty line is parsed and validated through
 * `schema`; malformed lines are skipped and logged rather than failing the
 * whole read, so a single corrupt line cannot strand a resume or hydration.
 */
export async function readCollaborationArtifacts<T>(
  workflowId: string,
  schema: z.ZodType<T>,
  configDir?: string,
): Promise<T[]> {
  const filePath = await getCollaborationArtifactsPath(workflowId, configDir);
  if (!existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    logger.warn("collaboration.artifacts.read_failed", {
      workflowId,
      filePath,
      error: getErrorMessage(err),
    });
    return [];
  }

  const { entries, parseFailures, invalidLines } =
    parseAndValidateArtifactLines(raw, schema);

  for (const failure of parseFailures) {
    logger.warn("collaboration.artifacts.line_parse_failed", {
      workflowId,
      lineIndex: failure.lineIndex,
      error: failure.error,
    });
  }
  for (const invalid of invalidLines) {
    logger.warn("collaboration.artifacts.line_invalid", {
      workflowId,
      lineIndex: invalid.lineIndex,
      issues: invalid.issues,
    });
  }

  logger.debug("collaboration.artifacts.read", {
    workflowId,
    entryCount: entries.length,
  });
  return entries;
}

/**
 * The strict read: the same stream, but with absence, I/O failure, and skipped
 * lines kept apart.
 *
 * `readCollaborationArtifacts` collapses all three into `[]`, which is right
 * for a display path — a hydration that shows nothing beats one that throws.
 * It is wrong for resume, where `[]` means "fresh run, do everything again":
 * a transient read failure would re-dispatch a completed run, and a dropped
 * interior line would splice a fresh upstream output onto stale downstream
 * artifacts derived from a different one. Resume consumes this reader and
 * refuses on anything but `ok` with nothing skipped.
 */
export type CollaborationArtifactStreamRead<T> =
  | { kind: "absent" }
  | { kind: "ok"; entries: T[]; skipped: number[] }
  | { kind: "unreadable"; error: string };

export async function readCollaborationArtifactStream<T>(
  workflowId: string,
  schema: z.ZodType<T>,
  configDir?: string,
): Promise<CollaborationArtifactStreamRead<T>> {
  const filePath = await getCollaborationArtifactsPath(workflowId, configDir);
  if (!existsSync(filePath)) return { kind: "absent" };

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    const error = getErrorMessage(err);
    logger.warn("collaboration.artifacts.strict_read_failed", {
      workflowId,
      filePath,
      error,
    });
    return { kind: "unreadable", error };
  }

  const { entries, parseFailures, invalidLines } =
    parseAndValidateArtifactLines(raw, schema);
  const skipped = [
    ...parseFailures.map((f) => f.lineIndex),
    ...invalidLines.map((l) => l.lineIndex),
  ].sort((a, b) => a - b);

  if (skipped.length > 0) {
    logger.warn("collaboration.artifacts.strict_read_skipped_lines", {
      workflowId,
      skippedLineIndexes: skipped,
    });
  }

  return { kind: "ok", entries, skipped };
}

/**
 * Remove a workflow's sidecar file. Best-effort and idempotent: a missing
 * file is not an error. Invoked from session deletion alongside transcript
 * removal so artifact files do not outlive their session.
 */
export async function deleteCollaborationArtifacts(
  workflowId: string,
  configDir?: string,
): Promise<void> {
  const filePath = await getCollaborationArtifactsPath(workflowId, configDir);
  await rm(filePath, { force: true });
  logger.debug("collaboration.artifacts.deleted", { workflowId });
}
