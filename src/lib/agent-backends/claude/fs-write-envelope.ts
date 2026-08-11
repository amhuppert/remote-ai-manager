/**
 * Claude's translation of a server-derived {@link FsWritePolicy} onto the Agent
 * SDK sandbox plus path-scoped permission rules.
 *
 * Two mechanisms are needed because they cover different halves of the same
 * surface. The sandbox confines what a SHELL COMMAND may write; the file-mutation
 * TOOLS (Edit/Write/NotebookEdit) run inside the CLI and are gated by permission
 * rules instead. Tool exclusion alone cannot express "scratch only" — it can
 * only remove a tool entirely — so the rules carry the paths and the sandbox
 * carries the same paths for everything the tools don't cover.
 *
 * Five properties make it an envelope rather than a preference:
 *  - `failIfUnavailable` and `allowUnsandboxedCommands: false` remove the two
 *    ways a run could otherwise proceed unsandboxed;
 *  - `denyWrite` is explicit, because the sandbox's `allowWrite` is ADDITIVE
 *    over its own defaults: the candidate worktree being absent from the allow
 *    list is not the same as it being unwritable;
 *  - the run is MOVED onto the policy's own working root, because those defaults
 *    include the working directory and its subdirectories. A run left in the
 *    worktree is writable throughout it however narrow the allowlist is — the
 *    hole an OS-level enforcement proof catches and an options-translation
 *    assertion cannot;
 *  - the session temp is BOUND to the policy's own tmp entry, because the
 *    sandbox otherwise keeps a separate session temp writable and repoints
 *    sandboxed commands' `$TMPDIR` at it — a writable path the allowlist never
 *    granted;
 *  - the permission mode denies anything not pre-approved, so a mutation path
 *    nobody anticipated fails closed instead of prompting into the void.
 *
 * Rule content is a glob, so a path carrying a glob metacharacter would widen
 * the rule it is pasted into. Such a policy is refused rather than escaped:
 * a lane scratch path is composed from sanitized ids and never legitimately
 * contains one.
 */

import type {
  Options,
  SandboxSettings,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { FsWritePolicy } from "../task";
import { checkFsWritePolicy } from "../fs-write-policy";

/** The tools whose whole job is mutating files on disk. */
export const CLAUDE_FS_RESTRICTED_MUTATION_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
] as const;

/**
 * What a reviewer still needs once "deny unless pre-approved" is in force.
 * Reading and searching the candidate is the job; Bash is how a reviewer reaches
 * `git diff` and the project's own tooling, and its writes are confined by the
 * sandbox rather than by this list.
 */
const REVIEWER_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "TodoWrite",
] as const;

/**
 * What an IMPLEMENTER still needs once "deny unless pre-approved" is in force:
 * its whole toolbox except the file-mutation tools, which are pre-approved
 * per path instead. Confining an implementer is a statement about paths, not
 * about capabilities — a lane that cannot spawn a sub-agent or run a skill is
 * broken rather than sandboxed.
 */
const IMPLEMENTER_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "BashOutput",
  "KillShell",
  "TodoWrite",
  "Task",
  "Skill",
  "SlashCommand",
  "WebFetch",
  "WebSearch",
] as const;

/** Anything that would make a path mean more than itself inside a rule. */
const GLOB_METACHARACTERS = /[*?[\]{}!()]/;

/** The SDK's own permission-settings shape, with this envelope's parts pinned. */
export type ClaudeFsWriteEnvelopePermissions = NonNullable<
  Settings["permissions"]
> & {
  allow: string[];
  deny: string[];
  defaultMode: "dontAsk";
};

export interface ClaudeFsWriteEnvelope {
  sandbox: SandboxSettings;
  permissions: ClaudeFsWriteEnvelopePermissions;
  permissionMode: NonNullable<Options["permissionMode"]>;
  /**
   * The sandboxed run's working directory: the policy's own writable working
   * root, never the target worktree. The sandbox's DEFAULT writable set is the
   * working directory and its subdirectories, and `allowWrite` only ADDS paths
   * outside it, so a run left in a worktree is writable throughout that
   * worktree however narrow the allowlist is. Denying the worktree instead is
   * not available to a policy that allows part of it: `checkFsWritePolicy`
   * refuses an allow entry inside a denied path rather than guess which wins.
   */
  workingDirectory: string;
  /**
   * The run's temp directory: the policy's own tmp entry. The sandbox keeps a
   * separate session temp writable and repoints sandboxed commands' `$TMPDIR`
   * at it, so binding the session temp to a policy path is what stops a second,
   * ungranted writable directory from existing alongside the allowlist.
   */
  tmpDir: string;
}

export type ClaudeFsWriteEnvelopeResult =
  | { kind: "envelope"; envelope: ClaudeFsWriteEnvelope }
  | { kind: "unestablishable"; reason: string };

/** An absolute path as Claude permission rules address one. */
function ruleFor(tool: string, absolutePath: string): string {
  return `${tool}(//${absolutePath}/**)`;
}

/** The refusals every Claude envelope shares, or null when the policy is usable. */
function unestablishableReason(policy: FsWritePolicy): string | null {
  const check = checkFsWritePolicy(policy);
  if (check.kind === "unestablishable") return check.reason;

  for (const entry of [...policy.allowWrite, ...policy.denyWrite]) {
    if (GLOB_METACHARACTERS.test(entry)) {
      return `the write policy entry "${entry}" contains a glob metacharacter, which a permission rule cannot pin to a single path`;
    }
  }
  return null;
}

