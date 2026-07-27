import type Database from "better-sqlite3";
import { z } from "zod";
import { specEventRowSchema, type SpecEventRow } from "@/lib/specs/schemas";
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
 * `executionId` is what a per-run gate adds to that identity. Successive runs
 * pin the same approved revision, so without it a second run's ask reads as a
 * repeat of the first and no human is ever told. Revision-scoped gates pass
 * null and match the requests that carry none.
 */
export interface ApprovalRequestKey {
  specId: string;
  revisionId: string;
  gate: string;
  subject: string;
  executionId: string | null;
}

export interface SpecEventsRepo {
  append(event: SpecEventInput): SpecEventRow;
  /** Leaves transaction ownership with the calling service mutation. */
  appendInTransaction(event: SpecEventInput): SpecEventRow;
  findEventById(id: number): SpecEventRow | null;
  findBySpecId(specId: string): SpecEventRow[];
  /** The attention id already issued for this ask, or null. */
  findApprovalRequest(key: ApprovalRequestKey): { attentionId: string } | null;
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
  // Execution-scoped requests (non-null executionId) are identified by
  // (spec, gate, subject, execution) alone: rows persisted before revision
  // canonicalization may carry a non-pinned revisionId, and the run — not
  // the revision — owns a per-run gate's identity.
  const findApprovalRequestStmt = db.prepare(
    `SELECT json_extract(payload_json, '$.attentionId') AS attention_id
     FROM spec_events
     WHERE spec_id = @spec_id
       AND event_type = 'spec-attention-changed'
       AND json_extract(payload_json, '$.kind') = 'approval-requested'
       AND (
         @execution_id IS NOT NULL
         OR json_extract(payload_json, '$.revisionId') = @revision_id
       )
       AND json_extract(payload_json, '$.gate') = @gate
       AND json_extract(payload_json, '$.subject') = @subject
       AND json_extract(payload_json, '$.executionId') IS @execution_id
     ORDER BY id ASC
     LIMIT 1`,
  );
  const attentionIdRowSchema = z.object({
    attention_id: z.string().min(1),
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
      const raw: unknown = findApprovalRequestStmt.get({
        spec_id: key.specId,
        revision_id: key.revisionId,
        gate: key.gate,
        subject: key.subject,
        execution_id: key.executionId,
      });
      if (raw === undefined) return null;
      const parsed = attentionIdRowSchema.safeParse(raw);
      return parsed.success ? { attentionId: parsed.data.attention_id } : null;
    },
  };
}
