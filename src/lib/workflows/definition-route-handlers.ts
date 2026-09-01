import { NextResponse } from "next/server";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { notFound, resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { readConfig } from "@/lib/config/loader";
import {
  getProjectDisplayName,
  resolveProjectPath as defaultResolveProjectPath,
} from "@/lib/projects/resolver";
import { readRepoConfig } from "@/lib/projects/repo-config";
import type { ApiError } from "@/lib/api/errors";
import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import {
  createWorkflowStorageService,
  StaleWorkflowDefinitionError,
  type WorkflowDefinitionDraft,
  type WorkflowDefinitionSummary,
} from "@/lib/workflow-graph/storage";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import {
  admitAuthoredWorkflowLaunch,
  authoredLaunchWarningFields,
} from "@/lib/workflow-graph/authored-launch-admission";
import {
  type AssignmentReferenceChecker,
  WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE,
} from "@/lib/workflow-graph/assignment-references";
import { runDefinitionEditRequest } from "./definition-edit-handler";
import {
  assignmentReferenceRefusal,
  assignmentReferenceRefusalBody,
} from "./assignment-reference-refusal";
import { defaultPlanReviewService } from "./plan-review/default-service";
import { canonicalPlanDefinitionHash } from "./plan-review/schemas";
import type { PlanReviewLookup } from "./plan-review/service";
import {
  planReviewAcknowledgementRequestSchema,
  planReviewFindingsCommand,
  REVIEW_CHANGES_REQUESTED_UNACKNOWLEDGED_CODE,
  type PlanReviewAcknowledgementRefusal,
  type PlanReviewAdvisory,
} from "./plan-review/status-schemas";
import { staleWorkflowDefinitionResponse } from "@/lib/workflow-graph/stale-workflow-definition";
import {
  managedWorkflowReadOnlyInstruction,
  type ManagedWorkflowDefinitionPolicy,
  type NativeSddWorkflowManagementCompact,
} from "@/lib/workflow-graph/managed-definition";
import {
  definitionMutationCoordinator,
  type DefinitionMutationCoordinator,
} from "@/lib/workflow-graph/definition-mutation-coordinator";
import {
  findChangedLockedRegion,
  regionLockedInstruction,
} from "@/lib/workflow-graph/locked-regions";
import { getStateDb } from "@/lib/state-store/store";
import { createNativeSddManagedWorkflowDefinitionPolicy } from "@/lib/specs/managed-workflow-definition-policy";

const logger = createLogger("workflow-graph");

const UNREVIEWED: PlanReviewAdvisory = { state: "unreviewed" };
const workflowDefinitionReplaceRevisionSchema = z.object({
  expectedRevision: z.number().int().min(1),
});

/**
 * What the admitted revision's review means for this request (#69 change 5):
 * the advisory line the response carries, and — for the ONE blocking shape —
 * the refusal that must be answered before anything is persisted.
 */
interface AdmittedRevisionReview {
  advisory: PlanReviewAdvisory;
  /** Non-null only for an unacknowledged changes_requested verdict. */
  refusal: PlanReviewAcknowledgementRefusal | null;
}

const OPEN = (advisory: PlanReviewAdvisory): AdmittedRevisionReview => ({
  advisory,
  refusal: null,
});

/**
 * The acknowledgement this request carries, if any. Shape-tolerant on purpose:
 * a body carrying something other than a hash string acknowledges nothing, and
 * acknowledging nothing is the case the gate already handles — refusing the
 * request over the field's TYPE would add a failure path of its own.
 */
function submittedAcknowledgement(rawBody: unknown): string | null {
  const parsed = planReviewAcknowledgementRequestSchema.safeParse(rawBody);
  if (!parsed.success) return null;
  return parsed.data.acknowledgeReviewHash?.trim() ?? null;
}

/**
 * What is known about the review of the revision just admitted, and whether
 * that knowledge blocks the save.
 *
 * The LOOKUP fails open, without exception: a store that throws costs the
 * author a sentence of output, never the save, and never a refusal — the gate
 * is skipped entirely, because a mechanism that can refuse a create when its
 * own storage is broken is a new way for an execution to fail. Reporting
 * `unreviewed` on failure is deliberate; the warn log is where the real failure
 * is recorded.
 *
 * The gate itself covers exactly one shape: this exact revision carries a
 * terminal changes_requested verdict and the request did not acknowledge that
 * revision's hash. Unreviewed and approved revisions are never gated, and
 * repairing the plan changes its canonical hash — so the gate clears itself on
 * the repaired successor rather than following the author forward.
 */
function reviewOfAdmittedRevision(
  draft: WorkflowDefinitionDraft,
  lookup: PlanReviewLookup,
  acknowledgement: string | null,
  scope: Record<string, string>,
): AdmittedRevisionReview {
  let definitionHash: string;
  let latest: ReturnType<PlanReviewLookup["findLatestTerminalReview"]>;
  try {
    definitionHash = canonicalPlanDefinitionHash(draft.definition);
    latest = lookup.findLatestTerminalReview(definitionHash);
  } catch (error) {
    // Named for what the failure COSTS, not for the advisory alone: this catch
    // also skips the acknowledgement gate. Its sibling is
    // `workflows.plan-review.lookup_failed`, which the service logs when the
    // STORE throws and the service swallows it into a `null` this layer cannot
    // tell from an unreviewed revision — so a gate skip surfaces under one name
    // or the other depending on which layer failed, and an operator tracing one
    // should search for both.
    logger.warn("workflow-graph.definition-review.lookup_failed", {
      ...scope,
      error: error instanceof Error ? error.message : String(error),
    });
    return OPEN(UNREVIEWED);
  }

  if (latest === null) return OPEN(UNREVIEWED);
  const advisory: PlanReviewAdvisory = {
    state: latest.verdict,
    reviewerConversationId: latest.reviewerConversationId,
    reviewedAt: latest.reviewedAt,
  };
  if (latest.verdict !== "changes_requested") return OPEN(advisory);
  if (acknowledgement === definitionHash) return OPEN(advisory);

  return {
    advisory,
    refusal: {
      definitionHash,
      verdict: "changes_requested",
      reviewerConversationId: latest.reviewerConversationId,
      reviewedAt: latest.reviewedAt,
      findingsCommand: planReviewFindingsCommand(),
    },
  };
}

/**
 * The advisory fields a save carries beside its item: the review status of the
 * exact revision, and the admission warnings this path used to discard — a
 * planner who goes straight to create never runs `validate`, and dropping them
 * here made the whole warning tier invisible to that author (#69 change 6).
 *
 * `warnings` is omitted when empty, exactly as the validate endpoint omits it,
 * so the key's presence means there is something to read rather than being a
 * field every response carries.
 */
function saveAdvisoryFields(
  review: AdmittedRevisionReview,
  warnings: readonly WorkflowPlanIssue[],
): { reviewStatus: PlanReviewAdvisory; warnings?: WorkflowPlanIssue[] } {
  return {
    reviewStatus: review.advisory,
    ...authoredLaunchWarningFields(warnings),
  };
}

/**
 * 409 rather than 400: the submitted plan is well-formed and the caller is not
 * confused about the request shape — it conflicts with a verdict already
 * recorded against these exact bytes, and the two ways out (read the findings,
 * then revise or acknowledge) are both in the payload.
 */
function reviewAcknowledgementRefusalResponse(
  refusal: PlanReviewAcknowledgementRefusal,
): Response {
  return NextResponse.json(
    {
      error: `Plan revision ${refusal.definitionHash} has a changes-requested review this request did not acknowledge: read the findings, then either revise the plan or re-submit with acknowledgeReviewHash set to ${refusal.definitionHash}`,
      code: REVIEW_CHANGES_REQUESTED_UNACKNOWLEDGED_CODE,
      details: refusal,
    },
    { status: 409 },
  );
}

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface WorkflowDefinitionRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  readConfig(): Promise<GlobalConfig>;
  /**
   * Reads `CommandCenter.json` so create/replace can preflight command
   * selections against the project's validation registry and global capacity
   * at these project-bound boundaries (validation-concurrency §§3, 6).
   */
  readRepoConfig(projectPath: string): Promise<PerRepoConfig | null>;
  listDefinitions(projectPath: string): Promise<WorkflowDefinitionSummary[]>;
  getDefinition(
    projectPath: string,
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null>;
  createDefinition(
    projectPath: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord>;
  updateDefinition(
    projectPath: string,
    workflowId: string,
    expectedRevision: number,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord>;
  deleteDefinition(projectPath: string, workflowId: string): Promise<boolean>;
  assignmentReferences?: AssignmentReferenceChecker;
  /**
   * The review lookup for the admitted revision. Consulted BEFORE persisting,
   * because it powers two things at once: the advisory the response carries,
   * which never changes the outcome, and the single sanctioned refusal — an
   * unacknowledged changes_requested verdict on these exact bytes. It may
   * refuse nothing else, and a lookup that throws refuses nothing at all.
   */
  planReviews: PlanReviewLookup;
  managedDefinitions?: ManagedWorkflowDefinitionPolicy;
  mutationCoordinator?: DefinitionMutationCoordinator;
}

const defaultStorage = createWorkflowStorageService();
const defaultManagedDefinitions: ManagedWorkflowDefinitionPolicy = {
  list(projectPath, workflowIds) {
    return createNativeSddManagedWorkflowDefinitionPolicy({
      db: getStateDb(),
      resolveProjectName: getProjectDisplayName,
      getWorkflowDefinition: (path, workflowId) =>
        defaultStorage.get({ kind: "project", projectPath: path }, workflowId),
    }).list(projectPath, workflowIds);
  },
  get(projectPath, workflowId) {
    return createNativeSddManagedWorkflowDefinitionPolicy({
      db: getStateDb(),
      resolveProjectName: getProjectDisplayName,
      getWorkflowDefinition: (path, definitionId) =>
        defaultStorage.get(
          { kind: "project", projectPath: path },
          definitionId,
        ),
    }).get(projectPath, workflowId);
  },
};

const defaultDeps: WorkflowDefinitionRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  readConfig,
  readRepoConfig,
  listDefinitions: (projectPath) =>
    defaultStorage.list({ kind: "project", projectPath }),
  getDefinition: (projectPath, workflowId) =>
    defaultStorage.get({ kind: "project", projectPath }, workflowId),
  createDefinition: (projectPath, draft) =>
    defaultStorage.create({ kind: "project", projectPath }, draft),
  updateDefinition: (projectPath, workflowId, expectedRevision, draft) =>
    defaultStorage.update(
      { kind: "project", projectPath },
      workflowId,
      expectedRevision,
      draft,
    ),
  deleteDefinition: (projectPath, workflowId) =>
    defaultStorage.delete({ kind: "project", projectPath }, workflowId),
  planReviews: {
    // Resolved per call, not at module load: the service opens the live
    // database, which does not exist yet during the Next.js build.
    findLatestTerminalReview: (definitionHash) =>
      defaultPlanReviewService().findLatestTerminalReview(definitionHash),
  },
  managedDefinitions: defaultManagedDefinitions,
};

function admissionRefusalResponse(validation: {
  issues: ReadonlyArray<{ path: string; message: string }>;
  code?: string;
}): Response {
  const body =
    validation.code === WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE
      ? assignmentReferenceRefusalBody(validation.issues)
      : {
          error: "Workflow plan is invalid",
          ...(validation.code ? { code: validation.code } : {}),
          issues: validation.issues,
        };
  return NextResponse.json(body, { status: 400 });
}

function managedMutationRefusal(
  workflowId: string,
  management: NativeSddWorkflowManagementCompact,
  operation: "update" | "edit" | "delete",
): Response {
  const code =
    operation === "delete"
      ? "managed_workflow_definition"
      : "managed_workflow_definition_read_only";
  const instruction =
    operation === "delete"
      ? "Abandon the delivery plan from its managed header; candidate definition files are retained as history."
      : managedWorkflowReadOnlyInstruction(management);
  logger.warn("workflow-graph.definition-mutation.managed-refused", {
    workflowId,
    attemptId: management.attemptId,
    lifecycle: management.lifecycle,
    operation,
    code,
  });
  return NextResponse.json(
    {
      error:
        operation === "delete"
          ? "Managed delivery workflow definitions cannot be deleted directly."
          : "This managed delivery workflow definition is read-only.",
      code,
      lifecycle: management.lifecycle,
      instruction,
    },
    { status: 409 },
  );
}

export function createWorkflowDefinitionRouteHandlers(
  deps: WorkflowDefinitionRouteDeps = defaultDeps,
) {
  const assignmentReferences = deps.assignmentReferences;
  const coordinator = deps.mutationCoordinator ?? definitionMutationCoordinator;
  async function LIST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const items = await deps.listDefinitions(projectPath);
    const management = deps.managedDefinitions
      ? await deps.managedDefinitions.list(
          projectPath,
          items.map((item) => item.id),
        )
      : new Map();
    return NextResponse.json({
      items: items.map((item) => {
        const projection = management.get(item.id);
        return projection ? { ...item, management: projection } : item;
      }),
    });
  }

  async function CREATE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: "Invalid request: name, definition, and layout are required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const [repoConfig, globalConfig] = await Promise.all([
      deps.readRepoConfig(projectPath),
      deps.readConfig(),
    ]);
    const validation = await admitAuthoredWorkflowLaunch(rawBody, {
      caller: "project-create",
      documentScope: { kind: "project", projectPath },
      projectValidation: repoConfig?.validation ?? null,
      globalValidation: globalConfig.validation,
      workflowDefaults: globalConfig.workflowDefaults,
      agentBackends: globalConfig.agentBackends,
      assignmentReferences,
    });
    if (!validation.ok) {
      logger.warn("workflow-graph.definition-create.rejected", {
        projectPath,
        issueCount: validation.issues.length,
        code: validation.code ?? "invalid_plan",
      });
      return admissionRefusalResponse(validation);
    }

    const review = reviewOfAdmittedRevision(
      validation.launch,
      deps.planReviews,
      submittedAcknowledgement(rawBody),
      { projectPath, caller: "project-create" },
    );
    if (review.refusal !== null) {
      logger.warn("workflow-graph.definition-create.review_unacknowledged", {
        projectPath,
        definitionHash: review.refusal.definitionHash,
      });
      return reviewAcknowledgementRefusalResponse(review.refusal);
    }

    try {
      const item = await deps.createDefinition(projectPath, validation.launch);
      return NextResponse.json(
        { item, ...saveAdvisoryFields(review, validation.warnings) },
        { status: 201 },
      );
    } catch (error) {
      const refusal = assignmentReferenceRefusal(error);
      if (refusal) return refusal;
      const message =
        error instanceof Error ? error.message : "Failed to create workflow";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 400,
      });
    }
  }

  async function GET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name = "", workflowId = "" } = await context.params;
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const item = await deps.getDefinition(projectPath, workflowId);
    if (!item) {
      return notFound("Workflow not found");
    }

    const globalConfig = await deps.readConfig();
    const resolved = resolveWorkflowDefinition(globalConfig, item.definition);

    const management = await deps.managedDefinitions?.get(
      projectPath,
      workflowId,
    );
    return NextResponse.json({
      item: management ? { ...item, management } : item,
      resolved,
    });
  }

  async function UPDATE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name = "", workflowId = "" } = await context.params;
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: "Invalid request: name, definition, and layout are required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const revision = workflowDefinitionReplaceRevisionSchema.safeParse(rawBody);
    if (!revision.success) {
      return NextResponse.json(
        {
          error: "Invalid workflow definition revision",
          issues: revision.error.issues.map((issue) => ({
            path: issue.path.join(".") || "expectedRevision",
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const [repoConfig, globalConfig] = await Promise.all([
      deps.readRepoConfig(projectPath),
      deps.readConfig(),
    ]);
    const validation = await admitAuthoredWorkflowLaunch(rawBody, {
      caller: "project-replace",
      documentScope: { kind: "project", projectPath },
      projectValidation: repoConfig?.validation ?? null,
      globalValidation: globalConfig.validation,
      workflowDefaults: globalConfig.workflowDefaults,
      agentBackends: globalConfig.agentBackends,
      assignmentReferences,
    });
    if (!validation.ok) {
      logger.warn("workflow-graph.definition-replace.rejected", {
        projectPath,
        workflowId,
        issueCount: validation.issues.length,
        code: validation.code ?? "invalid_plan",
      });
      return admissionRefusalResponse(validation);
    }

    const review = reviewOfAdmittedRevision(
      validation.launch,
      deps.planReviews,
      submittedAcknowledgement(rawBody),
      { projectPath, workflowId, caller: "project-replace" },
    );
    if (review.refusal !== null) {
      logger.warn("workflow-graph.definition-replace.review_unacknowledged", {
        projectPath,
        workflowId,
        definitionHash: review.refusal.definitionHash,
      });
      return reviewAcknowledgementRefusalResponse(review.refusal);
    }

    try {
      return await coordinator.run(
        `${projectPath}\0${workflowId}`,
        async () => {
          const management = await deps.managedDefinitions?.get(
            projectPath,
            workflowId,
          );
          if (management && !management.editable) {
            return managedMutationRefusal(workflowId, management, "update");
          }
          if (management) {
            const existing = await deps.getDefinition(projectPath, workflowId);
            if (!existing) return notFound("Workflow not found");
            const locked = findChangedLockedRegion(
              existing.definition,
              validation.launch.definition,
            );
            if (locked) {
              return NextResponse.json(
                {
                  error:
                    "Managed delivery workflow locked regions cannot be edited.",
                  code: "region_locked",
                  lockedPath: locked.lockedPath,
                  sourceUri: locked.sourceUri,
                  instruction: regionLockedInstruction(locked),
                },
                { status: 409 },
              );
            }
          }

          const item = await deps.updateDefinition(
            projectPath,
            workflowId,
            revision.data.expectedRevision,
            validation.launch,
          );
          const nextManagement = await deps.managedDefinitions?.get(
            projectPath,
            workflowId,
          );
          return NextResponse.json({
            item: nextManagement
              ? { ...item, management: nextManagement }
              : item,
            ...saveAdvisoryFields(review, validation.warnings),
          });
        },
      );
    } catch (error) {
      // Ordered before the 404 fallback on purpose: an unresolvable assignment
      // reference is a refusal of the SUBMITTED document, not a missing id, and
      // reporting it as "not found" hid its located issues entirely.
      const refusal = assignmentReferenceRefusal(error);
      if (refusal) return refusal;
      if (error instanceof StaleWorkflowDefinitionError) {
        return staleWorkflowDefinitionResponse(
          error.workflowId,
          error.expectedRevision,
          error.currentRevision,
        );
      }
      const message =
        error instanceof Error ? error.message : "Failed to update workflow";
      return notFound(message);
    }
  }

  async function EDIT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name = "", workflowId = "" } = await context.params;
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const rawBody = await request.json().catch(() => undefined);
    return coordinator.run(`${projectPath}\0${workflowId}`, async () => {
      const management = await deps.managedDefinitions?.get(
        projectPath,
        workflowId,
      );
      if (management && !management.editable) {
        return managedMutationRefusal(workflowId, management, "edit");
      }
      return runDefinitionEditRequest({
        rawBody,
        notFoundError: "Workflow not found",
        loadRecord: () => deps.getDefinition(projectPath, workflowId),
        admitLaunch: async (launch) => {
          const [repoConfig, globalConfig] = await Promise.all([
            deps.readRepoConfig(projectPath),
            deps.readConfig(),
          ]);
          return admitAuthoredWorkflowLaunch(launch, {
            caller: "project-edit",
            documentScope: { kind: "project", projectPath },
            projectValidation: repoConfig?.validation ?? null,
            globalValidation: globalConfig.validation,
            workflowDefaults: globalConfig.workflowDefaults,
            agentBackends: globalConfig.agentBackends,
            assignmentReferences,
          });
        },
        persist: (draft, expectedRevision) =>
          deps.updateDefinition(
            projectPath,
            workflowId,
            expectedRevision,
            draft,
          ),
      });
    });
  }

  async function DELETE(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name = "", workflowId = "" } = await context.params;
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    return coordinator.run(`${projectPath}\0${workflowId}`, async () => {
      const management = await deps.managedDefinitions?.get(
        projectPath,
        workflowId,
      );
      if (management) {
        return managedMutationRefusal(workflowId, management, "delete");
      }

      const deleted = await deps.deleteDefinition(projectPath, workflowId);
      if (!deleted) return notFound("Workflow not found");
      return NextResponse.json({ ok: true });
    });
  }

  return { LIST, CREATE, GET, UPDATE, EDIT, DELETE };
}
