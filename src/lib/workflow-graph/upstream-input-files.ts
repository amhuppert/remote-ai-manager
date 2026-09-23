/**
 * Upstream payloads written as files for the context that receives them, so an
 * agent can script over its inputs instead of re-typing the JSON its prompt
 * carries. The files go in the context's own payload directory — private
 * scratch for a read-only reader, never the shared session worktree its
 * siblings read — and hold exactly what `resolveUpstreamInputs` delivered.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextPlacement } from "./definition-schemas";
import type { GraphWorkflowUpstreamInput } from "./context-outputs";
import {
  contextPayloadDirectory,
  type ImplementerLaneWriteEnvelopeDeps,
} from "./implementer-lane-write-envelope";
import { toLanePathSegment } from "./lane-path-segments";

const INPUTS_DIR_NAME = "inputs";

/**
 * Write each delivered payload as `<source-context>.json` and return the
 * directory, or null when no predecessor delivered one. The directory is
 * engine-owned and rewritten whole, so a payload that no longer arrives does
 * not linger from an earlier iteration.
 */
export function writeUpstreamInputFiles(
  input: {
    executionId: string;
    contextId: string;
    placementMode: ContextPlacement["mode"];
    worktreePath: string;
    inputs: readonly GraphWorkflowUpstreamInput[];
  },
  deps: Pick<ImplementerLaneWriteEnvelopeDeps, "scratchRootDir"> = {},
): string | null {
  const delivered = input.inputs.filter(
    (entry) => !entry.skipped && entry.output !== null,
  );
  const directory = path.join(
    contextPayloadDirectory(input, deps),
    INPUTS_DIR_NAME,
  );
  rmSync(directory, { recursive: true, force: true });
  if (delivered.length === 0) return null;
  mkdirSync(directory, { recursive: true });
  for (const entry of delivered) {
    writeFileSync(
      path.join(directory, `${toLanePathSegment(entry.contextId)}.json`),
      `${JSON.stringify(entry.output, null, 2)}\n`,
    );
  }
  return directory;
}
