import { z } from "zod";

export const workflowPlanIssueSchema = z.object({
  /** JSON-path location within the request body, e.g. `definition.tasks.0.contextId`. */
  path: z.string(),
  message: z.string(),
});
export type WorkflowPlanIssue = z.infer<typeof workflowPlanIssueSchema>;
