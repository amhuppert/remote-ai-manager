import { z } from "zod";

/**
 * One owned path: a normalized repo-relative POSIX path that covers itself
 * and everything beneath it. Overlap is decided by comparing path segments,
 * so a path has exactly one spelling.
 *
 * The normalization rules mirror the specs `touchedPath` schema rather than
 * importing it, so the two are free to diverge — and this one already does:
 * it additionally denies the repository root, git metadata, and the engine's
 * own `.cc` namespace. The `.git` denial is unconditional because an
 * agent able to write it could commit, branch, or reset the lane out from under
 * the engine, which is precisely what the ownership envelope exists to make
 * impossible. `.cc` is reserved because the envelope injects a per-context
 * payload directory beneath it (`implementer-lane-write-envelope.ts`), so an
 * authored claim there would put two owners on one subtree. Both comparisons
 * fold case: a case-insensitive filesystem resolves `.GIT` to the same
 * directory, so a literal-only refusal would be bypassable on macOS.
 *
 * An entry is a LITERAL path, never a glob (spec non-goal) — a metacharacter is
 * read as an ordinary filename character here, and the write-policy adapter is
 * what refuses one, because that is the layer that knows what the backend can
 * actually enforce. Directory-grain entries cover the need a glob would.
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
        `owned path "${value}" names repository metadata; .git is denied regardless of authored ownership`,
      );
      return;
    }
    if (segments[0]?.toLowerCase() === ".cc") {
      reject(
        `owned path "${value}" names the engine's .cc namespace; the write envelope injects a per-context payload directory there, so it is reserved from authored ownership`,
      );
    }
  });

/** What a Context may write in its workspace. */
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

/** What a supervised turn may write: everything, only listed paths, or nothing. */
export const turnWritesSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({ mode: z.literal("paths"), paths: z.array(ownedPathSchema).min(1) })
    .strict(),
  z.object({ mode: z.literal("none") }).strict(),
]);
export type TurnWrites = z.infer<typeof turnWritesSchema>;

/**
 * One supervised turn's workspace access, computed once by
 * turnWorkspaceAccess: the grant it holds while it runs (none for a turn that
 * only observes) and what its backend may write.
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

/** A placement resolved at launch; the binding itself is admitted at Context start. */
export const workspaceBindingRequestSchema = z
  .object({
    kind: z.literal("session"),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    worktreePath: z.string().min(1),
    scope: workspaceScopeSchema,
  })
  .strict();
export type WorkspaceBindingRequest = z.infer<
  typeof workspaceBindingRequestSchema
>;

/**
 * Operations Workspace executes. Requesters may carry their own labels on a
 * request; Workspace reads only these fields.
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
  z.object({ kind: z.literal("refused"), detail: z.string().min(1) }).strict(),
]);
export type WorkspaceReport = z.infer<typeof workspaceReportSchema>;
