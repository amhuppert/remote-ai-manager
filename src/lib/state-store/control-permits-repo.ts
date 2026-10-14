import type Database from "better-sqlite3";
import { z } from "zod";
import {
  controlPermitRecordSchema,
  type ControlPermitRecord,
  type PermitState,
} from "@/lib/control/schemas";

type Db = InstanceType<typeof Database>;

const rowSchema = z.object({
  controller_id: z.string(),
  parent_controller_id: z.string().nullable(),
  generation: z.number().int(),
  state: z.string(),
  updated_at: z.string(),
});

/** Sole writer of `control_permits`; the permits service owns the rules. */
export interface ControlPermitsRepo {
  get(controllerId: string): ControlPermitRecord | null;
  insert(record: ControlPermitRecord): void;
  update(
    controllerId: string,
    change: { generation: number; state: PermitState; updatedAt: string },
  ): void;
}

export function createControlPermitsRepo(db: Db): ControlPermitsRepo {
  const getStmt = db.prepare(
    `SELECT controller_id, parent_controller_id, generation, state, updated_at
       FROM control_permits WHERE controller_id = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO control_permits
       (controller_id, parent_controller_id, generation, state, updated_at)
     VALUES (@controllerId, @parentControllerId, @generation, @state, @updatedAt)`,
  );
  const updateStmt = db.prepare(
    `UPDATE control_permits
        SET generation = @generation, state = @state, updated_at = @updatedAt
      WHERE controller_id = @controllerId`,
  );
  return {
    get(controllerId) {
      const raw: unknown = getStmt.get(controllerId);
      if (raw === undefined) return null;
      const row = rowSchema.parse(raw);
      return controlPermitRecordSchema.parse({
        controllerId: row.controller_id,
        parentControllerId: row.parent_controller_id,
        generation: row.generation,
        state: row.state,
        updatedAt: row.updated_at,
      });
    },
    insert(record) {
      insertStmt.run(controlPermitRecordSchema.parse(record));
    },
    update(controllerId, change) {
      const result = updateStmt.run({ controllerId, ...change });
      if (result.changes !== 1) {
        throw new Error(`Unknown control permit: ${controllerId}`);
      }
    },
  };
}
