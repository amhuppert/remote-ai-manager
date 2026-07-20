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

export interface SpecEventsRepo {
  append(event: SpecEventInput): SpecEventRow;
  /** Leaves transaction ownership with the calling service mutation. */
  appendInTransaction(event: SpecEventInput): SpecEventRow;
  findEventById(id: number): SpecEventRow | null;
  findBySpecId(specId: string): SpecEventRow[];
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
  };
}
