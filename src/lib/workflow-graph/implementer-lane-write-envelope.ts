/**
 * The filesystem-write envelope an implementer execution context runs under.
 *
 * Concurrent same-lane contexts share ONE worktree, so what keeps them from
 * overwriting each other has to be mechanical rather than prompted: this module
 * composes the server-derived allowlist the backend adapters translate onto
 * their native sandboxes, and it is the only place the allowlist's shape is
 * decided. Ownership does double duty — write isolation during the turn, and
 * commit scoping when the lane lands.
 *
 * The composition rules, and why each exists:
 *  - the worktree root is canonicalized first, and every owned prefix is
 *    resolved against THAT, because enforcement compares canonical paths and CC
 *    routinely reaches worktrees through symlinked parents (`/tmp` on macOS is
 *    itself one);
 *  - an owned prefix is resolved by realpath-ing its longest EXISTING ancestor
 *    and appending only the missing suffix. One model covers a file, a
 *    directory, and a path the context has not created yet — a per-kind split
 *    would need to know which it is before the turn that decides;
 *  - resolution never creates an owned prefix. A declaration of what a context
 *    may write is not a request to provision it, and a file prefix could not be
 *    provisioned as a directory anyway;
 *  - containment is re-checked AFTER symlink resolution, so an owned path that
 *    is a symlink out of the worktree is refused rather than silently widening
 *    the envelope to wherever it points;
 *  - a write-capable context's payload directory is verified to sit beneath
 *    the worktree's own `.cc` namespace after resolution, for the same reason;
 *    a read-only context instead uses its private scratch root for payloads and
 *    creates no repository directory;
 *  - `.git` is denied unconditionally. An agent that can write it can commit,
 *    branch, or reset the lane out from under the engine, which is precisely
 *    what the envelope exists to make impossible.
 *
 * `allowWrite` order is the backend contract, not incidental: the first entry
 * is the run's writable working root (per-context scratch — the repository
 * target is threaded to the prompt and tooling separately) and the last is its
 * temp. Read-only contexts therefore have exactly those two entries. See
 * `fsWritePolicySchema`.
 *
 * That working root is load-bearing rather than cosmetic, and it is why this
 * envelope does NOT deny the worktree the way the validator's does. Both native
 * sandboxes make the run's working directory writable by construction, so an
 * implementer confined to PART of a worktree has to run from outside it; the
 * alternative — denying the worktree and re-allowing the owned prefixes inside
 * it — is refused upstream by `checkFsWritePolicy`, which will not let a policy
 * both permit and forbid the same subtree. A validator can deny the whole
 * candidate outright because it owns nothing inside it; an implementer cannot.
 *
 * Establishment is fail-closed: anything that prevents a well-formed envelope
 * throws, and the dispatch path turns that into a failed infrastructure outcome
 * rather than running the context unrestricted.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";
import {
  isInsideLanePath,
  isInsideOrEqualLanePath,
  toLanePathSegment,
} from "./lane-path-segments";

/** Root for every implementer scratch directory CC creates. */
const SCRATCH_ROOT_DIR_NAME = "cc-implementer-contexts";

/** The context-temp directory's name beneath its context's scratch directory. */
const CONTEXT_TMP_DIR_NAME = "tmp";

/**
 * The git-ignored namespace inside the worktree where write-capable contexts
 * keep payloads. `.cc` is reserved from authored ownership so the envelope and
 * an authored ownership declaration cannot disagree about who owns it.
 */
const PAYLOAD_NAMESPACE_DIR = ".cc";
const PAYLOAD_PARENT_DIR = "temp";

/** Repository metadata, unwritable regardless of authored ownership. */
const GIT_METADATA_DIR = ".git";

export interface ImplementerLaneWriteEnvelope {
  policy: FsWritePolicy;
  /** The canonical worktree root every owned prefix was resolved against. */
  worktreeRoot: string;
  /** The context's own scratch root — the sandbox's writable working root. */
  contextScratchDir: string;
  /** The context's private temp directory, beneath {@link contextScratchDir}. */
  contextTmpDir: string;
  /** Effective payload location: repository `.cc/temp` or private scratch. */
  payloadDir: string;
  /** The owned prefixes, canonicalized against {@link worktreeRoot}. */
  ownedPrefixes: readonly string[];
}

