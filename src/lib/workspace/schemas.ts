import { z } from "zod";

/** What a Context may write in its workspace. */
export const workspaceScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("full") }).strict(),
  z
    .object({
      mode: z.literal("owned"),
      paths: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z.object({ mode: z.literal("readOnly") }).strict(),
]);
export type WorkspaceScope = z.infer<typeof workspaceScopeSchema>;

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