/**
 * The allowlist is ordered by its composer: the run's own writable root first,
 * its temp last. Absence is impossible once {@link unestablishableReason} has
 * passed, and is reported rather than asserted so the invariant stays checked.
 */
function workingRootOf(policy: FsWritePolicy): string | null {
  const [workingRoot] = policy.allowWrite;
  return workingRoot ?? null;
}

/** The allowlist's last entry, by the same composer contract. */
function tmpDirOf(policy: FsWritePolicy): string | null {
  return policy.allowWrite[policy.allowWrite.length - 1] ?? null;
}

function trustedServerHost(
  trustedServerUrl: string | null,
):
  | { kind: "trusted"; host: string }
  | { kind: "unestablishable"; reason: string } {
  if (trustedServerUrl === null) {
    return {
      kind: "unestablishable",
      reason: "the trusted Command Center server URL is unavailable",
    };
  }

  try {
    const parsed = new URL(trustedServerUrl);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname === "" ||
      parsed.hostname.includes("*")
    ) {
      return {
        kind: "unestablishable",
        reason: "the trusted Command Center server URL is not HTTP or HTTPS",
      };
    }
    return {
      kind: "trusted",
      host: parsed.hostname.replace(/^\[|\]$/g, ""),
    };
  } catch {
    return {
      kind: "unestablishable",
      reason: "the trusted Command Center server URL is invalid",
    };
  }
}

function sandboxFor(
  policy: FsWritePolicy,
  trustedHost: string,
): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [trustedHost],
      strictAllowlist: true,
    },
    filesystem: {
      allowWrite: [...policy.allowWrite],
      denyWrite: [...policy.denyWrite],
    },
  };
}

/** Path-scoped mutation rules for each entry of one half of the policy. */
function mutationRulesFor(paths: readonly string[]): string[] {
  return paths.flatMap((entry) =>
    CLAUDE_FS_RESTRICTED_MUTATION_TOOLS.map((tool) => ruleFor(tool, entry)),
  );
}

export function buildClaudeFsWriteEnvelope(
  policy: FsWritePolicy,
  trustedServerUrl: string | null,
): ClaudeFsWriteEnvelopeResult {
  const reason = unestablishableReason(policy);
  if (reason !== null) return { kind: "unestablishable", reason };
  const trustedServer = trustedServerHost(trustedServerUrl);
  if (trustedServer.kind === "unestablishable") return trustedServer;
  const workingDirectory = workingRootOf(policy);
  const tmpDir = tmpDirOf(policy);
  if (workingDirectory === null || tmpDir === null) {
    return {
      kind: "unestablishable",
      reason: "the write policy allows no path at all",
    };
  }

  return {
    kind: "envelope",
    envelope: {
      sandbox: sandboxFor(policy, trustedServer.host),
      permissions: {
        allow: [
          ...REVIEWER_ALLOWED_TOOLS,
          ...mutationRulesFor(policy.allowWrite),
        ],
        deny: mutationRulesFor(policy.denyWrite),
        defaultMode: "dontAsk",
      },
      permissionMode: "dontAsk",
      workingDirectory,
      tmpDir,
    },
  };
}

/**
 * The same envelope for a CONVERSATION turn — a graph-workflow implementer
 * confined to the prefixes its context owns.
 *
 * The filesystem half is identical, because the threat is: a shell command and
 * a file-mutation tool have to be confined by different mechanisms whoever is
 * running them. What differs is the tool surface. A reviewer reads and reports,
 * so its pre-approved set is a short literal list; an implementer builds, so
 * removing its ability to spawn sub-agents, run a skill, or call an MCP server
 * would break the turn rather than confine it. "Deny unless pre-approved" still
 * holds — the pre-approved set is simply the implementer's whole toolbox, with
 * the mutation tools path-scoped exactly as they are for a reviewer.
 *
 * MCP servers are pre-approved per SERVER rather than per tool: the server keys
 * are known here (the caller composed them), the individual tool names are not
 * until the server is discovered, and a tool the envelope has never heard of
 * must not be the thing that fails the turn.
 */
export function buildClaudeConversationFsWriteEnvelope(input: {
  policy: FsWritePolicy;
  /** MCP server keys bound to this conversation, pre-approved wholesale. */
  mcpServerKeys: readonly string[];
  /** Server-owned URL whose exact host is the only network destination. */
  trustedServerUrl: string | null;
}): ClaudeFsWriteEnvelopeResult {
  const reason = unestablishableReason(input.policy);
  if (reason !== null) return { kind: "unestablishable", reason };
  const trustedServer = trustedServerHost(input.trustedServerUrl);
  if (trustedServer.kind === "unestablishable") return trustedServer;
  const workingDirectory = workingRootOf(input.policy);
  const tmpDir = tmpDirOf(input.policy);
  if (workingDirectory === null || tmpDir === null) {
    return {
      kind: "unestablishable",
      reason: "the write policy allows no path at all",
    };
  }

  return {
    kind: "envelope",
    envelope: {
      sandbox: sandboxFor(input.policy, trustedServer.host),
      permissions: {
        allow: [
          ...IMPLEMENTER_ALLOWED_TOOLS,
          ...input.mcpServerKeys.map((key) => `mcp__${key}`),
          ...mutationRulesFor(input.policy.allowWrite),
        ],
        deny: mutationRulesFor(input.policy.denyWrite),
        defaultMode: "dontAsk",
      },
      permissionMode: "dontAsk",
      workingDirectory,
      tmpDir,
    },
  };
}
