/**
 * The permission literals a workflow `task_run` executes under, derived from
 * the lane's role instead of hardcoded at the dispatch site.
 *
 * There is exactly one dispatch site for workflow task runs, and until now it
 * asserted the write-capable implementer configuration unconditionally. A
 * validator lane reaching that site would have inherited it, which is why the
 * derivation lives here as a pure function rather than as a conditional inside
 * the dispatch code: the property being bought is that the write-capable
 * literals are UNREACHABLE for a restricted lane, and that is only checkable if
 * choosing them is a single expression a test can drive directly.
 *
 * The role is carried by the presence of a server-derived `fsWritePolicy`: it
 * is composed from the lane's role by orchestration code that an agent cannot
 * reach, so "has a policy" and "is a restricted lane" are the same fact.
 */

import type {
  AgentTaskRequest,
  FsWritePolicy,
} from "@/lib/agent-backends/task";
import type { LaneWriteCapability } from "@/lib/workflows/primitives/agent-call-vocabulary";

export interface TaskRunPermissions {
  sandboxMode: NonNullable<AgentTaskRequest["sandboxMode"]>;
  approvalPolicy: NonNullable<AgentTaskRequest["approvalPolicy"]>;
  webSearchMode: NonNullable<AgentTaskRequest["webSearchMode"]>;
  networkAccessEnabled: boolean;
  skipGitRepoCheck: boolean;
  /** The scheduling-visible claim about what the lane may touch. */
  writeCapability: LaneWriteCapability;
}

/** What every workflow task run shares, whatever its role. */
const SHARED: Omit<TaskRunPermissions, "sandboxMode" | "writeCapability"> = {
  approvalPolicy: "never",
  webSearchMode: "disabled",
  networkAccessEnabled: true,
  skipGitRepoCheck: true,
};

export function deriveTaskRunPermissions(
  fsWritePolicy: FsWritePolicy | undefined,
): TaskRunPermissions {
  if (fsWritePolicy === undefined) {
    return {
      ...SHARED,
      sandboxMode: "danger-full-access",
      writeCapability: "write_capable",
    };
  }
  // `workspace-write` rather than `read-only`: the lane still writes — to its
  // own scratch and lane-temp directories — and the allowlist, not the mode, is
  // what excludes the candidate worktree.
  return {
    ...SHARED,
    sandboxMode: "workspace-write",
    writeCapability: "read_only",
  };
}
