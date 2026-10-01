import type Database from "better-sqlite3";
import { z } from "zod";
import type { SubscriptionRecipient } from "@/lib/subscriptions/schemas";

type Db = InstanceType<typeof Database>;
const sourceLinkSchema = z.object({ id: z.string(), occurredAt: z.string() });
const specLinkSchema = z.object({ id: z.string(), eventId: z.number().int() });
const workflowAddressSchema = z.object({
  projectPath: z.string(),
  sessionName: z.string(),
});
const sourceIdSchema = z.object({ id: z.string() });

export interface SubscriptionSourceQueriesRepo {
  findWorkflowAddress(
    executionId: string,
  ): z.infer<typeof workflowAddressSchema> | null;
  findTicketInvolvement(
    recipient: SubscriptionRecipient,
    sessionName: string | null,
  ): z.infer<typeof sourceLinkSchema>[];
  findSpecInvolvement(
    recipient: SubscriptionRecipient,
  ): z.infer<typeof specLinkSchema>[];
  findWorkflowInvolvement(recipient: SubscriptionRecipient): string[];
  firstOutstandingWorkflowBoundary(
    recipient: SubscriptionRecipient,
    executionId: string,
  ): number | null;
}

/** Reverse lookups over canonical domain records; this repository owns no source state. */
export function createSubscriptionSourceQueriesRepo(
  db: Db,
): SubscriptionSourceQueriesRepo {
  const workflowAddress = db.prepare(`
    SELECT project_path AS projectPath, session_name AS sessionName FROM graph_workflow_executions WHERE execution_id = ?
    UNION ALL
    SELECT project_path AS projectPath, session_name AS sessionName FROM graph_workflow_archived_executions WHERE execution_id = ?
    LIMIT 1`);
  const ticketLinks = db.prepare(`
    SELECT id, MIN(occurredAt) AS occurredAt FROM (
      SELECT t.id, a.created_at AS occurredAt FROM ticket_attachments a JOIN tickets t ON t.id = a.ticket_id
      WHERE t.project_path = @projectPath AND json_extract(a.payload_json, '$.projectPath') = @projectPath
        AND ((json_extract(a.payload_json, '$.kind') = 'conversation' AND json_extract(a.payload_json, '$.conversationId') = @conversationId)
          OR (json_extract(a.payload_json, '$.kind') = 'session' AND json_extract(a.payload_json, '$.sessionName') = @sessionName))
      UNION ALL
      SELECT t.id, ts.linked_at AS occurredAt FROM ticket_sessions ts JOIN tickets t ON t.id = ts.ticket_id
        JOIN sessions s ON s.project_path = ts.project_path AND s.session_name = ts.session_name AND s.created_at = ts.session_created_at
      WHERE t.project_path = @projectPath AND ts.project_path = @projectPath AND ts.session_name = @sessionName AND ts.ended_at IS NULL
    ) GROUP BY id`);
  const specLinks = db.prepare(`
    SELECT s.id, MIN(e.id) AS eventId FROM spec_events e JOIN specs s ON s.id = e.spec_id
    WHERE s.project_path = @projectPath AND json_extract(e.actor_json, '$.kind') = 'agent'
      AND json_extract(e.actor_json, '$.conversationId') = @conversationId
      AND e.event_type <> 'spec-intervention-recorded'
    GROUP BY s.id`);
  const workflowLinks = db.prepare(`
    SELECT execution_id AS id FROM graph_workflow_executions WHERE project_path = @projectPath AND json_extract(definition_json, '$.ownerConversationId') = @conversationId
    UNION
    SELECT execution_id AS id FROM graph_workflow_archived_executions WHERE project_path = @projectPath AND json_extract(execution_json, '$.ownerConversationId') = @conversationId`);
  const firstOutstanding = db.prepare(`
    SELECT MIN(r.boundary_seq) AS boundary FROM graph_workflow_result_deliveries r
    WHERE r.project_path = @projectPath AND r.origin_conversation_id = @conversationId
      AND r.execution_id = @executionId AND r.delivery_state = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM conversation_subscription_deliveries d
        WHERE d.project_path = r.project_path AND d.conversation_id = r.origin_conversation_id
          AND d.source_kind = 'workflow' AND d.source_id = r.execution_id
          AND d.occurrence_id = CAST(r.boundary_seq AS TEXT)
          AND d.state IN ('accepted', 'superseded')
      )`);
  return {
    firstOutstandingWorkflowBoundary(recipient, executionId) {
      return z
        .object({ boundary: z.number().int().nullable() })
        .parse(firstOutstanding.get({ ...recipient, executionId })).boundary;
    },
    findWorkflowAddress(executionId) {
      const row: unknown = workflowAddress.get(executionId, executionId);
      return row === undefined ? null : workflowAddressSchema.parse(row);
    },
    findTicketInvolvement(recipient, sessionName) {
      return z
        .array(sourceLinkSchema)
        .parse(ticketLinks.all({ ...recipient, sessionName }));
    },
    findSpecInvolvement(recipient) {
      return z.array(specLinkSchema).parse(specLinks.all(recipient));
    },
    findWorkflowInvolvement(recipient) {
      return z
        .array(sourceIdSchema)
        .parse(workflowLinks.all(recipient))
        .map((row) => row.id);
    },
  };
}
