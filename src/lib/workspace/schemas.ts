import { z } from "zod";

/**
 * Literal normalized repository-relative scope used for coordination, evidence
 * and landing. It does not restrict filesystem access inside a worktree.
 * .git and the engine's .cc namespace cannot be owned by a task because they
 * hold repository metadata and shared execution artifacts.
 */
export const ownedPathSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const reject = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (value === "." || value === "./") {
      reject(
        `owned path "${value}" names the repository root; declare the directories the context owns instead`,
      );
      return;
    }
    const segments = value.split("/");
    if (
      value !== value.trim() ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.includes("\\") ||
      value.endsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      reject(
        `owned path "${value}" must be a normalized repo-relative POSIX path without parent segments or trailing separators`,
      );
      return;
    }
    if (segments[0]?.toLowerCase() === ".git") {
      reject(
        `owned path "${value}" names repository metadata, which cannot be owned by a task`,
      );
      return;
    }
    if (segments[0]?.toLowerCase() === ".cc") {
      reject(
        `owned path "${value}" names the engine's .cc namespace, which is reserved for execution artifacts`,
      );
    }
  });

/** A context's declared task scope for coordination, evidence and landing. */
export const workspaceScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("full") }).strict(),
  z
    .object({
      mode: z.literal("owned"),
      paths: z.array(ownedPathSchema).min(1),
    })
    .strict(),
  z.object({ mode: z.literal("readOnly") }).strict(),
]);
export type WorkspaceScope = z.infer<typeof workspaceScopeSchema>;

/** A supervised turn's task intent, not backend filesystem permissions. */
export const turnWritesSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("paths"),
      paths: z.array(ownedPathSchema).min(1),
    })
    .strict(),
  z.object({ mode: z.literal("none") }).strict(),
]);
export type TurnWrites = z.infer<typeof turnWritesSchema>;

/**
 * One supervised turn's workspace access, computed once by
 * turnWorkspaceAccess: the grant it holds while it runs (none for a turn that
 * only observes) and its declared write intent.
 */
export const turnWorkspaceSchema = z
  .object({
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    worktreePath: z.string().min(1),
    grant: z
      .object({
        kind: z.enum(["scoped_write", "full_write", "stable_read"]),
        paths: z.array(ownedPathSchema).min(1).optional(),
      })
      .strict()
      .nullable(),
    writes: turnWritesSchema,
  })
  .strict();
export type TurnWorkspace = z.infer<typeof turnWorkspaceSchema>;

/**
 * A placement resolved at launch; the binding itself is admitted at Context
 * start. Session placement works in the session worktree and accepts in place;
 * lane placement works in the lane's worktree and lands each accepted result
 * as a commit on the lane branch.
 */
export const workspaceBindingRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session"),
      projectPath: z.string().min(1),
      sessionName: z.string().min(1),
      worktreePath: z.string().min(1),
      scope: workspaceScopeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("lane"),
      projectPath: z.string().min(1),
      sessionName: z.string().min(1),
      worktreePath: z.string().min(1),
      branch: z.string().min(1),
      scope: workspaceScopeSchema,
    })
    .strict(),
]);
export type WorkspaceBindingRequest = z.infer<
  typeof workspaceBindingRequestSchema
>;

/** An isolated lane: its worktree and branch, and the session worktree and branch it publishes into. */
export const laneTargetSchema = z
  .object({
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    laneId: z.string().min(1),
    worktreePath: z.string().min(1),
    branch: z.string().min(1),
    sessionWorktreePath: z.string().min(1),
    sessionBranch: z.string().min(1),
  })
  .strict();
export type LaneTarget = z.infer<typeof laneTargetSchema>;

/** A lane operation's job id, for the refs and jobs Git work parks under: a ref name cannot hold a cause's colons. */
export const laneJobId = (cause: string): string =>
  cause.replace(/[^A-Za-z0-9._-]/g, "-");

/** A lane's operations name its worktree as their binding, so the lane runs one of them at a time. */
export const laneBindingId = (lane: Pick<LaneTarget, "worktreePath">): string =>
  `lane:${lane.worktreePath}`;

/**
 * Operations Workspace executes. Requesters may carry their own labels on a
 * request; Workspace reads only these fields. Lane operations name the lane's
 * worktree as their binding, so a lane runs one of them at a time.
 */
export const workspaceOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("bind"),
      bindingId: z.string().min(1),
      binding: workspaceBindingRequestSchema,
    })
    .passthrough(),
  z
    .object({ kind: z.literal("freeze"), bindingId: z.string().min(1) })
    .passthrough(),
  z
    .object({
      kind: z.literal("check"),
      bindingId: z.string().min(1),
      command: z.string().min(1),
      evidence: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("verify"),
      bindingId: z.string().min(1),
      evidence: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("accept"),
      bindingId: z.string().min(1),
      evidence: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("provision"),
      bindingId: z.string().min(1),
      lane: laneTargetSchema,
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("publish"),
      bindingId: z.string().min(1),
      lane: laneTargetSchema,
      /** Whole-tree checks run on the lane merged with the session head. */
      checks: z.array(z.string().min(1)),
    })
    .passthrough(),
]);
export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;

