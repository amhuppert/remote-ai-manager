/**
 * The filesystem-write envelope a validator lane runs under.
 *
 * A validator reviews a FROZEN candidate, so the one thing it must not be able
 * to do is change it. That is a mechanical property, not a prompt one: this
 * module composes the server-derived allowlist the backend adapters translate
 * onto their native sandboxes, and it is the only place the allowlist's shape
 * is decided.
 *
 * Three rules make the composed policy trustworthy:
 *  - the writable paths are CREATED before they are canonicalized, because
 *    `realpath` has nothing to resolve for a path that does not exist and the
 *    backend would then be handed a non-canonical allowlist;
 *  - every path is realpath-normalized with no lexical fallback, because
 *    enforcement compares canonical paths and CC runs where `/tmp` is a symlink
 *    (macOS) and worktrees are routinely reached through symlinked parents;
 *  - path segments come from authored ids, so they are sanitized and the result
 *    is re-checked for containment — an authored context id must not be able to
 *    relocate the one directory a validator may write to.
 *
 * Establishment is fail-closed: anything that prevents a well-formed envelope
 * throws, and the caller turns that into an infrastructure outcome rather than
 * running the lane unrestricted.
 */

import { mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import { isInsideLanePath, toLanePathSegment } from "./lane-path-segments";
import {
  DEFAULT_LANE_TMP_ROOT_DIR,
  laneTmpDirBudgetViolation,
  laneTmpDirName,
} from "./lane-tmp-dir";

/** Root for every lane scratch directory CC creates. */
const SCRATCH_ROOT_DIR_NAME = "cc-validator-lanes";

export interface ValidatorLaneWriteEnvelope {
  policy: FsWritePolicy;
  /** The lane's per-assignment scratch/report directory. */
  laneScratchDir: string;
  /**
   * The lane's private temp directory: a fixed-width digest name under the
   * lane temp root, NOT beneath {@link laneScratchDir} — the run's `$TMPDIR`
   * hosts the sandbox's AF_UNIX bridge sockets, so its length must stay
   * independent of authored ids. See `lane-tmp-dir.ts`.
   */
  laneTmpDir: string;
}

export interface ComposeValidatorLaneWriteEnvelopeInput {
  executionId: string;
  contextId: string;
  /** The cohort member's use-site id — scratch is per assignment, not per context. */
  assignmentId: string;
  /** The candidate worktree under review. Never writable. */
  worktreePath: string;
}

export interface LaneWriteEnvelopeDeps {
  scratchRootDir?: string;
  tmpRootDir?: string;
  ensureDir?(dir: string): void;
  realpath?(target: string): string;
}

export function composeValidatorLaneWriteEnvelope(
  input: ComposeValidatorLaneWriteEnvelopeInput,
  deps: LaneWriteEnvelopeDeps = {},
): ValidatorLaneWriteEnvelope {
  const scratchRootDir =
    deps.scratchRootDir ?? path.join(os.tmpdir(), SCRATCH_ROOT_DIR_NAME);
  const ensureDir =
    deps.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const realpath = deps.realpath ?? realpathSync;

  const rawScratchDir = path.join(
    scratchRootDir,
    toLanePathSegment(input.executionId),
    toLanePathSegment(input.contextId),
    toLanePathSegment(input.assignmentId),
  );
  if (!isInsideLanePath(scratchRootDir, rawScratchDir)) {
    throw new Error(
      `Cannot establish the validator write envelope: lane scratch directory "${rawScratchDir}" escapes "${scratchRootDir}"`,
    );
  }
  const rawTmpDir = path.join(
    deps.tmpRootDir ?? DEFAULT_LANE_TMP_ROOT_DIR,
    laneTmpDirName("validator", [
      input.executionId,
      input.contextId,
      input.assignmentId,
    ]),
  );

  let laneScratchDir: string;
  let laneTmpDir: string;
  let deniedWorktree: string;
  try {
    ensureDir(rawScratchDir);
    ensureDir(rawTmpDir);
    // No lexical fallback on any entry. A path `realpath` cannot resolve is a
    // path whose symlinks are unknown, and the backend compares canonical
    // paths: a lexical allow entry may never match what it is meant to permit,
    // and a lexical deny entry may never match what it is meant to forbid. Both
    // produce an envelope that looks established and enforces something other
    // than the policy, which is precisely what fail-closed exists to prevent.
    laneScratchDir = realpath(rawScratchDir);
    laneTmpDir = realpath(rawTmpDir);
    deniedWorktree = realpath(input.worktreePath);
  } catch (error) {
    throw new Error(
      `Cannot establish the validator write envelope: ${getErrorMessage(error)}`,
    );
  }

  const tmpBudgetViolation = laneTmpDirBudgetViolation(laneTmpDir);
  if (tmpBudgetViolation !== null) {
    throw new Error(
      `Cannot establish the validator write envelope: ${tmpBudgetViolation}`,
    );
  }

  return {
    // Order is part of the contract, not incidental: adapters read the first
    // allow entry as the lane's own root and the last as its temp. See
    // `fsWritePolicySchema`.
    policy: {
      mode: "allowlist",
      allowWrite: [laneScratchDir, laneTmpDir],
      denyWrite: [deniedWorktree],
    },
    laneScratchDir,
    laneTmpDir,
  };
}
