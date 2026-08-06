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
 * Three properties make it an envelope rather than a preference:
 *  - `failIfUnavailable` and `allowUnsandboxedCommands: false` remove the two
 *    ways a run could otherwise proceed unsandboxed;
 *  - `denyWrite` is explicit, because the sandbox's `allowWrite` is ADDITIVE
 *    over its own defaults: the candidate worktree being absent from the allow
 *    list is not the same as it being unwritable;
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
}

export type ClaudeFsWriteEnvelopeResult =
  | { kind: "envelope"; envelope: ClaudeFsWriteEnvelope }
  | { kind: "unestablishable"; reason: string };

/** An absolute path as Claude permission rules address one. */
function ruleFor(tool: string, absolutePath: string): string {
  return `${tool}(//${absolutePath}/**)`;
}

export function buildClaudeFsWriteEnvelope(
  policy: FsWritePolicy,
): ClaudeFsWriteEnvelopeResult {
  const check = checkFsWritePolicy(policy);
  if (check.kind === "unestablishable") return check;

  for (const entry of [...policy.allowWrite, ...policy.denyWrite]) {
    if (GLOB_METACHARACTERS.test(entry)) {
      return {
        kind: "unestablishable",
        reason: `the write policy entry "${entry}" contains a glob metacharacter, which a permission rule cannot pin to a single path`,
      };
    }
  }

  return {
    kind: "envelope",
    envelope: {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          allowWrite: [...policy.allowWrite],
          denyWrite: [...policy.denyWrite],
        },
      },
      permissions: {
        allow: [
          ...REVIEWER_ALLOWED_TOOLS,
          ...policy.allowWrite.flatMap((allowed) =>
            CLAUDE_FS_RESTRICTED_MUTATION_TOOLS.map((tool) =>
              ruleFor(tool, allowed),
            ),
          ),
        ],
        deny: policy.denyWrite.flatMap((denied) =>
          CLAUDE_FS_RESTRICTED_MUTATION_TOOLS.map((tool) =>
            ruleFor(tool, denied),
          ),
        ),
        defaultMode: "dontAsk",
      },
      permissionMode: "dontAsk",
    },
  };
}
