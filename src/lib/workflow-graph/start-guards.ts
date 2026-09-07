import path from "node:path";
import { buildGraphWorkflowExecutionDeepLink } from "./execution-deep-link";
import type { LeaseAdmissionDecision } from "./lifecycle-classifier";
import type { DirtyPath } from "./errors";
import type { GraphWorkflowLeaseBlocker } from "./schemas";

/**
 * Raised by the shared start path when a pre-seed guard rejects the launch. The
 * `guard` discriminator lets the thin HTTP/MCP surface reconstruct the exact
 * 409 response (the lease-held payload built from `blocker`, or the structured
 * `uncommitted_changes` payload built from `dirtyPaths`) without re-deriving it
 * from a message string.
 *
 * `blocker` is the one structured launch-refusal payload (D7 decision D6). It
 * is present on every `active_execution` refusal — one-off and template alike,
 * advisory pre-check and authoritative reservation alike — because the surface
 * that renders the refusal must never have to re-read the incumbent to say
 * which run is holding the session.
 */
export type WorkflowStartGuard =
  | "active_execution"
  | "uncommitted_changes"
  | "session_branch_unavailable"
  // The symmetric half of the session delivery gate (R13): the session is
  // already being finalized by a merge, so seeding a run into it would install
  // live work in a session that is about to be marked finished.
  | "session_finalizing";

export class WorkflowStartGuardError extends Error {
  readonly guard: WorkflowStartGuard;
  readonly dirtyPaths?: DirtyPath[];
  readonly blocker?: GraphWorkflowLeaseBlocker;
  /**
   * The blocking merge on a `session_finalizing` refusal. Carried on the error
   * because the reservation fence raises it from inside the write queue, where
   * nothing may log: the launch logs the refusal from these facts once the
   * critical section is behind it.
   */
  readonly finalizingMerge?: SessionFinalizingMerge;

  constructor(
    guard: WorkflowStartGuard,
    message: string,
    details?: {
      dirtyPaths?: DirtyPath[];
      blocker?: GraphWorkflowLeaseBlocker;
      finalizingMerge?: SessionFinalizingMerge;
    },
  ) {
    super(message);
    this.name = "WorkflowStartGuardError";
    this.guard = guard;
    if (details?.dirtyPaths !== undefined) {
      this.dirtyPaths = details.dirtyPaths;
    }
    if (details?.blocker !== undefined) {
      this.blocker = details.blocker;
    }
    if (details?.finalizingMerge !== undefined) {
      this.finalizingMerge = details.finalizingMerge;
    }
  }
}

/**
 * Turn a lease refusal into the raised guard error. Both start-guard call sites
 * — the manager's advisory pre-check and the repository's reservation — build
 * the refusal HERE, so the message, the code, and the blocker facts cannot
 * drift between the two paths that can refuse the same launch.
 */
export function leaseHeldStartGuardError(input: {
  projectPath: string;
  sessionName: string;
  refusal: Extract<LeaseAdmissionDecision, { kind: "refuse" }>;
}): WorkflowStartGuardError {
  const { incumbent, remedy } = input.refusal;
  return new WorkflowStartGuardError(
    "active_execution",
    `Session "${input.sessionName}" already has an active graph workflow execution`,
    {
      blocker: {
        ...incumbent,
        remedy,
        deepLink: buildGraphWorkflowExecutionDeepLink({
          projectName: path.basename(input.projectPath),
          sessionName: input.sessionName,
          executionId: incumbent.executionId,
        }),
      },
    },
  );
}

/** The merge a `session_finalizing` refusal names. */
export interface SessionFinalizingMerge {
  jobId: string;
  branchName: string;
}

/**
 * Turn a session-finalizing merge into the raised guard error. Like the lease
 * refusal above, both call sites — the advisory pre-check and the reservation
 * fence — build it HERE, so the two refusals for one race cannot word
 * themselves differently.
 */
export function sessionFinalizingStartGuardError(
  merge: SessionFinalizingMerge,
): WorkflowStartGuardError {
  return new WorkflowStartGuardError(
    "session_finalizing",
    `Cannot start the workflow while ${merge.branchName} is being merged and this session finished. Wait for the merge to finish, or discard it, and try again.`,
    { finalizingMerge: merge },
  );
}
