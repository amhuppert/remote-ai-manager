/**
 * Outcome reports Context consumes. Each executor owns the shape it produces;
 * Context reads them under its own names.
 */
export {
  seatTurnReportSchema as conversationReportSchema,
  questionReportSchema as requestsReportSchema,
  type SeatTurnReport as ConversationReport,
  type QuestionReport as RequestsReport,
} from "@/lib/conversation-core/schemas";
export {
  workspaceReportSchema,
  type WorkspaceReport,
} from "@/lib/workspace/schemas";