export interface ComposeImplementerLaneWriteEnvelopeInput {
  executionId: string;
  /** Scratch is per CONTEXT, so concurrent siblings on a lane never share it. */
  contextId: string;
  /** The worktree this context's repository work targets. */
  worktreePath: string;
  /** Authored repo-relative ownership entries; empty for a read-only context. */
  ownedPaths: readonly string[];
  /** Read-only turns keep cctl payloads in scratch and create nothing in-repo. */
  payloadLocation?: "worktree" | "scratch";
}

export interface ImplementerLaneWriteEnvelopeDeps {
  scratchRootDir?: string;
  ensureDir?(dir: string): void;
  realpath?(target: string): string;
  exists?(target: string): boolean;
}

export interface ResolveImplementerContinuationWriteEnvelopeInput {
  executionId: string;
  contextId: string;
  projectPath: string;
  sessionName: string;
  placement: ContextPlacement;
  executionTarget?: { worktreePath: string };
}

export interface ResolveImplementerContinuationWriteEnvelopeDeps {
  composeWriteEnvelope?: typeof composeImplementerLaneWriteEnvelope;
  resolveWorktreePath?(
    projectPath: string,
    sessionName: string,
  ): Promise<string>;
}

export type ImplementerContinuationWriteEnvelopeResolution =
  | {
      ok: true;
      envelope: ImplementerLaneWriteEnvelope | null;
      worktreePath: string | null;
    }
  | { ok: false; error: string; worktreePath: string | null };

function fail(reason: string): never {
  throw new Error(`Cannot establish the implementer write envelope: ${reason}`);
}

/**
 * Canonicalize a path that may not exist yet: realpath the longest ancestor
 * that DOES exist, then append the segments below it verbatim. The one model
 * every owned prefix goes through, whatever it turns out to be on disk.
 */
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
  const resolved = realpath(cursor);
  return missing.length === 0 ? resolved : path.join(resolved, ...missing);
}

