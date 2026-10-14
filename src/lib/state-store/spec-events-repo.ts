import type Database from "better-sqlite3";
import { z } from "zod";
import {
  specApprovalRequestScopeSchema,
  specEventRowSchema,
  type SpecApprovalRequestScope,
  type SpecEventRow,
} from "@/lib/specs/schemas";
import { createSpecRepoHelpers } from "./spec-repo-helpers";

type Db = InstanceType<typeof Database>;

const specEventInputSchema = specEventRowSchema.omit({ id: true });
export type SpecEventInput = z.infer<typeof specEventInputSchema>;

const { parseRow, readMany, readOne, timed } = createSpecRepoHelpers(
  "state-store.spec-events",
);

/**
 * The logical identity of an approval request. Requests are not their own
 * table: the durable `spec-attention-changed` event IS the record, and this
 * tuple is what makes a repeat of the same ask the same request rather than a
 * second Needs You entry.
 *
 * A gate-scoped ask is identified without its subject: the subject list a gate
 * is waiting on shrinks as approvals land, so keying on it would move the
 * request's identity under the human who is already looking at it.
 *
 */
export type ApprovalRequestKey = {
  kind: "authoring";
  specId: string;
  revisionId: string;
  gate: string;
  scope: SpecApprovalRequestScope;
  /** Null for a gate-scoped ask, whose identity excludes the subject. */
  subject: string | null;
};

/** One durable approval request that has not been retired. */
export interface OpenApprovalRequest {
  attentionId: string;
  revisionId: string | null;
  gate: string;
  /** Null on requests recorded before request scope existed. */
  scope: SpecApprovalRequestScope | null;
  subject: string;
}

export interface SpecEventsRepo {
  append(event: SpecEventInput): SpecEventRow;
  /** Leaves transaction ownership with the calling service mutation. */
  appendInTransaction(event: SpecEventInput): SpecEventRow;
  findEventById(id: number): SpecEventRow | null;
  findBySpecId(specId: string): SpecEventRow[];
  /** The attention id already issued for this ask, or null. */
  findApprovalRequest(key: ApprovalRequestKey): { attentionId: string } | null;
  /**
   * Every approval request the spec still carries, oldest first. The review
   * domain reads it to decide which attention entries an act satisfies, so
   * notification storage never has to infer that from a request's subject.
   */
  listOpenApprovalRequests(specId: string): OpenApprovalRequest[];
}

export function createSpecEventsRepo(db: Db): SpecEventsRepo {
  const insertEventStmt = db.prepare(
    `INSERT INTO spec_events (
       spec_id, occurred_at, event_type, actor_json, payload_json
     ) VALUES (
       @spec_id, @occurred_at, @event_type, @actor_json, @payload_json
     )`,
  );
  const findEventStmt = db.prepare(
    "SELECT * FROM spec_events WHERE id = ? LIMIT 1",
  );
  const findBySpecStmt = db.prepare(
    `SELECT * FROM spec_events
     WHERE spec_id = ?
     ORDER BY id ASC`,
  );
  // A retired request is gone from identity and from resolution alike: its
  // events stay as history, but nothing new may land on it.
  const notRetiredClause = `json_extract(payload_json, '$.attentionId') NOT IN (
         SELECT json_extract(payload_json, '$.attentionId')
         FROM spec_events
         WHERE spec_id = @spec_id
           AND event_type = 'spec-attention-changed'
           AND json_extract(payload_json, '$.kind') = 'approval-request-retired'
       )`;
  const requestSelect = `SELECT json_extract(payload_json, '$.attentionId') AS attention_id
     FROM spec_events
     WHERE spec_id = @spec_id
       AND event_type = 'spec-attention-changed'
       AND json_extract(payload_json, '$.kind') = 'approval-requested'`;
  // Matching `scope` exactly is also what keeps a pre-boundary request (which
  // carries none) from being reused as a scoped one.
  const findAuthoringRequestStmt = db.prepare(
    `${requestSelect}
       AND json_extract(payload_json, '$.revisionId') = @revision_id
       AND json_extract(payload_json, '$.gate') = @gate
       AND json_extract(payload_json, '$.scope') = @scope
       AND (@subject IS NULL OR json_extract(payload_json, '$.subject') = @subject)
       AND ${notRetiredClause}
     ORDER BY id ASC
     LIMIT 1`,
  );
  const listOpenRequestsStmt = db.prepare(
    `SELECT json_extract(payload_json, '$.attentionId') AS attention_id,
            json_extract(payload_json, '$.revisionId') AS revision_id,
            json_extract(payload_json, '$.gate') AS gate,
            json_extract(payload_json, '$.scope') AS scope,
            json_extract(payload_json, '$.subject') AS subject
     FROM spec_events
     WHERE spec_id = @spec_id
       AND event_type = 'spec-attention-changed'
       AND json_extract(payload_json, '$.kind') = 'approval-requested'
       AND ${notRetiredClause}
     ORDER BY id ASC`,
  );
  const attentionIdRowSchema = z.object({
    attention_id: z.string().min(1),
  });
  const openRequestRowSchema = z.object({
    attention_id: z.string().min(1),
    revision_id: z.string().min(1).nullable(),
    gate: z.string().min(1),
    scope: specApprovalRequestScopeSchema.nullable(),
    subject: z.string().min(1),
  });

  function appendInTransaction(event: SpecEventInput): SpecEventRow {
    return timed("append", "spec_event", event.spec_id, () => {
      const validated = parseRow(
        specEventInputSchema,
        "spec_event_input",
        event.spec_id,
        event,
      );
      const result = insertEventStmt.run(validated);
      return parseRow(
        specEventRowSchema,
        "spec_event",
        String(result.lastInsertRowid),
        {
          id: Number(result.lastInsertRowid),
          ...validated,
        },
      );
    });
  }

  return {
    append: appendInTransaction,
    appendInTransaction,
    findEventById(id) {
      return timed("find_by_id", "spec_event", String(id), () =>
        readOne(specEventRowSchema, "spec_event", String(id), () =>
          findEventStmt.get(id),
        ),
      );
    },
    findBySpecId(specId) {
      return timed("find_by_spec", "spec_event", specId, () =>
        readMany(specEventRowSchema, "spec_event", `spec:${specId}`, () =>
          findBySpecStmt.all(specId),
        ),
      );
    },
    findApprovalRequest(key) {
      const raw: unknown = findAuthoringRequestStmt.get({
        spec_id: key.specId,
        revision_id: key.revisionId,
        gate: key.gate,
        scope: key.scope,
        subject: key.subject,
      });
      if (raw === undefined) return null;
      const parsed = attentionIdRowSchema.safeParse(raw);
      return parsed.success ? { attentionId: parsed.data.attention_id } : null;
    },
    listOpenApprovalRequests(specId) {
      return timed("list_open_requests", "spec_event", specId, () =>
        readMany(
          openRequestRowSchema,
          "spec_approval_request",
          `spec:${specId}`,
          () => listOpenRequestsStmt.all({ spec_id: specId }),
        ).map((row) => ({
          attentionId: row.attention_id,
          revisionId: row.revision_id,
          gate: row.gate,
          scope: row.scope,
          subject: row.subject,
        })),
      );
    },
  };
}
