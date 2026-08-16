import type Database from "better-sqlite3";
import {
  canonicalDeliveryPlanCandidateBytes,
  canonicalDeliveryPlanEnvelopeBytes,
  deliveryPlanDocumentSchema,
  finalizedDeliveryPlanApprovalSchema,
  finalizedDeliveryPlanCandidateIdentitySchema,
  finalizedDeliveryPlanPrelaunchSchema,
  postLaunchPathsSentence,
  type DeliveryPlanCandidateRecord,
  type DeliveryPlanDocument,
  type FinalizedDeliveryPlanApproval,
  type FinalizedDeliveryPlanCandidateIdentity,
  type FinalizedDeliveryPlanPrelaunch,
} from "@/lib/specs/delivery-plan";
import { deliveryPlanCandidateHash } from "@/lib/specs/delivery-plan-hash";
import {
  specDeliveryDiscoveryRowSchema,
  specDeliveryPlanAttemptRowSchema,
  specDeliveryPlanCommentRowSchema,
  specDeliveryPlanSnapshotRowSchema,
  type ActorProvenance,
  type DeliveryPlanAttemptStatus,
  type SpecDeliveryDiscoveryRow,
  type SpecDeliveryPlanAttemptRow,
  type SpecDeliveryPlanCommentRow,
  type SpecDeliveryPlanSnapshotRow,
  type SpecEventRow,
} from "@/lib/specs/schemas";
import { stableStringify } from "./serialization";
import { createSpecRepoHelpers } from "./spec-repo-helpers";
import type { SpecEventInput } from "./spec-events-repo";

type Db = InstanceType<typeof Database>;

const { parseRow, readMany, readOne, timed } = createSpecRepoHelpers(
  "state-store.spec-delivery-plan",
);

export class DeliveryPlanAttemptNotFoundError extends Error {
  readonly code = "not_found" as const;

  constructor(readonly attemptId: string) {
    super(`delivery plan attempt ${attemptId} does not exist`);
    this.name = "DeliveryPlanAttemptNotFoundError";
  }
}

/**
 * The compare-and-swap refusal. It names the current draft revision because a
 * caller told only "stale" re-sends the identical write; with the current
 * revision in hand the recovery is a re-read and one retry.
 */
export class StaleDeliveryPlanDraftError extends Error {
  readonly code = "stale_plan_draft" as const;

  constructor(
    readonly attemptId: string,
    readonly expectedDraftRevision: number,
    readonly currentDraftRevision: number,
  ) {
    super(
      `delivery plan attempt ${attemptId} is at draft revision ${currentDraftRevision}, not ${expectedDraftRevision}. Nothing was written. Re-read the attempt with \`cctl spec plan get\` and re-apply the edit at draft revision ${currentDraftRevision}.`,
    );
    this.name = "StaleDeliveryPlanDraftError";
  }
}

/**
 * An act asked for in a status that cannot serve it. Every message states the
 * act that IS available from here and the id it addresses, because a refusal
 * that only reports the status recreates the dead end one layer up.
 */
export class DeliveryPlanStatusConflictError extends Error {
  readonly code = "plan_status_conflict" as const;

  constructor(
    readonly attemptId: string,
    readonly status: DeliveryPlanAttemptStatus,
    readonly remedy: string,
  ) {
    super(
      `delivery plan attempt ${attemptId} is ${status}. Nothing was written. ${remedy}`,
    );
    this.name = "DeliveryPlanStatusConflictError";
  }
}

export interface OpenDeliveryPlanAttemptInput {
  readonly attempt: SpecDeliveryPlanAttemptRow;
  readonly occurredAt: string;
  readonly actor: ActorProvenance | { kind: "system" };
}

/**
 * One context-anchored review note. The caller states the whole row because a
 * comment's identity, its anchor and its author are review decisions rather
 * than storage ones — the repository's job is to make the write durable and
 * audited in one transaction.
 */
export interface AddDeliveryPlanCommentInput {
  readonly comment: SpecDeliveryPlanCommentRow;
  readonly actor: ActorProvenance | { kind: "system" };
}

export interface SaveDeliveryPlanDraftInput {
  readonly attemptId: string;
  readonly expectedDraftRevision: number;
  readonly document: DeliveryPlanDocument;
  readonly updatedAt: string;
}

