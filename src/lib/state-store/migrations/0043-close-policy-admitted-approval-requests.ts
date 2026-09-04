import { randomUUID } from "node:crypto";

import { createLogger } from "@/lib/logging";
import { stableStringify } from "../serialization";
import type { MigrationContext, StateMigration } from "./types";

const logger = createLogger("state-store.migrations");

/**
 * Close the execution-scoped approval requests a policy admission already
 * answered. Before #108, a run refused under the Gate dial filed a durable
 * Needs You ask, and a human who then relaxed the dial to Notify let the run
 * proceed without anything retiring that ask: the register still listed it
 * and the queue kept demanding a delivery approval the spec no longer wanted.
 * The gates now retire those asks in the admission transaction; this repairs
 * the databases where the admission landed first.
 *
 * A request is answered when a `spec_gate_admissions` row with a policy basis
 * names the same spec, gate, and execution — the same reading the live gate
 * applies. Requests with no execution id predate run identity and belong to
 * the only run that could have opened them, so an admission for any run at
 * their gate answers them. Human-approval admissions are excluded: the grant
 * path already answers its requests, and a request it left open is a review
 * question, not a repair target.
 *
 * Idempotent: the register query skips retired requests, and the queue rows
 * dedupe on the same key the live notifier uses. Purely additive — appended
 * events and notification rows — so no KNOWN_SCHEMA_VERSION bump.
 */

const GATE_LABEL: Record<string, string> = {
  execution_start: "Execution start",
  delivery: "Delivery",
};

const DIAL_LABEL: Record<string, string> = {
  notify_policy: "Notify",
  off_policy: "Off",
};

interface AnsweredRequestRow {
  readonly spec_id: string;
  readonly project_path: string;
  readonly slug: string;
  readonly attention_id: string;
  readonly gate: string;
  readonly basis: string;
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

function answeredOpenRequests(
  db: MigrationContext["db"],
): AnsweredRequestRow[] {
  return db
    .prepare(
      `SELECT DISTINCT
              request.spec_id,
              specs.project_path,
              specs.slug,
              json_extract(request.payload_json, '$.attentionId') AS attention_id,
              json_extract(request.payload_json, '$.gate') AS gate,
              admission.basis
         FROM spec_events AS request
         JOIN specs ON specs.id = request.spec_id
         JOIN spec_gate_admissions AS admission
           ON admission.spec_id = request.spec_id
          AND admission.gate = json_extract(request.payload_json, '$.gate')
          AND admission.basis IN ('notify_policy', 'off_policy')
          AND admission.execution_id IS NOT NULL
          AND (
            json_extract(request.payload_json, '$.executionId') IS NULL
            OR json_extract(request.payload_json, '$.executionId') = admission.execution_id
          )
        WHERE request.event_type = 'spec-attention-changed'
          AND json_extract(request.payload_json, '$.kind') = 'approval-requested'
          AND json_extract(request.payload_json, '$.gate') IN ('execution_start', 'delivery')
          AND json_extract(request.payload_json, '$.attentionId') NOT IN (
            SELECT json_extract(payload_json, '$.attentionId')
              FROM spec_events
             WHERE spec_id = request.spec_id
               AND event_type = 'spec-attention-changed'
               AND json_extract(payload_json, '$.kind') = 'approval-request-retired'
          )
        ORDER BY request.id ASC`,
    )
    .all() as AnsweredRequestRow[];
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

export const closePolicyAdmittedApprovalRequests: StateMigration = {
  name: "0043-close-policy-admitted-approval-requests",
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
      for (const request of answeredOpenRequests(db)) {
        const gateLabel = GATE_LABEL[request.gate] ?? request.gate;
        const reason = `the ${gateLabel.toLowerCase()} gate admitted the run under ${DIAL_LABEL[request.basis] ?? request.basis}`;
        appendRetirement.run(
          request.spec_id,
          occurredAt,
          stableStringify({ kind: "system" }),
          stableStringify({
            kind: "approval-request-retired",
            attentionId: request.attention_id,
            reason,
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
            `${gateLabel} request closed`,
            `${row.spec_name}: ${reason}`,
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
        logger.info("state-store.policy_admitted_approval_request_closed", {
          specId: request.spec_id,
          gate: request.gate,
          attentionId: request.attention_id,
          basis: request.basis,
        });
      }
    }).immediate();
  },
};
