import { NextResponse } from "next/server";

export interface StaleWorkflowDefinitionRefusal {
  error: string;
  code: "stale_workflow_definition";
  workflowId: string;
  expectedRevision: number;
  currentRevision: number;
  instruction: string;
}

export function staleWorkflowDefinitionResponse(
  workflowId: string,
  expectedRevision: number,
  currentRevision: number,
): Response {
  return NextResponse.json(
    {
      error: `Workflow definition ${workflowId} changed since revision ${expectedRevision}`,
      code: "stale_workflow_definition",
      workflowId,
      expectedRevision,
      currentRevision,
      instruction: "Re-read the workflow definition and reapply your changes.",
    } satisfies StaleWorkflowDefinitionRefusal,
    { status: 409 },
  );
}
