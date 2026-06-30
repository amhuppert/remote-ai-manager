import { z } from "zod";

// ============================================================
// Charter versions
// ============================================================

/** Lifecycle status of a charter version. `version` is NULL while `draft`. */
export const alignmentVersionStatusSchema = z.enum([
  "draft",
  "active",
  "superseded",
]);
export type AlignmentVersionStatus = z.infer<
  typeof alignmentVersionStatusSchema
>;

/**
 * What produced a charter version. `forked` = seeded by copying a parent
 * session's active charter into a session branched from it.
 */
export const alignmentVersionSourceSchema = z.enum([
  "align_initial",
  "align_rerun",
  "decision",
  "rollback",
  "forked",
]);
export type AlignmentVersionSource = z.infer<
  typeof alignmentVersionSourceSchema
>;

/**
 * A single charter version. Mirrors the `AlignmentVersion` service interface.
 * `version` is null while the row is a draft and is assigned the monotonic
 * activation index at activation. `linkedDecisionIds` is persisted as a JSON
 * array (`session_alignment_versions.linked_decision_ids`) and defaults empty.
 */
export const alignmentVersionSchema = z.object({
  id: z.string(),
  version: z.number().int().nullable(),
  content: z.string(),
  contentHash: z.string(),
  status: alignmentVersionStatusSchema,
  source: alignmentVersionSourceSchema,
  authorConversationId: z.string().nullable(),
  autoActivate: z.boolean(),
  linkedDecisionIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  approver: z.string().nullable(),
});
export type AlignmentVersion = z.infer<typeof alignmentVersionSchema>;

// ============================================================
// Approved decisions (append-only log)
// ============================================================

/**
 * A logged, approved decision. Mirrors `AlignmentDecision` plus the physical
 * `session_alignment_decisions` columns (`approver`, `created_at`) needed for
 * repo durability. `producedVersion` is null until the auto-activated draft it
 * links to is filled and activated.
 */
export const alignmentDecisionSchema = z.object({
  id: z.string(),
  statement: z.string(),
  rationale: z.string().nullable(),
  originConversationId: z.string(),
  originMessageId: z.string().nullable(),
  producedVersion: z.number().int().nullable(),
  approver: z.string().nullable(),
  approvedAt: z.string(),
  createdAt: z.string(),
});
export type AlignmentDecision = z.infer<typeof alignmentDecisionSchema>;

// ============================================================
// Transient decision proposals (pending, pre-approval)
// ============================================================

/**
 * A transient proposed decision awaiting human resolution. Mirrors the
 * `session_alignment_decision_proposals` physical table; rows are deleted on
 * resolution and never enter the decision log unless approved.
 */
export const decisionProposalSchema = z.object({
  id: z.string(),
  projectPath: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  batchId: z.string(),
  statement: z.string(),
  rationale: z.string().nullable(),
  context: z.string().nullable(),
  originMessageId: z.string().nullable(),
  createdAt: z.string(),
});
export type DecisionProposal = z.infer<typeof decisionProposalSchema>;

/** A batch of pending proposals grouped by `batchId` (resolved together). */
export const decisionProposalBatchSchema = z.object({
  batchId: z.string(),
  proposals: z.array(decisionProposalSchema),
});
export type DecisionProposalBatch = z.infer<typeof decisionProposalBatchSchema>;

// ============================================================
// Aggregate alignment state
// ============================================================

/**
 * The aggregate alignment state read for a session. `history` is newest-first
 * (superseded + active); `decisions` is reverse-chronological; `preview` is the
 * exact injected governing section for the active version (null when none).
 */
export const alignmentStateSchema = z.object({
  active: alignmentVersionSchema.nullable(),
  draft: alignmentVersionSchema.nullable(),
  history: z.array(alignmentVersionSchema),
  decisions: z.array(alignmentDecisionSchema),
  pendingProposals: z.array(decisionProposalBatchSchema),
  preview: z.string().nullable(),
});
export type AlignmentState = z.infer<typeof alignmentStateSchema>;

