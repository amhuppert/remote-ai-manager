/**
 * Whole-worktree boundary for supervised seats. Owned and read-only scopes are
 * task contracts; they never narrow the backend's writable paths inside the
 * assigned worktree. Scratch payloads live in its ignored .cc namespace.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import type { FsWriteRestrictionSupport } from "@/lib/agent-backends/descriptor";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { TurnWrites } from "./schemas";
import {
  isInsideLanePath,
  toLanePathSegment,
} from "@/lib/workspace/lane-path-segments";
import {
  DEFAULT_LANE_TMP_ROOT_DIR,
  laneTmpDirBudgetViolation,
  laneTmpDirName,
} from "@/lib/workspace/lane-tmp-dir";

export interface ImplementerLaneWriteEnvelope {
  policy: FsWritePolicy;
  worktreeRoot: string;
  /** Fixed-width name: sandbox bridge sockets must fit the AF_UNIX budget. */
  contextTmpDir: string;
  /** Per-seat payload directory inside the assigned worktree. */
  payloadDir: string;
}

export interface ComposeImplementerLaneWriteEnvelopeInput {
  executionId: string;
  contextId: string;
  worktreePath: string;
}

export interface ImplementerLaneWriteEnvelopeDeps {
  tmpRootDir?: string;
  ensureDir?(dir: string): void;
  realpath?(target: string): string;
  exists?(target: string): boolean;
}

function fail(reason: string): never {
  throw new Error(`Cannot establish the worktree write boundary: ${reason}`);
}

/** Resolve the existing ancestor before creating a path, so symlinks cannot widen it. */
function canonicalizeUnderExisting(
  target: string,
  exists: (target: string) => boolean,
  realpath: (target: string) => string,
): string {
  const missing: string[] = [];
  let cursor = target;
  while (!exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(realpath(cursor), ...missing);
}

export function composeImplementerLaneWriteEnvelope(
  input: ComposeImplementerLaneWriteEnvelopeInput,
  deps: ImplementerLaneWriteEnvelopeDeps = {},
): ImplementerLaneWriteEnvelope {
  const ensureDir =
    deps.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const realpath = deps.realpath ?? realpathSync;
  const exists = deps.exists ?? existsSync;
  const rawTmpDir = path.join(
    deps.tmpRootDir ?? DEFAULT_LANE_TMP_ROOT_DIR,
    laneTmpDirName("implementer", [input.executionId, input.contextId]),
  );

  try {
    const worktreeRoot = realpath(input.worktreePath);
    const rawPayloadDir = path.join(
      worktreeRoot,
      ".cc",
      "temp",
      toLanePathSegment(input.contextId),
    );
    const resolvedPayloadDir = canonicalizeUnderExisting(
      rawPayloadDir,
      exists,
      realpath,
    );
    if (!isInsideLanePath(worktreeRoot, resolvedPayloadDir)) {
      throw new Error(
        `payload directory "${rawPayloadDir}" resolves outside the worktree`,
      );
    }
    ensureDir(rawPayloadDir);
    ensureDir(rawTmpDir);
    const payloadDir = realpath(rawPayloadDir);
    if (!isInsideLanePath(worktreeRoot, payloadDir)) {
      throw new Error(
        `payload directory "${payloadDir}" resolves outside the worktree`,
      );
    }
    const contextTmpDir = realpath(rawTmpDir);
    const tmpBudgetViolation = laneTmpDirBudgetViolation(contextTmpDir);
    if (tmpBudgetViolation !== null) throw new Error(tmpBudgetViolation);

    return {
      policy: {
        mode: "allowlist",
        // Adapter contract: cwd first, TMPDIR last. No path inside cwd is denied.
        allowWrite: [worktreeRoot, contextTmpDir],
        denyWrite: [],
      },
      worktreeRoot,
      contextTmpDir,
      payloadDir,
    };
  } catch (error) {
    fail(getErrorMessage(error));
  }
}

export function renderWriteEnvelopeBriefing(
  envelope: ImplementerLaneWriteEnvelope,
  restriction: FsWriteRestrictionSupport,
  writes: TurnWrites,
): string {
  return [
    "# Working directory and task scope",
    "",
    `Working directory: ${envelope.worktreeRoot}`,
    `Payload directory (write --file JSON and temporary files here): ${envelope.payloadDir}`,
    "",
    restriction === "instruction-only"
      ? "Keep writes inside this worktree and its temporary directory. This boundary is instruction-only."
      : "The filesystem boundary permits the whole assigned worktree and its temporary directory.",
    "Task scope is a coordination contract; it is not a filesystem restriction inside the worktree.",
    writes.mode === "none"
      ? "This task is read-only: do not change project files. Use the payload directory for temporary files."
      : writes.mode === "paths"
        ? `Keep the task's changes within: ${writes.paths.map((entry) => `\`${entry}\``).join(", ")}. Preserve other work in this worktree.`
        : "Preserve other work in this worktree.",
  ].join("\n");
}
