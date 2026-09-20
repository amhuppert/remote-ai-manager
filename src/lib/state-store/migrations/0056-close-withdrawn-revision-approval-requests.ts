import { randomUUID } from "node:crypto";

import { createLogger } from "@/lib/logging";
import { stableStringify } from "../serialization";
import type { MigrationContext, StateMigration } from "./types";

const logger = createLogger("state-store.migrations");

/**
 * Close revision-scoped approval requests whose subject revision was
 * withdrawn. Before this repair, returning from Design to Requirements
 * withdrew the Design revision without retiring the approval requests filed
 * against it, so the register and Needs You queue kept asking for an approval
 * no later act could grant.
 *
 * Execution-scoped requests survive revision withdrawal by design. The same
 * is true for every request carrying an execution id, even if its gate is not
 * recognized by this build: authoring acts own only requests with no run
 * identity. Queue entries already answered by a grant are not resolved again,
 * though the orphaned request is still retired in the event register.
 *
 * Idempotent: the register query skips retired requests, and the queue rows
 * dedupe on the same key the live notifier uses. Purely additive — appended
 * events and notification rows — so no KNOWN_SCHEMA_VERSION bump.
 */

const RETIREMENT_REASON = "the revision it asked about was withdrawn";

interface WithdrawnRevisionRequestRow {
  readonly spec_id: string;
  readonly attention_id: string;
  readonly revision_id: string;
  readonly gate: string;
}

interface OpenQueueRow {
  readonly id: string;
  readonly project_name: string;
  readonly session_name: string | null;
  readonly spec_id: string;
  readonly spec_slug: string;
  readonly spec_name: string;
  readonly spec_gate: string;
  readonly spec_gate_request_id: string;
  readonly spec_deep_link_id: string;
}

function gateLabel(gate: string): string {
  const words = gate.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function withdrawnRevisionOpenRequests(
  db: MigrationContext["db"],
): WithdrawnRevisionRequestRow[] {
  return db
    .prepare(
      `SELECT DISTINCT
              request.spec_id,
              json_extract(request.payload_json, '$.attentionId') AS attention_id,
              json_extract(request.payload_json, '$.revisionId') AS revision_id,
              json_extract(request.payload_json, '$.gate') AS gate
         FROM spec_events AS request
         JOIN spec_revisions AS revision
           ON revision.id = json_extract(request.payload_json, '$.revisionId')
          AND revision.spec_id = request.spec_id
          AND revision.state = 'withdrawn'
        WHERE request.event_type = 'spec-attention-changed'
          AND json_extract(request.payload_json, '$.kind') = 'approval-requested'
          AND json_extract(request.payload_json, '$.executionId') IS NULL
          AND json_extract(request.payload_json, '$.gate') NOT IN ('execution_start', 'delivery')
          AND json_extract(request.payload_json, '$.attentionId') NOT IN (
            SELECT json_extract(payload_json, '$.attentionId')
              FROM spec_events
             WHERE spec_id = request.spec_id
               AND event_type = 'spec-attention-changed'
               AND json_extract(payload_json, '$.kind') = 'approval-request-retired'
          )
        ORDER BY request.id ASC`,
    )
    .all() as WithdrawnRevisionRequestRow[];
}

function openQueueRows(
  db: MigrationContext["db"],
  specId: string,
  attentionId: string,
): OpenQueueRow[] {
  return db
    .prepare(
      `SELECT id, project_name, session_name, spec_id, spec_slug, spec_name,
              spec_gate, spec_gate_request_id, spec_deep_link_id
         FROM notifications
        WHERE source = 'spec'
          AND type = 'spec-approval-requested'
          AND spec_id = ?
          AND spec_gate_request_id = ?
          AND spec_gate_request_id NOT IN (
            SELECT spec_gate_request_id FROM notifications
             WHERE source = 'spec'
               AND spec_id = ?
               AND type IN ('spec-approval-granted', 'spec-attention-resolved')
          )`,
    )
    .all(specId, attentionId, specId) as OpenQueueRow[];
}

export const closeWithdrawnRevisionApprovalRequests: StateMigration = {
  name: "0056-close-withdrawn-revision-approval-requests",
  async up({ context }) {
    const { db } = context;
    const occurredAt = new Date().toISOString();
    const appendRetirement = db.prepare(
      `INSERT INTO spec_events (spec_id, occurred_at, event_type, actor_json, payload_json)
       VALUES (?, ?, 'spec-attention-changed', ?, ?)`,
    );
    const insertResolved = db.prepare(
      `INSERT OR IGNORE INTO notifications (
         id, source, type, title, message, read, project_name, session_name,
         dedupe_key, spec_id, spec_slug, spec_name, spec_gate,
         spec_gate_request_id, spec_deep_link_id, created_at
       ) VALUES (?, 'spec', 'spec-attention-resolved', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    db.transaction(() => {
      for (const request of withdrawnRevisionOpenRequests(db)) {
        const label = gateLabel(request.gate);
        appendRetirement.run(
          request.spec_id,
          occurredAt,
          stableStringify({ kind: "system" }),
          stableStringify({
            kind: "approval-request-retired",
            attentionId: request.attention_id,
            reason: RETIREMENT_REASON,
            active: false,
          }),
        );
        for (const row of openQueueRows(
          db,
          request.spec_id,
          request.attention_id,
        )) {
          insertResolved.run(
            randomUUID(),
            `${label} request closed`,
            `${row.spec_name}: ${RETIREMENT_REASON}`,
            row.project_name,
            row.session_name,
            `spec-attention-resolved:${row.spec_gate_request_id}`,
            row.spec_id,
            row.spec_slug,
            row.spec_name,
            row.spec_gate,
            row.spec_gate_request_id,
            row.spec_deep_link_id,
          );
        }
        logger.info("state-store.withdrawn_revision_approval_request_closed", {
          specId: request.spec_id,
          revisionId: request.revision_id,
          gate: request.gate,
          attentionId: request.attention_id,
        });
      }
    }).immediate();
  },
};