/** A per-version diff between two activated charter versions. */
export const alignmentDiffSchema = z.object({
  from: z.number().int(),
  to: z.number().int(),
  fromContent: z.string(),
  toContent: z.string(),
});
export type AlignmentDiff = z.infer<typeof alignmentDiffSchema>;

// ============================================================
// REST request payloads (safeParsed by the route-handlers)
// ============================================================

/** Begin a draft (`/align`). The originating conversation is optional. */
export const beginDraftRequestSchema = z.object({
  conversationId: z.string().min(1).optional(),
});
export type BeginDraftRequest = z.infer<typeof beginDraftRequestSchema>;

/** Fill the open draft with agent-authored content. Empty content is rejected. */
export const fillDraftRequestSchema = z.object({
  content: z.string().min(1),
});
export type FillDraftRequest = z.infer<typeof fillDraftRequestSchema>;

/** Approve a draft (the "Approve Charter" human gate). */
export const approveDraftRequestSchema = z.object({
  draftId: z.string().min(1),
  approver: z.string().min(1).optional(),
});
export type ApproveDraftRequest = z.infer<typeof approveDraftRequestSchema>;

/** Reject (discard) a draft, leaving the active charter unchanged. */
export const rejectDraftRequestSchema = z.object({
  draftId: z.string().min(1),
});
export type RejectDraftRequest = z.infer<typeof rejectDraftRequestSchema>;

/** A single proposed decision in a bulk `propose_decisions` payload. */
export const proposedDecisionSchema = z.object({
  statement: z.string().min(1),
  rationale: z.string().optional(),
  context: z.string().optional(),
});
export type ProposedDecision = z.infer<typeof proposedDecisionSchema>;

/** Propose a non-blocking bulk batch of decisions. At least one is required. */
export const proposeDecisionsRequestSchema = z.object({
  decisions: z.array(proposedDecisionSchema).min(1),
});
export type ProposeDecisionsRequest = z.infer<
  typeof proposeDecisionsRequestSchema
>;

/** Per-decision resolution: approve, or reject with optional feedback. */
export const decisionResolutionSchema = z.object({
  proposalId: z.string().min(1),
  approve: z.boolean(),
  feedback: z.string().optional(),
});
export type DecisionResolution = z.infer<typeof decisionResolutionSchema>;

/** Resolve a pending proposal batch with one resolution per decision. */
export const resolveProposalsRequestSchema = z.object({
  batchId: z.string().min(1),
  resolutions: z.array(decisionResolutionSchema).min(1),
});
export type ResolveProposalsRequest = z.infer<
  typeof resolveProposalsRequestSchema
>;

/** Roll back to a prior activated version, cloning its content into a new one. */
export const rollbackRequestSchema = z.object({
  version: z.number().int(),
});
export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

/** Request a per-version diff between two activated versions. */
export const diffRequestSchema = z.object({
  from: z.number().int(),
  to: z.number().int(),
});
export type DiffRequest = z.infer<typeof diffRequestSchema>;

// ============================================================
// SSE event contract
// ============================================================

/**
 * Broadcast when a session's active charter changes — activation of an approved
 * `/align` draft or an auto-activated decision draft — so open session views
 * invalidate their alignment query. Activation is the only trigger; the payload
 * also carries draft / pending-batch presence so the refetch needs no follow-up.
 * `type` is the `session-alignment-updated` literal.
 */
export const sessionAlignmentUpdatedEventSchema = z.object({
  type: z.literal("session-alignment-updated"),
  projectPath: z.string(),
  sessionName: z.string(),
  activeVersion: z.number().int().nullable(),
  hasDraft: z.boolean(),
  pendingProposalBatchIds: z.array(z.string()),
});
export type SessionAlignmentUpdatedEvent = z.infer<
  typeof sessionAlignmentUpdatedEventSchema
>;
