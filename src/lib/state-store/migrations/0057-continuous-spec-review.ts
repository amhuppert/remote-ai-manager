import { createLogger } from "@/lib/logging";
import {
  serializeSubjectFingerprint,
  subjectFingerprint,
  type SubjectFingerprint,
} from "@/lib/specs/approval-applicability";
import {
  revisionCitationSchema,
  revisionElementSchema,
  type RevisionCitation,
  type RevisionElement,
} from "@/lib/specs/revision-diff";

import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import { closeWithdrawnRevisionApprovalRequests } from "./0056-close-withdrawn-revision-approval-requests";
import type { MigrationContext, StateMigration } from "./types";

const logger = createLogger("state-store.migrations");

export const CONTINUOUS_SPEC_REVIEW_SCHEMA_VERSION = 23;

type Db = MigrationContext["db"];

interface UnfingerprintedApprovalRow {
  readonly id: string;
  readonly subject_kind: "requirement" | "decision" | "plan";
  readonly element_id: string | null;
  readonly revision_id: string;
}

interface ProposedRevisionRow {
  readonly id: string;
  readonly spec_id: string;
}

/**
 * A spec revision is reviewed while it stays an editable draft; sign-off is
 * the only freeze. Three things older builds wrote have no place in that
 * model:
 *
 * - Content approvals named only the revision the human read, which worked
 *   because that revision was frozen. An approval now records the subject
 *   fingerprint itself, so each existing one is back-filled from the rows of
 *   the revision it was granted on — every such revision was frozen when it
 *   was granted, so its rows are exactly what the human read.
 * - A `proposed` revision becomes the spec's open draft, or is withdrawn when
 *   the spec already has one (a spec carries one editable revision). Its
 *   approvals keep the fingerprints back-filled above, so reopening it loses
 *   no review work.
 * - The #50 supersession markers described proposals that can no longer
 *   exist.
 * - A delivery-plan attempt is reviewed as a draft and signed off in one act,
 *   so a `proposed` attempt, or one parked without a sign-off, has no state
 *   to become: both are abandoned, and the operator opens a fresh attempt.
 *   A signed parked attempt loses only its `approvedAtPark` flag, which every
 *   parked attempt now satisfies.
 *
 * Older builds would treat an approval granted on a draft as pinned by its
 * revision id and could write `proposed` rows this build cannot read, so the
 * schema version fences them out.
 */
export const continuousSpecReview: StateMigration = {
  name: "0057-continuous-spec-review",
  up: async ({ context }) => {
    const { db } = context;
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        CONTINUOUS_SPEC_REVIEW_SCHEMA_VERSION,
      );
    }
    const outcome = db
      .transaction(() => {
        enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
        const backfilled = backfillApprovalFingerprints(db);
        const revisions = retireProposedRevisions(db);
        const abandonedAttempts = retireUnsignedPlanAttempts(db);
        db.exec("DROP TABLE IF EXISTS spec_revision_supersessions");
        db.prepare(
          "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
        ).run(
          CONTINUOUS_SPEC_REVIEW_SCHEMA_VERSION,
          "spec revisions are reviewed as drafts; approvals record subject fingerprints",
        );
        return { backfilled, abandonedAttempts, ...revisions };
      })
      .immediate();
    // A proposal withdrawn here leaves the approval requests filed against
    // it open; 0056 is the idempotent repair for exactly that.
    if (outcome.withdrawn > 0) {
      await closeWithdrawnRevisionApprovalRequests.up({
        name: closeWithdrawnRevisionApprovalRequests.name,
        context,
      });
    }
    logger.info("state-store.migrations.continuous_spec_review.complete", {
      backfilledApprovals: outcome.backfilled,
      reopenedDrafts: outcome.reopened,
      withdrawnProposals: outcome.withdrawn,
      abandonedPlanAttempts: outcome.abandonedAttempts,
    });
  },
};

function backfillApprovalFingerprints(db: Db): number {
  const approvals = db
    .prepare(
      `SELECT id, subject_kind, element_id, revision_id
       FROM spec_approvals
       WHERE subject_kind <> 'revision' AND subject_fingerprint_json IS NULL`,
    )
    .all() as UnfingerprintedApprovalRow[];
  const stateByRevision = new Map<string, RevisionState>();
  const update = db.prepare(
    `UPDATE spec_approvals
     SET subject_fingerprint_json = ?, validity = COALESCE(?, validity)
     WHERE id = ?`,
  );
  for (const approval of approvals) {
    let state = stateByRevision.get(approval.revision_id);
    if (state === undefined) {
      state = readRevisionState(db, approval.revision_id);
      stateByRevision.set(approval.revision_id, state);
    }
    const fingerprint = subjectFingerprint(
      state.rows,
      { subjectKind: approval.subject_kind, elementId: approval.element_id },
      state,
    );
    // A revision that never carried the subject approved nothing; an empty
    // fingerprint matches no content, and closing the row says so.
    update.run(
      serializeSubjectFingerprint(fingerprint ?? emptyFingerprint(state)),
      fingerprint === null ? "closed" : null,
      approval.id,
    );
  }
  return approvals.length;
}

