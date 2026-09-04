/**
 * Codex's translation of a server-derived {@link FsWritePolicy} onto its native
 * sandbox.
 *
 * `workspace-write` makes the run's WORKING DIRECTORY writable by construction,
 * so the first thing this does is move the run out of the candidate worktree:
 * the cwd becomes the lane's own writable root and the worktree is reached by
 * absolute path instead. Everything else follows from "nothing outside CC's
 * composition may widen the sandbox":
 *
 *  - `writable_roots` is set to exactly the policy allowlist, so the writable
 *    set is enumerated rather than inherited;
 *  - the ambient temp roots workspace-write would otherwise add ($TMPDIR and
 *    /tmp) are excluded, and the run's TMPDIR is repointed into the lane's own
 *    temp so temp-writing tools still work inside the envelope;
 *  - the sandbox mode and approval policy are pinned in config as well as in
 *    thread options, so a `~/.codex/config.toml` that names a looser default
 *    has nothing left to widen;
 *  - the ambient instruction surfaces a user config carries (project docs,
 *    apps, memories, bundled skills) are blanked, on the same reasoning that
 *    governs the isolated one-shot profile: a review lane executes CC's
 *    composition, not the machine's.
 *
 * The shell and its tooling stay enabled — a reviewer that cannot run `git
 * diff` cannot review — because the envelope confines what a command may WRITE,
 * not what it may run.
 */

import type { CodexOptions } from "@openai/codex-sdk";
import type { FsWritePolicy } from "../task";
import { checkFsWritePolicy } from "../fs-write-policy";
import { CODEX_NATIVE_MEMORY_CONFIG } from "./native-memory";

type CodexConfig = NonNullable<CodexOptions["config"]>;

export interface CodexFsWriteEnvelope {
  /** The sandboxed run's working directory: the lane's own writable root. */
  workingDirectory: string;
  /** The child process's TMPDIR, inside the allowlist. */
  tmpDir: string;
  /** Config overrides pinning the sandbox and neutralizing inherited config. */
  config: CodexConfig;
}

export type CodexFsWriteEnvelopeResult =
  | { kind: "envelope"; envelope: CodexFsWriteEnvelope }
  | { kind: "unestablishable"; reason: string };

/**
 * Ambient surfaces a Codex run would otherwise pick up from the machine it runs
 * on. Blanked for a restricted lane so the only instructions in play are the
 * ones CC composed.
 */
const HERMETIC_CONFIG: CodexConfig = {
  apps: { _default: { enabled: false } },
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  // The same switches every Codex launch now pins; repeated here only because
  // this profile blanks the whole ambient surface as one object.
  ...CODEX_NATIVE_MEMORY_CONFIG,
  project_doc_fallback_filenames: [],
  project_doc_max_bytes: 0,
  skills: { bundled: { enabled: false }, include_instructions: false },
};

/** The sandbox half every Codex envelope shares. */
function sandboxConfigFor(policy: FsWritePolicy): CodexConfig {
  return {
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    sandbox_workspace_write: {
      writable_roots: [...policy.allowWrite],
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
      network_access: true,
    },
  };
}

/**
 * The allowlist is ordered by its composer: the run's own root first, its temp
 * last. A single-entry allowlist makes both the same path, which is the correct
 * degenerate case rather than a special one. Absence is impossible once
 * {@link checkFsWritePolicy} has passed, and is reported rather than asserted
 * so the invariant stays checked.
 */
function rootsOf(
  policy: FsWritePolicy,
): { workingDirectory: string; tmpDir: string } | null {
  const [workingDirectory] = policy.allowWrite;
  const tmpDir = policy.allowWrite[policy.allowWrite.length - 1];
  if (workingDirectory === undefined || tmpDir === undefined) return null;
  return { workingDirectory, tmpDir };
}

const NO_WRITABLE_ROOT: CodexFsWriteEnvelopeResult = {
  kind: "unestablishable",
  reason: "the write policy allows no path at all",
};

export function buildCodexFsWriteEnvelope(
  policy: FsWritePolicy,
): CodexFsWriteEnvelopeResult {
  const check = checkFsWritePolicy(policy);
  if (check.kind === "unestablishable") return check;
  const roots = rootsOf(policy);
  if (roots === null) return NO_WRITABLE_ROOT;

  return {
    kind: "envelope",
    envelope: {
      ...roots,
      config: { ...HERMETIC_CONFIG, ...sandboxConfigFor(policy) },
    },
  };
}

/**
 * The same sandbox for a CONVERSATION turn — a graph-workflow implementer
 * confined to the prefixes its context owns.
 *
 * The hermetic half is deliberately absent. A review lane executes CC's
 * composition and nothing else, so blanking the machine's project docs, skills,
 * and memories is part of its correctness; an implementer is doing the
 * project's own work and needs the project's own instructions (`AGENTS.md`
 * first among them). Blanking them would change what the lane builds, which is
 * not what a write envelope is for.
 */
export function buildCodexConversationFsWriteEnvelope(
  policy: FsWritePolicy,
): CodexFsWriteEnvelopeResult {
  const check = checkFsWritePolicy(policy);
  if (check.kind === "unestablishable") return check;
  const roots = rootsOf(policy);
  if (roots === null) return NO_WRITABLE_ROOT;

  return {
    kind: "envelope",
    envelope: { ...roots, config: sandboxConfigFor(policy) },
  };
}
