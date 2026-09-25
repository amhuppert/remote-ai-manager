import type Database from "better-sqlite3";
import { stableStringify } from "@/lib/state-store/serialization";

import type {
  ManagedWorkflowDefinitionLifecycle,
  NativeSddWorkflowManagementCompact,
  NativeSddWorkflowManagementDetail,
} from "@/lib/workflows/managed-definition-contract";
import type { ManagedWorkflowDefinitionRecord } from "./managed-workflow-definition-service";
import {
  deliveryPlanCandidateRecordSchema,
  deliveryPlanCandidateClaims,
  deliveryPlanDocumentSchema,
  finalizedDeliveryPlanApprovalSchema,
} from "./delivery-plan";
import { deriveDeliveryPlanClaims } from "./delivery-plan-binding-lint";
import { criterionElementPayloadSchema } from "./schemas";

type Db = InstanceType<typeof Database>;

interface OwnershipRow {
  workflow_definition_id: string;
  attempt_id: string;
  spec_id: string;
  spec_slug: string;
  spec_name: string;
  project_path: string;
  pinned_revision_id: string;
  pinned_revision_number: number;
  delta_basis_execution_id: string | null;
  status: "draft" | "approved" | "parked" | "launched" | "abandoned";
  current_workflow_definition_id: string;
  draft_revision: number;
  content_json: string;
  proposed_snapshot_id: string | null;
  approval_json: string | null;
  launched_execution_id: string | null;
  session_name: string | null;
  snapshot_content_json: string | null;
  snapshot_candidate_hash: string | null;
}

interface ApprovedBaselineRow {
  id: string;
  candidate_id: string;
  candidate_hash: string;
  content_json: string;
  approved_at: string;
}

interface CriterionRow {
  criterion_number: number | null;
  requirement_number: number | null;
  payload_json: string;
}

interface CommentRow {
  id: string;
  context_id: string;
  body: string;
  author_json: string;
  created_at: string;
}

export interface NativeSddManagedWorkflowDefinitionPolicy {
  list(
    projectPath: string,
    workflowIds: readonly string[],
  ): Promise<ReadonlyMap<string, NativeSddWorkflowManagementCompact>>;
  get(
    projectPath: string,
    workflowId: string,
  ): Promise<NativeSddWorkflowManagementDetail | null>;
  proposeBlockingCount(
    projectPath: string,
    workflowId: string,
  ): Promise<number | null>;
}

function lifecycle(row: OwnershipRow): ManagedWorkflowDefinitionLifecycle {
  const current =
    row.workflow_definition_id === row.current_workflow_definition_id;
  if (!current) return "superseded";
  if (row.status === "draft") return "draft";
  if (row.status === "approved" || row.status === "parked") return "approved";
  return row.status;
}

function dispositionCounts(binding: {
  dispositions: Array<{ disposition: string }>;
}): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const disposition of binding.dispositions) {
    counts[disposition.disposition] =
      (counts[disposition.disposition] ?? 0) + 1;
  }
  return counts;
}

function compactProjection(
  row: OwnershipRow,
  projectName: string,
): NativeSddWorkflowManagementCompact {
  const state = lifecycle(row);
  const isCurrentDefinition =
    row.workflow_definition_id === row.current_workflow_definition_id;
  const project = encodeURIComponent(projectName);
  const workflow = encodeURIComponent(row.workflow_definition_id);
  const executionHref =
    state === "launched" &&
    row.launched_execution_id !== null &&
    row.session_name !== null
      ? `/projects/${project}/${encodeURIComponent(row.session_name)}/workflow?execution=${encodeURIComponent(row.launched_execution_id)}`
      : null;
  return {
    kind: "native_sdd_delivery",
    specId: row.spec_id,
    specSlug: row.spec_slug,
    specName: row.spec_name,
    attemptId: row.attempt_id,
    pinnedRevisionId: row.pinned_revision_id,
    pinnedRevisionNumber: row.pinned_revision_number,
    lifecycle: state,
    editable: state === "draft" && isCurrentDefinition,
    isCurrentDefinition,
    specHref: `/specs/${project}/${encodeURIComponent(row.spec_slug)}`,
    builderHref: `/projects/${project}/workflows?definition=${workflow}`,
    executionHref,
  };
}

