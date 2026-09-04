import { z } from "zod";

export const workflowPlanIssueSchema = z.object({
  /**
   * JSON-path location within the request body, e.g.
   * `definition.tasks.0 (wire-routes).contextId` — the index-only path first,
   * then the addressed record's id in parentheses when it has one (#80 design
   * 3.2). Rendered in one place only, `plan-issue-locator.ts`.
   */
  path: z.string(),
  message: z.string(),
  /**
   * The id of the innermost record `path` addresses, so a machine consumer
   * reads it instead of parsing the rendering. Absent when the addressed
   * record names no id (a selected command name, a parameter, the graph
   * itself).
   */
  recordId: z.string().optional(),
});
export type WorkflowPlanIssue = z.infer<typeof workflowPlanIssueSchema>;
