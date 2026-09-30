import type Database from "better-sqlite3";
import {
  ticketStatusChangeSchema,
  type TicketStatusChange,
} from "@/lib/tickets/schemas";

type Db = InstanceType<typeof Database>;
export interface TicketStatusChangesRepo {
  /** The ticket mutation owns the transaction containing this append. */
  appendInTransaction(
    change: Omit<TicketStatusChange, "id">,
  ): TicketStatusChange;
  listAfter(ticketId: string, id: number): TicketStatusChange[];
  latestId(ticketId: string, at?: string): number;
}

export function createTicketStatusChangesRepo(db: Db): TicketStatusChangesRepo {
  const insert = db.prepare(
    `INSERT INTO ticket_status_changes (ticket_id,status,actor_conversation_id,occurred_at) VALUES (@ticketId,@status,@actorConversationId,@occurredAt)`,
  );
  const select = db.prepare(
    `SELECT id,ticket_id AS ticketId,status,actor_conversation_id AS actorConversationId,occurred_at AS occurredAt FROM ticket_status_changes WHERE ticket_id = ? AND id > ? ORDER BY id`,
  );
  const latest = db.prepare(
    `SELECT COALESCE(MAX(id),0) AS id FROM ticket_status_changes WHERE ticket_id = ? AND (? IS NULL OR occurred_at <= ?)`,
  );
  return {
    appendInTransaction(change) {
      const validated = ticketStatusChangeSchema
        .omit({ id: true })
        .parse(change);
      const result = insert.run(validated);
      return ticketStatusChangeSchema.parse({
        ...validated,
        id: Number(result.lastInsertRowid),
      });
    },
    listAfter(ticketId, id) {
      return ticketStatusChangeSchema.array().parse(select.all(ticketId, id));
    },
    latestId(ticketId, at) {
      const row = latest.get(ticketId, at ?? null, at ?? null) as {
        id: number;
      };
      return row.id;
    },
  };
}
