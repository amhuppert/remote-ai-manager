import { ApiCallError } from "@/lib/api/errors";

/**
 * Render a workflow-save failure into the single string the builder's error
 * banner displays. When the failure is a structured plan-validation rejection
 * (`{ error, issues }` from the create/replace routes), each issue is appended
 * as its own `path: message` line so the builder keeps the field-level detail
 * the flattened legacy error string used to carry. Non-API failures fall back to
 * a generic message.
 */
export function formatWorkflowSaveError(error: unknown): string {
  if (!(error instanceof ApiCallError)) {
    return "Failed to save workflow draft";
  }

  if (!error.issues || error.issues.length === 0) {
    return error.message;
  }

  const issueLines = error.issues.map(
    (issue) => `${issue.path}: ${issue.message}`,
  );
  return [error.message, ...issueLines].join("\n");
}