export interface ReaffirmDeliveryPlanDraftInput {
  readonly attemptId: string;
  readonly expectedDraftRevision: number;
  readonly criterionElementId: string;
  readonly reaffirmedAt: string;
  readonly actor: ActorProvenance;
}

export class DeliveryPlanReaffirmationStateError extends Error {
  readonly code = "plan_status_conflict" as const;

  constructor(
    readonly attemptId: string,
    readonly criterionElementId: string,
  ) {
    super(
      `delivery plan attempt ${attemptId} has no pending reaffirmation for criterion ${criterionElementId}. Nothing was written. Read the draft with \`cctl spec plan get\` and reaffirm only a criterion marked pending_reaffirmation.`,
    );
    this.name = "DeliveryPlanReaffirmationStateError";
  }
}

/**
 * The compiled candidate the caller materialized from the very document this
 * proposal freezes. It is stated by the caller rather than compiled here
 * because materialization needs the pinned revision's criteria and the
 * project's command registry — neither of which is storage's business — and it
 * is written inside the same transaction so a proposal can never exist without
 * the candidate a human would approve.
 */
export interface ProposeDeliveryPlanInput {
  readonly attemptId: string;
  readonly expectedDraftRevision: number;
  readonly snapshotId: string;
  readonly candidate: {
    readonly record: DeliveryPlanCandidateRecord;
    readonly candidateHash: string;
  };
  readonly proposedAt: string;
  readonly actor: ActorProvenance;
}

export interface ProposeDeliveryPlanResult {
  readonly attempt: SpecDeliveryPlanAttemptRow;
  readonly snapshot: SpecDeliveryPlanSnapshotRow;
}

export class FinalizedDeliveryPlanCandidateMismatchError extends Error {
  readonly code = "integrity_mismatch" as const;

  constructor(
    readonly attemptId: string,
    readonly reason: string,
  ) {
    super(
      `delivery plan attempt ${attemptId} cannot freeze the finalized candidate: ${reason}. Nothing was written. Re-run \`cctl spec plan propose\` from the current draft.`,
    );
    this.name = "FinalizedDeliveryPlanCandidateMismatchError";
  }
}

export interface ReopenDeliveryPlanInput {
  readonly attemptId: string;
  readonly reopenedAt: string;
  readonly actor: ActorProvenance;
  readonly reason: string;
}

export interface ReopenDeliveryPlanResult {
  readonly attempt: SpecDeliveryPlanAttemptRow;
  readonly invalidatedApproval: {
    readonly snapshotId: string;
    readonly candidateHash: string;
  } | null;
}

/**
 * The status moves this repo owns beyond propose and reopen. They are one
 * mutation rather than four near-identical ones so the audit row and the
 * status write can never be separated, whichever later context asks for the
 * move.
 *
 * `approve`, `park`, and `launch` all state the candidate identity they act
 * on rather than reading "whatever is proposed now": the transaction re-reads
 * the live snapshot and candidate and refuses a mismatch, so a re-propose
 * racing an approval cannot slide different bytes under it (`exact-approval`).
 */
export type DeliveryPlanTransition =
  | ({ readonly kind: "approve" } & FinalizedDeliveryPlanCandidateIdentity)
  | ({
      readonly kind: "park";
      readonly reason: string | null;
    } & FinalizedDeliveryPlanCandidateIdentity)
  | ({
      readonly kind: "launch";
      readonly executionId: string;
    } & FinalizedDeliveryPlanCandidateIdentity)
  | { readonly kind: "abandon"; readonly reason: string };

export class FinalizedDeliveryPlanApprovalIdentityMismatchError extends Error {
  readonly code = "integrity_mismatch" as const;

  constructor(
    readonly attemptId: string,
    readonly stated: FinalizedDeliveryPlanCandidateIdentity,
    readonly stored: FinalizedDeliveryPlanCandidateIdentity | null,
  ) {
    super(
      stored === null
        ? `delivery plan attempt ${attemptId} has no finalized proposal snapshot to act on. Nothing was written. Re-run \`cctl spec plan propose\`, then sign the candidate it stores.`
        : `delivery plan attempt ${attemptId} stores candidate ${stored.candidateId} at ${stored.candidateHash}, not candidate ${stated.candidateId} at ${stated.candidateHash}. Nothing was written. Re-read the proposed snapshot and sign exactly those immutable bytes.`,
    );
    this.name = "FinalizedDeliveryPlanApprovalIdentityMismatchError";
  }
}