export const workspaceBindingStateSchema = z.enum([
  "waiting",
  "bound",
  "released",
]);

export const workspaceBindingRecordSchema = z
  .object({
    bindingId: z.string().min(1),
    request: workspaceBindingRequestSchema,
    state: workspaceBindingStateSchema,
    /** Evidence when the binding was admitted, kept for presenting diffs. */
    baseline: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type WorkspaceBindingRecord = z.infer<
  typeof workspaceBindingRecordSchema
>;

export const workspaceOperationStateSchema = z.enum([
  "queued",
  "running",
  "settled",
  "uncertain",
]);

export const workspaceOperationRecordSchema = z
  .object({
    cause: z.string().min(1),
    bindingId: z.string().min(1),
    requester: z
      .object({ kind: z.enum(["context", "run"]), id: z.string().min(1) })
      .strict(),
    request: z.unknown(),
    permit: z
      .object({
        controllerId: z.string().min(1),
        generation: z.number().int().min(1),
      })
      .strict()
      .nullable(),
    state: workspaceOperationStateSchema,
    outcome: z.unknown(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type WorkspaceOperationRecord = z.infer<
  typeof workspaceOperationRecordSchema
>;

const refusedReportSchema = z
  .object({ kind: z.literal("refused"), detail: z.string().min(1) })
  .strict();

/** What provisioning a lane reports: its worktree, from a pinned base commit, or why not. */
export const laneProvisionReportSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("provisioned"), baseline: z.string().min(1) })
    .strict(),
  refusedReportSchema,
]);
export type LaneProvisionReport = z.infer<typeof laneProvisionReportSchema>;

const publishedReportSchema = z
  .object({
    kind: z.literal("published"),
    commit: z.string().min(1),
    /** The session head the lane was merged with and checked against. */
    incorporated: z.string().min(1),
  })
  .strict();
/** The session worktree had changes publication must not overwrite or commit. */
const publishBlockedReportSchema = z
  .object({ kind: z.literal("publish_blocked"), detail: z.string().min(1) })
  .strict();
/** The session branch moved after the lane was checked against it. */
const publicationStaleReportSchema = z
  .object({ kind: z.literal("publication_stale"), head: z.string().min(1) })
  .strict();
/** The merge conflicted or a publication check failed. */
const publicationFailedReportSchema = z
  .object({ kind: z.literal("publication_failed"), detail: z.string().min(1) })
  .strict();
/** Whether the session holds the publication could not be established; the owner checks. */
const publicationUncertainReportSchema = z
  .object({
    kind: z.literal("publication_uncertain"),
    detail: z.string().min(1),
  })
  .strict();

/**
 * What publishing a lane reports. Only `published` lets work that needs the
 * lane's code proceed. Lane content can reach the session worktree earlier: an
 * owner commit during the merge carries it, and a held ref lock leaves it staged.
 */
export const lanePublicationReportSchema = z.discriminatedUnion("kind", [
  publishedReportSchema,
  publishBlockedReportSchema,
  publicationStaleReportSchema,
  publicationFailedReportSchema,
  publicationUncertainReportSchema,
  refusedReportSchema,
]);
export type LanePublicationReport = z.infer<typeof lanePublicationReportSchema>;

/**
 * Why a publication waits for the session worktree, as Workspace knows it in
 * memory; never persisted. `publication`: another lane's publication into the
 * same session runs, and this one is queued behind it. `grants`: supervised
 * work or another operation holds the session worktree (each holder is the
 * cause it holds it for). `session_lock`: a CC job holds the session's Git
 * lock; `job` is null when the holder cannot be named. `git_lock`: the session
 * worktree's index lock or the session branch's ref lock exists, held by
 * another Git process or left behind by one.
 */
export const publicationWaitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("publication"), laneId: z.string() }).strict(),
  z
    .object({ kind: z.literal("grants"), holders: z.array(z.string()) })
    .strict(),
  z
    .object({
      kind: z.literal("session_lock"),
      job: z
        .object({ jobId: z.string(), jobType: z.string() })
        .strict()
        .nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("git_lock"), lock: z.string() }).strict(),
]);
export type PublicationWait = z.infer<typeof publicationWaitSchema>;

/** The settled outcome of a Workspace operation, as requesters consume it. */
export const workspaceReportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bound") }).strict(),
  z.object({ kind: z.literal("frozen"), evidence: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("checked"),
      status: z.enum(["passed", "failed", "unavailable"]),
      detail: z.string().optional(),
      wroteReviewedScope: z.array(z.string()),
    })
    .strict(),
  z.object({ kind: z.literal("verified"), changed: z.boolean() }).strict(),
  z
    .object({ kind: z.literal("accepted"), receipt: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("candidate_changed") }).strict(),
  ...laneProvisionReportSchema.options,
  publishedReportSchema,
  publishBlockedReportSchema,
  publicationStaleReportSchema,
  publicationFailedReportSchema,
  publicationUncertainReportSchema,
]);
export type WorkspaceReport = z.infer<typeof workspaceReportSchema>;