export function createNativeSddManagedWorkflowDefinitionPolicy(deps: {
  db: Db;
  resolveProjectName(projectPath: string): string;
  getWorkflowDefinition?(
    projectPath: string,
    workflowId: string,
  ): Promise<ManagedWorkflowDefinitionRecord | null>;
  /**
   * The propose gate of a spec's live draft as `spec plan status` reports it:
   * how many findings block propose, or null when the plan cannot be read.
   * Absent, every gate read answers null and receipts report no gate.
   */
  draftBlockingCount?(
    projectPath: string,
    specSlug: string,
  ): Promise<number | null>;
}): NativeSddManagedWorkflowDefinitionPolicy {
  const ownershipSql = `
    SELECT
      ownership.workflow_definition_id,
      attempts.id AS attempt_id,
      specs.id AS spec_id,
      specs.slug AS spec_slug,
      specs.name AS spec_name,
      specs.project_path,
      attempts.pinned_revision_id,
      revisions.number AS pinned_revision_number,
      attempts.delta_basis_execution_id,
      attempts.status,
      attempts.workflow_definition_id AS current_workflow_definition_id,
      attempts.draft_revision,
      attempts.content_json,
      attempts.proposed_snapshot_id,
      attempts.approval_json,
      attempts.launched_execution_id,
      executions.session_name,
      ownership.snapshot_content_json
      , ownership.snapshot_candidate_hash
    FROM (
      SELECT
        attempts.id AS attempt_id,
        attempts.workflow_definition_id,
        (
          SELECT snapshots.content_json
          FROM spec_delivery_plan_snapshots snapshots
          WHERE snapshots.id = attempts.proposed_snapshot_id
        ) AS snapshot_content_json,
        (
          SELECT snapshots.candidate_hash
          FROM spec_delivery_plan_snapshots snapshots
          WHERE snapshots.id = attempts.proposed_snapshot_id
        ) AS snapshot_candidate_hash
      FROM spec_delivery_plan_attempts attempts
      WHERE attempts.workflow_definition_id IS NOT NULL
      UNION ALL
      SELECT
        snapshots.attempt_id,
        snapshots.workflow_definition_id,
        snapshots.content_json AS snapshot_content_json,
        snapshots.candidate_hash AS snapshot_candidate_hash
      FROM spec_delivery_plan_snapshots snapshots
      WHERE snapshots.workflow_definition_id IS NOT NULL
    ) ownership
    JOIN spec_delivery_plan_attempts attempts ON attempts.id = ownership.attempt_id
    JOIN specs ON specs.id = attempts.spec_id
    JOIN spec_revisions revisions ON revisions.id = attempts.pinned_revision_id
    LEFT JOIN spec_executions executions
      ON executions.id = attempts.launched_execution_id
  `;
  const findOne = deps.db.prepare(
    `${ownershipSql}
     WHERE ownership.workflow_definition_id = ? AND specs.project_path = ?
     ORDER BY ownership.snapshot_content_json IS NULL DESC
     LIMIT 1`,
  );
  const findApprovedBaseline = deps.db.prepare(
    `SELECT snapshots.id, snapshots.candidate_id, snapshots.candidate_hash,
            snapshots.content_json, approvals.approved_at
     FROM spec_delivery_plan_snapshots snapshots
     JOIN spec_delivery_plan_attempts attempts
       ON attempts.id = snapshots.attempt_id
     JOIN spec_delivery_plan_candidate_approvals approvals
       ON approvals.snapshot_id = snapshots.id
     WHERE attempts.spec_id = ?
       AND snapshots.workflow_definition_id <> ?
     ORDER BY approvals.approved_at DESC, snapshots.id DESC
     LIMIT 1`,
  );
  const findCriterion = deps.db.prepare(
    `SELECT criterion.number AS criterion_number,
            requirement.number AS requirement_number,
            versions.payload_json
     FROM spec_elements criterion
     LEFT JOIN spec_elements requirement
       ON requirement.id = criterion.parent_element_id
     JOIN spec_element_versions versions
       ON versions.element_id = criterion.id
     WHERE criterion.id = ? AND versions.revision_id = ?
     LIMIT 1`,
  );
  const findComments = deps.db.prepare(
    `SELECT id, context_id, body, author_json, created_at
     FROM spec_delivery_plan_comments
     WHERE attempt_id = ?
     ORDER BY created_at ASC, id ASC`,
  );

  function readOwnership(
    projectPath: string,
    workflowId: string,
  ): OwnershipRow | null {
    return (
      (findOne.get(workflowId, projectPath) as OwnershipRow | undefined) ?? null
    );
  }

  return {
    async proposeBlockingCount(projectPath, workflowId) {
      if (deps.draftBlockingCount === undefined) return null;
      const row = readOwnership(projectPath, workflowId);
      // Only the current draft has a gate to move: a candidate is frozen and a
      // superseded definition is history, so neither owes a count.
      if (row === null || lifecycle(row) !== "draft") return null;
      return deps.draftBlockingCount(projectPath, row.spec_slug);
    },
    async list(projectPath, workflowIds) {
      const projectName = deps.resolveProjectName(projectPath);
      const projections = new Map<string, NativeSddWorkflowManagementCompact>();
      for (const workflowId of workflowIds) {
        const row = readOwnership(projectPath, workflowId);
        if (row) {
          projections.set(workflowId, compactProjection(row, projectName));
        }
      }
      return projections;
    },
    async get(projectPath, workflowId) {
      const row = readOwnership(projectPath, workflowId);
      if (!row) return null;
      const compact = compactProjection(
        row,
        deps.resolveProjectName(projectPath),
      );
      const document = deliveryPlanDocumentSchema.parse(
        JSON.parse(row.content_json),
      );
      const currentCandidate =
        row.snapshot_content_json === null
          ? null
          : deliveryPlanCandidateRecordSchema.parse(
              JSON.parse(row.snapshot_content_json),
            );
      const approval =
        row.approval_json === null
          ? null
          : finalizedDeliveryPlanApprovalSchema.parse(
              JSON.parse(row.approval_json),
            );
      const state = compact.lifecycle;
      const baselineRow = findApprovedBaseline.get(
        row.spec_id,
        row.workflow_definition_id,
      ) as ApprovedBaselineRow | undefined;
      const baselineManifest = baselineRow
        ? deliveryPlanCandidateRecordSchema.parse(
            JSON.parse(baselineRow.content_json),
          )
        : null;
      const [currentDefinition, baselineDefinition] = deps.getWorkflowDefinition
        ? await Promise.all([
            deps.getWorkflowDefinition(projectPath, row.workflow_definition_id),
            baselineManifest
              ? deps.getWorkflowDefinition(
                  projectPath,
                  baselineManifest.workflowDefinition.id,
                )
              : Promise.resolve(null),
          ])
        : [null, null];
      const graphChanged = <T>(
        current: T | undefined,
        baseline: T | undefined,
      ) =>
        currentDefinition !== null &&
        baselineDefinition !== null &&
        stableStringify(current) !== stableStringify(baseline);
      const claims =
        currentCandidate !== null
          ? deliveryPlanCandidateClaims(currentCandidate)
          : document.schemaVersion === 3
            ? document.binding.claims
            : currentDefinition === null
              ? []
              : deriveDeliveryPlanClaims(
                  document.binding,
                  currentDefinition.definition,
                );
      const contextIdsByCriterion = new Map<string, string[]>();
      for (const claim of claims) {
        for (const criterionElementId of claim.criterionElementIds) {
          const contexts = contextIdsByCriterion.get(criterionElementId) ?? [];
          contexts.push(claim.contextId);
          contextIdsByCriterion.set(criterionElementId, contexts);
        }
      }
      const criterionRows = document.binding.dispositions.map((disposition) => {
        const criterion = findCriterion.get(
          disposition.criterionElementId,
          row.pinned_revision_id,
        ) as CriterionRow | undefined;
        const payload = criterion
          ? criterionElementPayloadSchema.parse(
              JSON.parse(criterion.payload_json),
            )
          : null;
        const handle =
          criterion?.requirement_number !== null &&
          criterion?.requirement_number !== undefined &&
          criterion.criterion_number !== null
            ? `R${criterion.requirement_number}.${criterion.criterion_number}`
            : disposition.criterionElementId;
        return {
          ...disposition,
          handle,
          text: payload?.text ?? "",
          contextIds:
            contextIdsByCriterion.get(disposition.criterionElementId) ?? [],
        };
      });
      const claimContextIds = new Set(claims.map(({ contextId }) => contextId));
      const comments = (findComments.all(row.attempt_id) as CommentRow[]).map(
        (comment) => ({
          id: comment.id,
          contextId: comment.context_id,
          body: comment.body,
          author: JSON.parse(comment.author_json) as unknown,
          createdAt: comment.created_at,
          orphaned: !claimContextIds.has(comment.context_id),
        }),
      );
      const refusals: Record<string, string> = {};
      if (state !== "draft") {
        refusals["signOff"] = "Only the current draft can be signed off.";
      }
      if (state !== "approved") refusals["launch"] = "Sign off before launch.";
      const detail: NativeSddWorkflowManagementDetail = {
        ...compact,
        bindingRevision: row.draft_revision,
        deltaBasisExecutionId: row.delta_basis_execution_id,
        binding: { dispositions: document.binding.dispositions },
        dispositionCounts: dispositionCounts(document.binding),
        unresolvedItems: criterionRows.filter(
          ({ disposition }) => disposition === "pending_reaffirmation",
        ),
        criterionRows,
        claims,
        comments,
        nextAct:
          state === "draft"
            ? "sign_off"
            : state === "approved"
              ? "launch"
              : state === "launched"
                ? "open_execution"
                : null,
        currentCandidate,
        currentCandidateHash: row.snapshot_candidate_hash,
        currentApproval: approval,
        approvedBaseline:
          baselineRow && baselineManifest
            ? {
                snapshotId: baselineRow.id,
                candidateId: baselineRow.candidate_id,
                candidateHash: baselineRow.candidate_hash,
                approvedAt: baselineRow.approved_at,
                workflowDefinition: baselineManifest.workflowDefinition,
              }
            : null,
        changes: {
          workflowSettings: graphChanged(
            currentDefinition?.definition.workflowConfig,
            baselineDefinition?.definition.workflowConfig,
          ),
          contexts: graphChanged(
            currentDefinition?.definition.executionContexts,
            baselineDefinition?.definition.executionContexts,
          ),
          tasks: graphChanged(
            currentDefinition?.definition.tasks,
            baselineDefinition?.definition.tasks,
          ),
          edges: graphChanged(
            currentDefinition?.definition.edges,
            baselineDefinition?.definition.edges,
          ),
          layout: graphChanged(
            currentDefinition?.layout,
            baselineDefinition?.layout,
          ),
          dispositions:
            baselineManifest !== null &&
            stableStringify(baselineManifest.binding.dispositions) !==
              stableStringify(document.binding.dispositions),
          claims:
            baselineManifest !== null &&
            stableStringify(deliveryPlanCandidateClaims(baselineManifest)) !==
              stableStringify(claims),
        },
        capabilities: {
          canSignOff: state === "draft",
          canReopen: state === "approved",
          canAbandon: !["superseded", "abandoned", "launched"].includes(state),
          canLaunch: state === "approved",
          refusals,
        },
      };
      return detail;
    },
  };
}