export interface SpecDeliveryPlanRepoDeps {
  /**
   * Appends the durable audit row inside the caller's open transaction. The
   * repo takes it as a dependency rather than writing `spec_events` itself so
   * that table keeps one owner, while the transition and its audit row stay
   * in one transaction (`audited-transitions`).
   */
  appendEvent(event: SpecEventInput): SpecEventRow;
}

/**
 * The durable half of a post-launch non-blocking capture. The caller states
 * the whole row because what a discovery carries — which run found it, which
 * revision its ids resolve in, whether it blocked that run — is a capture
 * decision, not a storage one. The audit event lands in the same transaction.
 */
export interface RecordDeliveryDiscoveryInput {
  readonly discovery: SpecDeliveryDiscoveryRow;
  readonly eventType: SpecEventInput["event_type"];
  readonly actor: ActorProvenance | { kind: "system" };
}

/**
 * The audit row is returned alongside the discovery so the caller can publish
 * the SSE half after the commit without writing a second durable event.
 */
export interface RecordDeliveryDiscoveryResult {
  readonly discovery: SpecDeliveryDiscoveryRow;
  readonly event: SpecEventRow;
}

export interface SpecDeliveryPlanRepo {
  /**
   * Creates the attempt row. The caller states the whole row because what a
   * newly opened attempt carries — the seeded document, the delta basis it
   * was computed against — is a planning decision, not a storage one.
   */
  open(input: OpenDeliveryPlanAttemptInput): SpecDeliveryPlanAttemptRow;
  findAttemptById(attemptId: string): SpecDeliveryPlanAttemptRow | null;
  findAttemptsBySpecId(specId: string): SpecDeliveryPlanAttemptRow[];
  saveDraft(input: SaveDeliveryPlanDraftInput): SpecDeliveryPlanAttemptRow;
  reaffirmDraft(
    input: ReaffirmDeliveryPlanDraftInput,
  ): SpecDeliveryPlanAttemptRow;
  propose(input: ProposeDeliveryPlanInput): ProposeDeliveryPlanResult;
  reopen(input: ReopenDeliveryPlanInput): ReopenDeliveryPlanResult;
  recordTransition(input: {
    readonly attemptId: string;
    readonly transition: DeliveryPlanTransition;
    readonly occurredAt: string;
    readonly actor: ActorProvenance;
  }): SpecDeliveryPlanAttemptRow;
  findSnapshotById(snapshotId: string): SpecDeliveryPlanSnapshotRow | null;
  findSnapshotsByAttemptId(attemptId: string): SpecDeliveryPlanSnapshotRow[];
  addComment(input: AddDeliveryPlanCommentInput): SpecDeliveryPlanCommentRow;
  findCommentsByAttemptId(attemptId: string): SpecDeliveryPlanCommentRow[];
  recordDiscovery(
    input: RecordDeliveryDiscoveryInput,
  ): RecordDeliveryDiscoveryResult;
  /**
   * Every discovery this spec has captured, oldest first. The seed reads the
   * whole set rather than one execution's, because a blocking capture
   * abandons the run that found it — so that run is never the delta basis the
   * next attempt is measured against, and a per-execution read would drop
   * exactly the discovery the replacement plan exists to carry.
   */
  findDiscoveriesBySpecId(specId: string): SpecDeliveryDiscoveryRow[];
}

/**
 * Named in the reopen refusal because "the plan is launched" without the exits
 * is exactly the state-with-no-exit this workstream exists to remove. The list
 * itself is owned by `delivery-plan.ts`, so storage cannot drift from what the
 * CLI receipts state.
 */
const POST_LAUNCH_PATHS = (executionId: string) =>
  postLaunchPathsSentence({ executionId });