export function composeImplementerLaneWriteEnvelope(
  input: ComposeImplementerLaneWriteEnvelopeInput,
  deps: ImplementerLaneWriteEnvelopeDeps = {},
): ImplementerLaneWriteEnvelope {
  const scratchRootDir =
    deps.scratchRootDir ?? path.join(os.tmpdir(), SCRATCH_ROOT_DIR_NAME);
  const ensureDir =
    deps.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const realpath = deps.realpath ?? realpathSync;
  const exists = deps.exists ?? existsSync;

  const contextSegment = toLanePathSegment(input.contextId);
  const rawScratchDir = path.join(
    scratchRootDir,
    toLanePathSegment(input.executionId),
    contextSegment,
  );
  if (!isInsideLanePath(scratchRootDir, rawScratchDir)) {
    fail(
      `context scratch directory "${rawScratchDir}" escapes "${scratchRootDir}"`,
    );
  }
  const rawTmpDir = path.join(rawScratchDir, CONTEXT_TMP_DIR_NAME);

  // The worktree root is resolved directly rather than through
  // `canonicalizeUnderExisting`: a root that is not on disk means lane
  // provisioning did not happen, and inventing a canonical form for it would
  // hand the backend an allowlist pointing at nothing.
  let worktreeRoot: string;
  let contextScratchDir: string;
  let contextTmpDir: string;
  try {
    // Created before canonicalization: `realpath` has nothing to resolve for a
    // path that does not exist, and the backend would then be handed a
    // non-canonical allow entry that may never match what it is meant to permit.
    ensureDir(rawScratchDir);
    ensureDir(rawTmpDir);
    contextScratchDir = realpath(rawScratchDir);
    contextTmpDir = realpath(rawTmpDir);
    worktreeRoot = realpath(input.worktreePath);
  } catch (error) {
    fail(getErrorMessage(error));
  }

  const deniedGitDir = canonicalizeUnderExisting(
    path.join(worktreeRoot, GIT_METADATA_DIR),
    exists,
    realpath,
  );

  const ownedPrefixes = input.ownedPaths.map((ownedPath) => {
    const lexical = path.resolve(worktreeRoot, ownedPath);
    if (!isInsideLanePath(worktreeRoot, lexical)) {
      fail(`owned path "${ownedPath}" escapes the worktree "${worktreeRoot}"`);
    }
    let canonical: string;
    try {
      canonical = canonicalizeUnderExisting(lexical, exists, realpath);
    } catch (error) {
      fail(`owned path "${ownedPath}": ${getErrorMessage(error)}`);
    }
    // Re-checked after resolution: the lexical check above cannot see a symlink
    // that leaves the worktree, and an allow entry outside the root is exactly
    // the widening this envelope exists to refuse.
    if (!isInsideLanePath(worktreeRoot, canonical)) {
      fail(
        `owned path "${ownedPath}" resolves to "${canonical}", outside the worktree "${worktreeRoot}"`,
      );
    }
    if (isInsideOrEqualLanePath(deniedGitDir, canonical)) {
      fail(
        `owned path "${ownedPath}" resolves into repository metadata "${deniedGitDir}", which is denied regardless of authored ownership`,
      );
    }
    return canonical;
  });

  let payloadDir = contextScratchDir;
  if ((input.payloadLocation ?? "worktree") === "worktree") {
    const rawPayloadDir = path.join(
      worktreeRoot,
      PAYLOAD_NAMESPACE_DIR,
      PAYLOAD_PARENT_DIR,
      contextSegment,
    );
    let payloadNamespace: string;
    try {
      ensureDir(rawPayloadDir);
      payloadNamespace = realpath(
        path.join(worktreeRoot, PAYLOAD_NAMESPACE_DIR),
      );
      payloadDir = realpath(rawPayloadDir);
    } catch (error) {
      fail(`payload directory "${rawPayloadDir}": ${getErrorMessage(error)}`);
    }
    if (
      !isInsideLanePath(worktreeRoot, payloadNamespace) ||
      !isInsideLanePath(payloadNamespace, payloadDir)
    ) {
      fail(
        `payload directory "${payloadDir}" does not sit beneath the worktree's "${PAYLOAD_NAMESPACE_DIR}" namespace`,
      );
    }
  }

  return {
    policy: {
      mode: "allowlist",
      allowWrite: [
        contextScratchDir,
        ...ownedPrefixes,
        ...(payloadDir === contextScratchDir ? [] : [payloadDir]),
        contextTmpDir,
      ],
      denyWrite: [deniedGitDir],
    },
    worktreeRoot,
    contextScratchDir,
    contextTmpDir,
    payloadDir,
    ownedPrefixes,
  };
}

export async function resolveImplementerContinuationWriteEnvelope(
  input: ResolveImplementerContinuationWriteEnvelopeInput,
  deps: ResolveImplementerContinuationWriteEnvelopeDeps = {},
): Promise<ImplementerContinuationWriteEnvelopeResolution> {
  if (input.placement.mode === "full") {
    return { ok: true, envelope: null, worktreePath: null };
  }

  let worktreePath = input.executionTarget?.worktreePath;
  if (
    worktreePath === undefined &&
    input.placement.lane === "session" &&
    input.placement.mode === "readOnly"
  ) {
    try {
      worktreePath = await deps.resolveWorktreePath?.(
        input.projectPath,
        input.sessionName,
      );
    } catch (error) {
      return {
        ok: false,
        error: getErrorMessage(error),
        worktreePath: null,
      };
    }
  }
  if (worktreePath === undefined) {
    return {
      ok: false,
      error: "no execution target or session worktree was available",
      worktreePath: null,
    };
  }

  try {
    const composeWriteEnvelope =
      deps.composeWriteEnvelope ?? composeImplementerLaneWriteEnvelope;
    return {
      ok: true,
      envelope: composeWriteEnvelope({
        executionId: input.executionId,
        contextId: input.contextId,
        worktreePath,
        ownedPaths:
          input.placement.mode === "owned" ? input.placement.ownedPaths : [],
        payloadLocation:
          input.placement.mode === "readOnly" ? "scratch" : "worktree",
      }),
      worktreePath,
    };
  } catch (error) {
    return {
      ok: false,
      error: getErrorMessage(error),
      worktreePath,
    };
  }
}
