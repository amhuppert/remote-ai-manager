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

const logger = createLogger("workflow-graph");

/** Minimal shape read from a persisted record for the response + edit log. */
const persistedItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number(),
});

export interface DefinitionEditRequestParams {
  /** The raw (unparsed) request body. */
  rawBody: unknown;
  /** 404 message for this tier ("Workflow not found" / "Template not found"). */
  notFoundError: string;
  loadRecord(): Promise<WorkflowDefinitionRecord | null>;
  persist(draft: WorkflowDefinitionDraft): Promise<unknown>;
}

/**
 * The PATCH (targeted edit) request pipeline shared by the project- and
 * global-tier definition routes (docs/design/cc-cli/05). A thin shell around the
 * pure `applyDefinitionEdits`: parse the ops → load the record (404) → optimistic
 * concurrency check (409 `revision_conflict`) → apply + validate (400 with
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

  if (record.revision !== parsed.data.baseRevision) {
    logger.info("workflow-graph.definition-edit.revision-conflict", {
      workflowId: record.id,
      baseRevision: parsed.data.baseRevision,
      currentRevision: record.revision,
    });
    return NextResponse.json(
      {
        error: `definition changed since revision ${parsed.data.baseRevision} (current revision ${record.revision}) — re-read with 'cctl workflow get ${record.id}'`,
        code: "revision_conflict",
        currentRevision: record.revision,
      },
      { status: 409 },
    );
  }

  const applied = applyDefinitionEdits(record, parsed.data.operations);
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
    });
  }

  const persisted = await params.persist({
    name: applied.record.name,
    description: applied.record.description,
    definition: applied.record.definition,
    layout: applied.record.layout,
  });
  const summary = persistedItemSchema.safeParse(persisted);
  logger.info("workflow-graph.definition-edit.applied", {
    workflowId: record.id,
    operationCount,
    revision: summary.success ? summary.data.revision : null,
  });
  return NextResponse.json({ item: persisted, applied: operationCount });
}
