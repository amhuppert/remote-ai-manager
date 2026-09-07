import { createRegisteredGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { NextResponse } from "next/server";
import { notFound } from "@/lib/shared/route-resolution";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  applyDefinitionEdits,
  formatDefinitionEditIssue,
} from "@/lib/workflow-graph/definition-edits";
import type { WorkflowDefinitionDraft } from "@/lib/workflow-graph/storage";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import { workflowDefinitionEditRequestSchema } from "@/lib/workflows/edit-schemas";
import {
  assignmentReferenceRefusal,
  assignmentReferenceRefusalBody,
} from "@/lib/workflows/assignment-reference-refusal";
import {
  authoredLaunchWarningFields,
  type AuthoredWorkflowLaunchAdmissionResult,
} from "@/lib/workflow-graph/authored-launch-admission";
import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";
import { WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE } from "@/lib/workflow-graph/assignment-references";
import { StaleWorkflowDefinitionError } from "@/lib/workflow-graph/storage";
import { staleWorkflowDefinitionResponse } from "@/lib/workflow-graph/stale-workflow-definition";

const logger = createLogger("workflow-graph");

/** Minimal shape read from a persisted record for the response + edit log. */
const persistedItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number(),
});

function formatAdmissionIssueForEdit(
  issue: WorkflowPlanIssue,
  commandIssues:
    | ReadonlyArray<{ path: string; message: string; code: string }>
    | undefined,
): WorkflowPlanIssue {
  const code = commandIssues?.find(
    (commandIssue) =>
      commandIssue.path === issue.path &&
      commandIssue.message === issue.message,
  )?.code;
  return {
    ...issue,
    path: issue.path.startsWith("definition.")
      ? issue.path.slice("definition.".length)
      : issue.path,
    message: code === undefined ? issue.message : `${code} — ${issue.message}`,
  };
}

export interface DefinitionEditRequestParams {
  /** The raw (unparsed) request body. */
  rawBody: unknown;
  /** 404 message for this tier ("Workflow not found" / "Template not found"). */
  notFoundError: string;
  loadRecord(): Promise<WorkflowDefinitionRecord | null>;
  admitLaunch?(
    launch: WorkflowDefinitionDraft,
  ): Promise<AuthoredWorkflowLaunchAdmissionResult>;
  persist(
    draft: WorkflowDefinitionDraft,
    expectedRevision: number,
  ): Promise<unknown>;
  /**
   * Fields merged into the receipt of a PERSISTED edit, beside `item` and
   * `applied`. Called after the write so they can report its effect (a managed
   * draft's propose gate); never on a dry run or a refusal, which change
   * nothing to report on.
   */
  receiptFields?(): Promise<Record<string, unknown>>;
}

/**
 * The PATCH (targeted edit) request pipeline shared by the project- and
 * global-tier definition routes (docs/design/cc-cli/05). A thin shell around the
 * pure `applyDefinitionEdits`: parse the ops → load the record (404) → optimistic
 * concurrency check (409 `stale_workflow_definition`) → apply + validate (400 with
 * locator-first issues) → dry-run report or persist. Every invariant is enforced
 * by construction: a batch either persists a definition indistinguishable from
 * one accepted via create, or nothing changes.
 */