export function createSpecDeliveryPlanRepo(
  db: Db,
  deps: SpecDeliveryPlanRepoDeps,
): SpecDeliveryPlanRepo {
  const insertAttemptStmt = db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
       draft_revision, content_json, proposed_snapshot_id, approval_json,
       prelaunch_json, launched_execution_id, created_at, updated_at
     ) VALUES (
       @id, @spec_id, @pinned_revision_id, @delta_basis_execution_id, @status,
       @draft_revision, @content_json, @proposed_snapshot_id, @approval_json,
       @prelaunch_json, @launched_execution_id, @created_at, @updated_at
     )`,
  );
  const findAttemptStmt = db.prepare(
    "SELECT * FROM spec_delivery_plan_attempts WHERE id = ? LIMIT 1",
  );
  const findAttemptsBySpecStmt = db.prepare(
    `SELECT * FROM spec_delivery_plan_attempts
     WHERE spec_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const updateAttemptStmt = db.prepare(
    `UPDATE spec_delivery_plan_attempts SET
       status = @status,
       draft_revision = @draft_revision,
       content_json = @content_json,
       proposed_snapshot_id = @proposed_snapshot_id,
       approval_json = @approval_json,
       prelaunch_json = @prelaunch_json,
       launched_execution_id = @launched_execution_id,
       updated_at = @updated_at
     WHERE id = @id`,
  );
  const insertSnapshotStmt = db.prepare(
    `INSERT INTO spec_delivery_plan_snapshots (
       id, attempt_id, candidate_id, candidate_hash, draft_revision,
       content_json, pinned_revision_id, proposed_at, proposed_by_json
     ) VALUES (
       @id, @attempt_id, @candidate_id, @candidate_hash, @draft_revision,
       @content_json, @pinned_revision_id, @proposed_at, @proposed_by_json
     )`,
  );
  const findSnapshotStmt = db.prepare(
    "SELECT * FROM spec_delivery_plan_snapshots WHERE id = ? LIMIT 1",
  );
  const findSnapshotsByAttemptStmt = db.prepare(
    `SELECT * FROM spec_delivery_plan_snapshots
     WHERE attempt_id = ?
     ORDER BY draft_revision ASC, id ASC`,
  );
  const insertCommentStmt = db.prepare(
    `INSERT INTO spec_delivery_plan_comments (
       id, attempt_id, context_id, body, author_json, created_at
     ) VALUES (
       @id, @attempt_id, @context_id, @body, @author_json, @created_at
     )`,
  );
  const findCommentsByAttemptStmt = db.prepare(
    `SELECT * FROM spec_delivery_plan_comments
     WHERE attempt_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const insertDiscoveryStmt = db.prepare(
    `INSERT INTO spec_delivery_discoveries (
       id, spec_id, execution_id, attempt_id, pinned_revision_id,
       discovered_task_json, blocking_reason, captured_by_json, captured_at
     ) VALUES (
       @id, @spec_id, @execution_id, @attempt_id, @pinned_revision_id,
       @discovered_task_json, @blocking_reason, @captured_by_json, @captured_at
     )`,
  );
  const findDiscoveriesBySpecStmt = db.prepare(
    `SELECT * FROM spec_delivery_discoveries
     WHERE spec_id = ?
     ORDER BY captured_at ASC, id ASC`,
  );

  function readAttempt(attemptId: string): SpecDeliveryPlanAttemptRow | null {
    return readOne(
      specDeliveryPlanAttemptRowSchema,
      "spec_delivery_plan_attempt",
      attemptId,
      () => findAttemptStmt.get(attemptId),
    );
  }

  function requireAttempt(attemptId: string): SpecDeliveryPlanAttemptRow {
    const attempt = readAttempt(attemptId);
    if (attempt === null) throw new DeliveryPlanAttemptNotFoundError(attemptId);
    return attempt;
  }

  function requireDraft(
    attempt: SpecDeliveryPlanAttemptRow,
    expectedDraftRevision: number,
  ): void {
    if (attempt.status !== "draft") {
      throw new DeliveryPlanStatusConflictError(
        attempt.id,
        attempt.status,
        attempt.status === "launched" && attempt.launched_execution_id !== null
          ? POST_LAUNCH_PATHS(attempt.launched_execution_id)
          : attempt.status === "abandoned"
            ? "Open a fresh attempt with `cctl spec plan open --seed-from last`."
            : "Return it to draft with `cctl spec plan reopen` before editing it.",
      );
    }
    if (attempt.draft_revision !== expectedDraftRevision) {
      throw new StaleDeliveryPlanDraftError(
        attempt.id,
        expectedDraftRevision,
        attempt.draft_revision,
      );
    }
  }

  function appendPlanEvent(
    attempt: SpecDeliveryPlanAttemptRow,
    occurredAt: string,
    actor: ActorProvenance | { kind: "system" },
    eventType: SpecEventInput["event_type"],
    payload: Record<string, unknown>,
  ): void {
    deps.appendEvent({
      spec_id: attempt.spec_id,
      occurred_at: occurredAt,
      event_type: eventType,
      actor_json: stableStringify(actor),
      payload_json: stableStringify({ attemptId: attempt.id, ...payload }),
    });
  }

  // The comment and its audit row land together: a note stored with no event
  // behind it is a service-layer bypass write (`audited-transitions`).
  const addCommentTx = db.transaction(
    (input: AddDeliveryPlanCommentInput): SpecDeliveryPlanCommentRow => {
      const comment = specDeliveryPlanCommentRowSchema.parse(input.comment);
      const attempt = requireAttempt(comment.attempt_id);
      insertCommentStmt.run(comment);
      appendPlanEvent(
        attempt,
        comment.created_at,
        input.actor,
        "spec-delivery-plan-commented",
        { commentId: comment.id, contextId: comment.context_id },
      );
      return comment;
    },
  );

  const openTx = db.transaction((input: OpenDeliveryPlanAttemptInput) => {
    const parsed = specDeliveryPlanAttemptRowSchema.parse(input.attempt);
    const attempt = {
      ...parsed,
      content_json: canonicalDeliveryPlanEnvelopeBytes(
        deliveryPlanDocumentSchema.parse(JSON.parse(parsed.content_json)),
      ),
    };
    insertAttemptStmt.run(attempt);
    appendPlanEvent(
      attempt,
      input.occurredAt,
      input.actor,
      "spec-delivery-plan-opened",
      {
        pinnedRevisionId: attempt.pinned_revision_id,
        deltaBasisExecutionId: attempt.delta_basis_execution_id,
        draftRevision: attempt.draft_revision,
      },
    );
    return attempt;
  });

  const saveDraftTx = db.transaction((input: SaveDeliveryPlanDraftInput) => {
    const attempt = requireAttempt(input.attemptId);
    requireDraft(attempt, input.expectedDraftRevision);
    // A content edit is not a status transition, so it carries no audit row:
    // the durable trail an approval rests on starts at propose, which freezes
    // exactly what was edited.
    const next: SpecDeliveryPlanAttemptRow = {
      ...attempt,
      draft_revision: attempt.draft_revision + 1,
      content_json: canonicalDeliveryPlanEnvelopeBytes(
        deliveryPlanDocumentSchema.parse(input.document),
      ),
      updated_at: input.updatedAt,
    };
    updateAttemptStmt.run(next);
    return next;
  });

  const reaffirmDraftTx = db.transaction(
    (input: ReaffirmDeliveryPlanDraftInput): SpecDeliveryPlanAttemptRow => {
      const attempt = requireAttempt(input.attemptId);
      requireDraft(attempt, input.expectedDraftRevision);
      const document = deliveryPlanDocumentSchema.parse(
        JSON.parse(attempt.content_json),
      );
      const disposition = document.binding.dispositions.find(
        (entry) => entry.criterionElementId === input.criterionElementId,
      );
      if (disposition?.disposition !== "pending_reaffirmation") {
        throw new DeliveryPlanReaffirmationStateError(
          attempt.id,
          input.criterionElementId,
        );
      }
      const nextDocument = deliveryPlanDocumentSchema.parse({
        ...document,
        binding: {
          ...document.binding,
          dispositions: document.binding.dispositions.map((entry) =>
            entry.criterionElementId === input.criterionElementId
              ? { ...entry, disposition: "reaffirmed" as const }
              : entry,
          ),
        },
      });
      const next: SpecDeliveryPlanAttemptRow = {
        ...attempt,
        draft_revision: attempt.draft_revision + 1,
        content_json: canonicalDeliveryPlanEnvelopeBytes(nextDocument),
        updated_at: input.reaffirmedAt,
      };
      updateAttemptStmt.run(next);
      appendPlanEvent(
        next,
        input.reaffirmedAt,
        input.actor,
        "spec-delivery-plan-reaffirmed",
        {
          criterionElementId: input.criterionElementId,
          draftRevision: next.draft_revision,
        },
      );
      return next;
    },
  );

  const proposeTx = db.transaction((input: ProposeDeliveryPlanInput) => {
    const attempt = requireAttempt(input.attemptId);
    requireDraft(attempt, input.expectedDraftRevision);
    deliveryPlanDocumentSchema.parse(JSON.parse(attempt.content_json));
    const record = input.candidate.record;
    const candidate = finalizedDeliveryPlanCandidateIdentitySchema.parse({
      candidateId: record.candidateId,
      candidateHash: input.candidate.candidateHash,
    });
    const mismatchedField =
      record.specId !== attempt.spec_id
        ? "specId does not match the attempt"
        : record.attemptId !== attempt.id
          ? "attemptId does not match the attempt"
          : record.pinnedRevisionId !== attempt.pinned_revision_id
            ? "pinnedRevisionId does not match the attempt"
            : record.draftRevision !== attempt.draft_revision
              ? "draftRevision does not match the attempt"
              : deliveryPlanCandidateHash(record) !== candidate.candidateHash
                ? "candidateHash does not match the canonical candidate bytes"
                : null;
    if (mismatchedField !== null) {
      throw new FinalizedDeliveryPlanCandidateMismatchError(
        attempt.id,
        mismatchedField,
      );
    }
    const snapshot = specDeliveryPlanSnapshotRowSchema.parse({
      id: input.snapshotId,
      attempt_id: attempt.id,
      candidate_id: candidate.candidateId,
      candidate_hash: candidate.candidateHash,
      draft_revision: attempt.draft_revision,
      content_json: canonicalDeliveryPlanCandidateBytes(record),
      pinned_revision_id: attempt.pinned_revision_id,
      proposed_at: input.proposedAt,
      proposed_by_json: stableStringify(input.actor),
    });
    insertSnapshotStmt.run(snapshot);
    const next: SpecDeliveryPlanAttemptRow = {
      ...attempt,
      status: "proposed",
      proposed_snapshot_id: snapshot.id,
      updated_at: input.proposedAt,
    };
    updateAttemptStmt.run(next);
    appendPlanEvent(
      next,
      input.proposedAt,
      input.actor,
      "spec-delivery-plan-proposed",
      {
        snapshotId: snapshot.id,
        candidateId: candidate.candidateId,
        candidateHash: candidate.candidateHash,
        draftRevision: snapshot.draft_revision,
        pinnedRevisionId: snapshot.pinned_revision_id,
      },
    );
    return { attempt: next, snapshot };
  });

  const reopenTx = db.transaction((input: ReopenDeliveryPlanInput) => {
    const attempt = requireAttempt(input.attemptId);
    if (attempt.status === "draft") {
      throw new DeliveryPlanStatusConflictError(
        attempt.id,
        attempt.status,
        "There is nothing to reopen. Edit it with `cctl spec plan edit --file <plan.json>`.",
      );
    }
    if (
      attempt.status === "launched" &&
      attempt.launched_execution_id !== null
    ) {
      throw new DeliveryPlanStatusConflictError(
        attempt.id,
        attempt.status,
        POST_LAUNCH_PATHS(attempt.launched_execution_id),
      );
    }
    if (attempt.status === "abandoned") {
      throw new DeliveryPlanStatusConflictError(
        attempt.id,
        attempt.status,
        "Open a fresh attempt with `cctl spec plan open --seed-from last`.",
      );
    }
    const approval =
      attempt.approval_json === null
        ? null
        : parseRow(
            finalizedDeliveryPlanApprovalSchema,
            "spec_delivery_plan_approval",
            attempt.id,
            JSON.parse(attempt.approval_json),
          );
    const next: SpecDeliveryPlanAttemptRow = {
      ...attempt,
      status: "draft",
      draft_revision: attempt.draft_revision + 1,
      proposed_snapshot_id: null,
      approval_json: null,
      updated_at: input.reopenedAt,
    };
    updateAttemptStmt.run(next);
    appendPlanEvent(
      next,
      input.reopenedAt,
      input.actor,
      "spec-delivery-plan-reopened",
      {
        from: attempt.status,
        reason: input.reason,
        draftRevision: next.draft_revision,
        invalidatedApprovedSnapshotId: approval?.snapshotId ?? null,
        invalidatedCandidateHash: approval?.candidateHash ?? null,
      },
    );
    return {
      attempt: next,
      invalidatedApproval:
        approval === null
          ? null
          : {
              snapshotId: approval.snapshotId,
              candidateHash: approval.candidateHash,
            },
    };
  });

  /**
   * The candidate identity the attempt's live proposal actually carries, read
   * inside the transaction that is about to act on it. Null when the attempt
   * has frozen nothing, or when the snapshot's candidate row is missing —
   * neither is recoverable by recompiling, so both refuse.
   */
  function liveCandidateIdentity(
    attempt: SpecDeliveryPlanAttemptRow,
  ): FinalizedDeliveryPlanCandidateIdentity | null {
    const snapshotId = attempt.proposed_snapshot_id;
    if (snapshotId === null) return null;
    const snapshot = readOne(
      specDeliveryPlanSnapshotRowSchema,
      "spec_delivery_plan_snapshot",
      snapshotId,
      () => findSnapshotStmt.get(snapshotId),
    );
    if (
      snapshot === null ||
      snapshot.candidate_id === null ||
      snapshot.candidate_hash === null
    ) {
      return null;
    }
    return {
      candidateId: snapshot.candidate_id,
      candidateHash: snapshot.candidate_hash,
    };
  }

  const recordTransitionTx = db.transaction(
    (input: {
      readonly attemptId: string;
      readonly transition: DeliveryPlanTransition;
      readonly occurredAt: string;
      readonly actor: ActorProvenance;
    }) => {
      const attempt = requireAttempt(input.attemptId);
      if (input.transition.kind !== "abandon") {
        const stored = liveCandidateIdentity(attempt);
        if (
          stored === null ||
          stored.candidateId !== input.transition.candidateId ||
          stored.candidateHash !== input.transition.candidateHash
        ) {
          throw new FinalizedDeliveryPlanApprovalIdentityMismatchError(
            attempt.id,
            {
              candidateId: input.transition.candidateId,
              candidateHash: input.transition.candidateHash,
            },
            stored,
          );
        }
      }
      const next = applyTransition(attempt, input);
      updateAttemptStmt.run(next);
      appendPlanEvent(
        next,
        input.occurredAt,
        input.actor,
        "spec-delivery-plan-transitioned",
        {
          from: attempt.status,
          to: next.status,
          transition: input.transition,
        },
      );
      return next;
    },
  );

  const recordDiscoveryTx = db.transaction(
    (input: RecordDeliveryDiscoveryInput) => {
      const discovery = specDeliveryDiscoveryRowSchema.parse(input.discovery);
      insertDiscoveryStmt.run(discovery);
      const event = deps.appendEvent({
        spec_id: discovery.spec_id,
        occurred_at: discovery.captured_at,
        event_type: input.eventType,
        actor_json: stableStringify(input.actor),
        payload_json: stableStringify({
          kind: "discovery_captured",
          discoveryId: discovery.id,
          executionId: discovery.execution_id,
          attemptId: discovery.attempt_id,
          revisionId: discovery.pinned_revision_id,
          blockingReason: discovery.blocking_reason,
        }),
      });
      return { discovery, event };
    },
  );

  return {
    open(input) {
      return timed("open", "spec_delivery_plan_attempt", input.attempt.id, () =>
        openTx(input),
      );
    },
    findAttemptById(attemptId) {
      return readAttempt(attemptId);
    },
    findAttemptsBySpecId(specId) {
      return readMany(
        specDeliveryPlanAttemptRowSchema,
        "spec_delivery_plan_attempt",
        `spec:${specId}`,
        () => findAttemptsBySpecStmt.all(specId),
      );
    },
    saveDraft(input) {
      return timed(
        "save_draft",
        "spec_delivery_plan_attempt",
        input.attemptId,
        () => saveDraftTx(input),
      );
    },
    reaffirmDraft(input) {
      return timed(
        "reaffirm_draft",
        "spec_delivery_plan_attempt",
        input.attemptId,
        () => reaffirmDraftTx(input),
      );
    },
    propose(input) {
      return timed(
        "propose",
        "spec_delivery_plan_attempt",
        input.attemptId,
        () => proposeTx(input),
      );
    },
    reopen(input) {
      return timed(
        "reopen",
        "spec_delivery_plan_attempt",
        input.attemptId,
        () => reopenTx(input),
      );
    },
    recordTransition(input) {
      return timed(
        "record_transition",
        "spec_delivery_plan_attempt",
        input.attemptId,
        () => recordTransitionTx(input),
      );
    },
    findSnapshotById(snapshotId) {
      return readOne(
        specDeliveryPlanSnapshotRowSchema,
        "spec_delivery_plan_snapshot",
        snapshotId,
        () => findSnapshotStmt.get(snapshotId),
      );
    },
    findSnapshotsByAttemptId(attemptId) {
      return readMany(
        specDeliveryPlanSnapshotRowSchema,
        "spec_delivery_plan_snapshot",
        `attempt:${attemptId}`,
        () => findSnapshotsByAttemptStmt.all(attemptId),
      );
    },
    addComment(input) {
      return timed(
        "addComment",
        "spec_delivery_plan_comment",
        input.comment.id,
        () => addCommentTx(input),
      );
    },
    findCommentsByAttemptId(attemptId) {
      return readMany(
        specDeliveryPlanCommentRowSchema,
        "spec_delivery_plan_comment",
        `attempt:${attemptId}`,
        () => findCommentsByAttemptStmt.all(attemptId),
      );
    },
    recordDiscovery(input) {
      return timed(
        "record_discovery",
        "spec_delivery_discovery",
        input.discovery.id,
        () => recordDiscoveryTx(input),
      );
    },
    findDiscoveriesBySpecId(specId) {
      return readMany(
        specDeliveryDiscoveryRowSchema,
        "spec_delivery_discovery",
        `spec:${specId}`,
        () => findDiscoveriesBySpecStmt.all(specId),
      );
    },
  };
}

/**
 * The snapshot an approval names. The identity check in `recordTransition`
 * has already refused an attempt with no live proposal, so reaching here with
 * a null snapshot id would mean the two disagree — a bug, not a caller error.
 */
function requireProposedSnapshotId(
  attempt: SpecDeliveryPlanAttemptRow,
): string {
  const snapshotId = attempt.proposed_snapshot_id;
  if (snapshotId === null) {
    throw new Error(
      `delivery plan attempt ${attempt.id} passed the candidate identity check with no proposed snapshot`,
    );
  }
  return snapshotId;
}

function applyTransition(
  attempt: SpecDeliveryPlanAttemptRow,
  input: {
    readonly transition: DeliveryPlanTransition;
    readonly occurredAt: string;
    readonly actor: ActorProvenance;
  },
): SpecDeliveryPlanAttemptRow {
  const transition = input.transition;
  if (transition.kind === "approve") {
    if (attempt.status !== "proposed" && attempt.status !== "parked") {
      throw new DeliveryPlanStatusConflictError(
        attempt.id,
        attempt.status,
        "Only a live proposal can be approved. Propose the draft with `cctl spec plan propose` first.",
      );
    }
    const approval: FinalizedDeliveryPlanApproval = {
      snapshotId: requireProposedSnapshotId(attempt),
      candidateId: transition.candidateId,
      candidateHash: transition.candidateHash,
      approvedAt: input.occurredAt,
      approvedBy: input.actor,
    };
    return {
      ...attempt,
      status: "approved",
      approval_json: stableStringify(
        finalizedDeliveryPlanApprovalSchema.parse(approval),
      ),
      updated_at: input.occurredAt,
    };
  }
  if (transition.kind === "park") {
    if (attempt.status !== "proposed" && attempt.status !== "approved") {
      throw new DeliveryPlanStatusConflictError(
        attempt.id,
        attempt.status,
        "Only a proposed or approved attempt can be parked for prelaunch review. Propose the draft with `cctl spec plan propose` first.",
      );
    }
    const prelaunch: FinalizedDeliveryPlanPrelaunch = {
      parkedAt: input.occurredAt,
      parkedBy: input.actor,
      reason: transition.reason,
      candidate: {
        candidateId: transition.candidateId,
        candidateHash: transition.candidateHash,
      },
      approvedAtPark: attempt.status === "approved",
    };
    return {
      ...attempt,
      status: "parked",
      prelaunch_json: stableStringify(
        finalizedDeliveryPlanPrelaunchSchema.parse(prelaunch),
      ),
      updated_at: input.occurredAt,
    };
  }
  if (transition.kind === "launch") {
    if (
      (attempt.status !== "approved" && attempt.status !== "parked") ||
      attempt.approval_json === null
    ) {
      throw new DeliveryPlanStatusConflictError(
        attempt.id,
        attempt.status,
        attempt.status === "launched" || attempt.status === "abandoned"
          ? "Open a fresh attempt with `cctl spec plan open --seed-from last`."
          : "Only an approved candidate launches. Sign the proposal off with `cctl spec plan sign-off` first.",
      );
    }
    return {
      ...attempt,
      status: "launched",
      launched_execution_id: transition.executionId,
      updated_at: input.occurredAt,
    };
  }
  if (attempt.status === "abandoned") {
    throw new DeliveryPlanStatusConflictError(
      attempt.id,
      attempt.status,
      "Open a fresh attempt with `cctl spec plan open --seed-from last`.",
    );
  }
  return { ...attempt, status: "abandoned", updated_at: input.occurredAt };
}