interface RevisionState {
  readonly rows: RevisionElement[];
  readonly citationContractVersion: 1 | 2;
  readonly citations: RevisionCitation[];
}

function readRevisionState(db: Db, revisionId: string): RevisionState {
  const rows = (
    db
      .prepare(
        `SELECT versions.element_id, elements.parent_element_id,
                versions.payload_hash, versions.payload_json
         FROM spec_element_versions versions
         JOIN spec_elements elements ON elements.id = versions.element_id
         WHERE versions.revision_id = ?`,
      )
      .all(revisionId) as {
      element_id: string;
      parent_element_id: string | null;
      payload_hash: string;
      payload_json: string;
    }[]
  ).map((row) =>
    revisionElementSchema.parse({
      elementId: row.element_id,
      parentElementId: row.parent_element_id,
      payloadHash: row.payload_hash,
      payload: JSON.parse(row.payload_json),
    }),
  );
  const contract = db
    .prepare(
      "SELECT citation_contract_version FROM spec_revisions WHERE id = ?",
    )
    .get(revisionId) as { citation_contract_version: 1 | 2 } | undefined;
  const citations = (
    db
      .prepare(
        `SELECT element_id, assumption_id, assumption_snapshot_json
         FROM spec_revision_assumption_citations
         WHERE revision_id = ?`,
      )
      .all(revisionId) as {
      element_id: string;
      assumption_id: string;
      assumption_snapshot_json: string;
    }[]
  ).map((row) =>
    revisionCitationSchema.parse({
      elementId: row.element_id,
      assumptionId: row.assumption_id,
      snapshot: JSON.parse(row.assumption_snapshot_json),
    }),
  );
  return {
    rows,
    citationContractVersion: contract?.citation_contract_version ?? 2,
    citations,
  };
}

function emptyFingerprint(state: RevisionState): SubjectFingerprint {
  const fingerprint = subjectFingerprint(
    [],
    { subjectKind: "plan", elementId: null },
    { citationContractVersion: state.citationContractVersion, citations: [] },
  );
  if (fingerprint === null) throw new Error("plan fingerprint is never null");
  return fingerprint;
}

function retireProposedRevisions(db: Db): {
  reopened: number;
  withdrawn: number;
} {
  const proposed = db
    .prepare(
      `SELECT id, spec_id FROM spec_revisions
       WHERE state = 'proposed'
       ORDER BY spec_id, number DESC`,
    )
    .all() as ProposedRevisionRow[];
  const hasDraft = db.prepare(
    "SELECT 1 FROM spec_revisions WHERE spec_id = ? AND state = 'draft' LIMIT 1",
  );
  const reopen = db.prepare(
    `UPDATE spec_revisions
     SET state = 'draft', content_hash = NULL, proposed_at = NULL
     WHERE id = ?`,
  );
  const withdraw = db.prepare(
    "UPDATE spec_revisions SET state = 'withdrawn' WHERE id = ?",
  );
  let reopened = 0;
  let withdrawn = 0;
  // Newest first, so the latest proposal is the one that becomes the draft.
  for (const revision of proposed) {
    if (hasDraft.get(revision.spec_id) === undefined) {
      reopen.run(revision.id);
      reopened += 1;
    } else {
      withdraw.run(revision.id);
      withdrawn += 1;
    }
  }
  return { reopened, withdrawn };
}

function retireUnsignedPlanAttempts(db: Db): number {
  const abandoned = db
    .prepare(
      `UPDATE spec_delivery_plan_attempts
       SET status = 'abandoned', updated_at = ?
       WHERE status = 'proposed'
          OR (status = 'parked' AND approval_json IS NULL)`,
    )
    .run(new Date().toISOString()).changes;
  db.prepare(
    `UPDATE spec_delivery_plan_attempts
     SET prelaunch_json = json_remove(prelaunch_json, '$.approvedAtPark')
     WHERE prelaunch_json IS NOT NULL
       AND json_type(prelaunch_json, '$.approvedAtPark') IS NOT NULL`,
  ).run();
  return abandoned;
}