export async function runDefinitionEditRequest(
  params: DefinitionEditRequestParams,
): Promise<Response> {
  const parsed = workflowDefinitionEditRequestSchema.safeParse(params.rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid edit request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "operations",
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const record = await params.loadRecord();
  if (!record) {
    return notFound(params.notFoundError);
  }

  if (record.revision !== parsed.data.expectedRevision) {
    logger.info("workflow-graph.definition-edit.revision-conflict", {
      workflowId: record.id,
      expectedRevision: parsed.data.expectedRevision,
      currentRevision: record.revision,
    });
    return staleWorkflowDefinitionResponse(
      record.id,
      parsed.data.expectedRevision,
      record.revision,
    );
  }

  const applied = applyDefinitionEdits(
    record,
    parsed.data.operations,
    createRegisteredGraphExecutionContract(),
  );
  if (!applied.ok) {
    const regionLocked = applied.issues.find(
      (issue) => issue.code === "region_locked",
    );
    logger.warn("workflow-graph.definition-edit.rejected", {
      workflowId: record.id,
      operationCount: parsed.data.operations.length,
      codes: applied.issues.map((issue) => issue.code),
    });
    return NextResponse.json(
      {
        error: "Workflow edit is invalid",
        // A machine code distinguishes a SEMANTIC rejection (valid-shaped ops the
        // engine refused — unknown ids, cycles) from a malformed-shape 400 (no
        // code). The CLI maps the former to exit 1 ("server said no") and the
        // latter to exit 2 ("fix your file"), per docs/design/cc-cli/05.
        code: regionLocked ? "region_locked" : "invalid_edit",
        ...(regionLocked?.instruction
          ? { instruction: regionLocked.instruction }
          : {}),
        issues: applied.issues.map(formatDefinitionEditIssue),
      },
      { status: regionLocked ? 409 : 400 },
    );
  }

  const candidateLaunch: WorkflowDefinitionDraft = {
    name: applied.record.name,
    description: applied.record.description,
    definition: applied.record.definition,
    layout: applied.record.layout,
  };
  let admittedLaunch = candidateLaunch;
  let admissionWarnings: WorkflowPlanIssue[] = [];
  if (params.admitLaunch) {
    const admission = await params.admitLaunch(candidateLaunch);
    if (!admission.ok) {
      logger.warn("workflow-graph.definition-edit.rejected", {
        workflowId: record.id,
        operationCount: parsed.data.operations.length,
        issueCount: admission.issues.length,
        code: admission.code ?? "invalid_edit",
      });
      if (admission.code === WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE) {
        return NextResponse.json(
          assignmentReferenceRefusalBody(admission.issues),
          { status: 400 },
        );
      }
      return NextResponse.json(
        {
          error: "Workflow edit is invalid",
          ...(admission.code
            ? { code: admission.code }
            : { code: "invalid_edit" }),
          issues: admission.issues.map((issue) =>
            formatAdmissionIssueForEdit(issue, admission.commandIssues),
          ),
        },
        { status: 400 },
      );
    }
    admittedLaunch = admission.launch;
    admissionWarnings = admission.warnings;
  }

  const operationCount = parsed.data.operations.length;

  if (parsed.data.dryRun === true) {
    logger.info("workflow-graph.definition-edit.dry-run", {
      workflowId: record.id,
      operationCount,
    });
    return NextResponse.json({
      item: {
        id: applied.record.id,
        name: applied.record.name,
        revision: applied.record.revision,
      },
      applied: operationCount,
      dryRun: true,
      ...authoredLaunchWarningFields(admissionWarnings),
    });
  }

  let persisted: unknown;
  try {
    persisted = await params.persist(
      {
        ...admittedLaunch,
      },
      parsed.data.expectedRevision,
    );
  } catch (error) {
    if (error instanceof StaleWorkflowDefinitionError) {
      return staleWorkflowDefinitionResponse(
        error.workflowId,
        error.expectedRevision,
        error.currentRevision,
      );
    }
    const refusal = assignmentReferenceRefusal(error);
    if (!refusal) throw error;
    logger.warn("workflow-graph.definition-edit.rejected", {
      workflowId: record.id,
      operationCount,
      codes: ["workflow_assignment_reference_invalid"],
    });
    return refusal;
  }
  const summary = persistedItemSchema.safeParse(persisted);
  logger.info("workflow-graph.definition-edit.applied", {
    workflowId: record.id,
    operationCount,
    revision: summary.success ? summary.data.revision : null,
  });
  const receiptFields = params.receiptFields
    ? await params.receiptFields()
    : {};
  return NextResponse.json({
    item: persisted,
    applied: operationCount,
    ...authoredLaunchWarningFields(admissionWarnings),
    ...receiptFields,
  });
}
