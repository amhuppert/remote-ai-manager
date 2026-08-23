import { NextResponse } from "next/server";
import { notFound, resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { readConfig as defaultReadConfig } from "@/lib/config/loader";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import type { ApiError } from "@/lib/api/errors";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import { resolveWorkflowDefinition } from "./resolve-config";
import {
  admitAuthoredWorkflowLaunch,
  authoredLaunchWarningFields,
} from "./authored-launch-admission";
import {
  type AssignmentReferenceChecker,
  WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE,
} from "./assignment-references";
import {
  createWorkflowStorageService,
  type WorkflowDefinitionDraft,
  type WorkflowDefinitionSummary,
} from "./storage";
import {
  createTemplateLibraryService,
  type TemplateLibraryItem,
} from "./template-library-service";
import { runDefinitionEditRequest } from "@/lib/workflows/definition-edit-handler";
import {
  assignmentReferenceRefusal,
  assignmentReferenceRefusalBody,
} from "@/lib/workflows/assignment-reference-refusal";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

/**
 * Library/Listing API deps. The cross-tier `list` resolves a project; the
 * global-tier CRUD operates on the reserved `{ kind: "global" }` scope and so
 * takes no project binding — accept-time validation (including the prerequisite
 * shape checks) runs automatically inside storage.create/update for that scope.
 */
export interface TemplateLibraryRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  readConfig(): Promise<GlobalConfig>;
  list(projectPath: string): Promise<TemplateLibraryItem[]>;
  listGlobal(): Promise<WorkflowDefinitionSummary[]>;
  createGlobal(
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord>;
  getGlobal(workflowId: string): Promise<WorkflowDefinitionRecord | null>;
  updateGlobal(
    workflowId: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord>;
  deleteGlobal(workflowId: string): Promise<boolean>;
  assignmentReferences?: AssignmentReferenceChecker;
}

const defaultStorage = createWorkflowStorageService();
const defaultLibrary = createTemplateLibraryService({
  storage: defaultStorage,
});

const defaultDeps: TemplateLibraryRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  readConfig: defaultReadConfig,
  list: (projectPath) => defaultLibrary.list(projectPath),
  listGlobal: () => defaultStorage.list({ kind: "global" }),
  createGlobal: (draft) => defaultStorage.create({ kind: "global" }, draft),
  getGlobal: (workflowId) => defaultStorage.get({ kind: "global" }, workflowId),
  updateGlobal: (workflowId, draft) =>
    defaultStorage.update({ kind: "global" }, workflowId, draft),
  deleteGlobal: (workflowId) =>
    defaultStorage.delete({ kind: "global" }, workflowId),
};

/**
 * The global tier accepts a plan through the same admission service as the
 * per-project create/replace routes, not a local re-parse. That is
 * what makes a semantic rejection here carry a JSON-path locator: storage's
 * accept-time gate can only throw a comma-joined list of error CODES, which
 * names neither the offending context nor the field inside it.
 */
function invalidPlanResponse(
  issues: ReadonlyArray<{ path: string; message: string }>,
  code?: string,
): Response {
  return NextResponse.json(
    code === WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE
      ? assignmentReferenceRefusalBody(issues)
      : {
          error: "Workflow plan is invalid",
          ...(code ? { code } : {}),
          issues,
        },
    { status: 400 },
  );
}

export function createTemplateLibraryRouteHandlers(
  deps: TemplateLibraryRouteDeps = defaultDeps,
) {
  const assignmentReferences = deps.assignmentReferences;
  async function LIST_TEMPLATES(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;

    const items = await deps.list(project.value);
    return NextResponse.json({ items });
  }

  async function LIST_GLOBAL(
    _request: Request,
    _context: RouteContext,
  ): Promise<Response> {
    const items = await deps.listGlobal();
    return NextResponse.json({ items });
  }

  async function CREATE(
    request: Request,
    _context: RouteContext,
  ): Promise<Response> {
    const globalConfig = await deps.readConfig();
    const validation = await admitAuthoredWorkflowLaunch(
      await request.json().catch(() => null),
      {
        caller: "global-template-create",
        documentScope: { kind: "global" },
        globalValidation: globalConfig.validation,
        workflowDefaults: globalConfig.workflowDefaults,
        assignmentReferences,
      },
    );
    if (!validation.ok) {
      return invalidPlanResponse(validation.issues, validation.code);
    }

    try {
      const item = await deps.createGlobal(validation.launch);
      return NextResponse.json(
        { item, ...authoredLaunchWarningFields(validation.warnings) },
        { status: 201 },
      );
    } catch (error) {
      const refusal = assignmentReferenceRefusal(error);
      if (refusal) return refusal;
      const message =
        error instanceof Error ? error.message : "Failed to create template";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 400,
      });
    }
  }

  async function GET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { workflowId = "" } = await context.params;
    const item = await deps.getGlobal(workflowId);
    if (!item) {
      return notFound("Template not found");
    }

    const globalConfig = await deps.readConfig();
    const resolved = resolveWorkflowDefinition(globalConfig, item.definition);
    return NextResponse.json({ item, resolved });
  }

  async function UPDATE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { workflowId = "" } = await context.params;
    const globalConfig = await deps.readConfig();
    const validation = await admitAuthoredWorkflowLaunch(
      await request.json().catch(() => null),
      {
        caller: "global-template-replace",
        documentScope: { kind: "global" },
        globalValidation: globalConfig.validation,
        workflowDefaults: globalConfig.workflowDefaults,
        assignmentReferences,
      },
    );
    if (!validation.ok) {
      return invalidPlanResponse(validation.issues, validation.code);
    }

    try {
      const item = await deps.updateGlobal(workflowId, validation.launch);
      return NextResponse.json({
        item,
        ...authoredLaunchWarningFields(validation.warnings),
      });
    } catch (error) {
      const refusal = assignmentReferenceRefusal(error);
      if (refusal) return refusal;
      const message =
        error instanceof Error ? error.message : "Failed to update template";
      // Accept-time validation throws with a graph-validation code string, which
      // is a bad-request condition; a not-found update is the absent-id case.
      const status = /not found/i.test(message) ? 404 : 400;
      return NextResponse.json({ error: message } satisfies ApiError, {
        status,
      });
    }
  }

  async function EDIT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { workflowId = "" } = await context.params;
    const rawBody = await request.json().catch(() => undefined);
    return runDefinitionEditRequest({
      rawBody,
      notFoundError: "Template not found",
      loadRecord: () => deps.getGlobal(workflowId),
      admitLaunch: async (launch) => {
        const globalConfig = await deps.readConfig();
        return admitAuthoredWorkflowLaunch(launch, {
          caller: "global-template-edit",
          documentScope: { kind: "global" },
          globalValidation: globalConfig.validation,
          workflowDefaults: globalConfig.workflowDefaults,
          assignmentReferences,
        });
      },
      persist: (draft) => deps.updateGlobal(workflowId, draft),
    });
  }

  async function DELETE(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { workflowId = "" } = await context.params;
    const deleted = await deps.deleteGlobal(workflowId);
    if (!deleted) {
      return notFound("Template not found");
    }

    return NextResponse.json({ ok: true });
  }

  return { LIST_TEMPLATES, LIST_GLOBAL, CREATE, GET, UPDATE, EDIT, DELETE };
}
