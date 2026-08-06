import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logging";
import { notFound, resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { readConfig } from "@/lib/config/loader";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { readRepoConfig } from "@/lib/projects/repo-config";
import type { ApiError } from "@/lib/api/errors";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import {
  createWorkflowStorageService,
  type WorkflowDefinitionDraft,
  type WorkflowDefinitionSummary,
} from "@/lib/workflow-graph/storage";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import { createValidationCommandPreflight } from "@/lib/validation/preflight";
import { validateWorkflowPlan } from "./plan-validation";
import { runDefinitionEditRequest } from "./definition-edit-handler";
import { assignmentReferenceRefusal } from "./assignment-reference-refusal";

const logger = createLogger("workflow-graph");

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
  ): Promise<unknown>;
  updateDefinition(
    projectPath: string,
    workflowId: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<unknown>;
  deleteDefinition(projectPath: string, workflowId: string): Promise<boolean>;
}

const defaultStorage = createWorkflowStorageService();

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
  updateDefinition: (projectPath, workflowId, draft) =>
    defaultStorage.update({ kind: "project", projectPath }, workflowId, draft),
  deleteDefinition: (projectPath, workflowId) =>
    defaultStorage.delete({ kind: "project", projectPath }, workflowId),
};

export function createWorkflowDefinitionRouteHandlers(
  deps: WorkflowDefinitionRouteDeps = defaultDeps,
) {
  async function LIST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const items = await deps.listDefinitions(projectPath);
    return NextResponse.json({ items });
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
    const validation = validateWorkflowPlan(rawBody, {
      validationCommandPreflight: createValidationCommandPreflight(
        repoConfig?.validation,
        globalConfig.validation,
      ),
    });
    if (!validation.ok) {
      logger.warn("workflow-graph.definition-create.rejected", {
        projectPath,
        issueCount: validation.issues.length,
        code: validation.code ?? "invalid_plan",
      });
      return NextResponse.json(
        {
          error: "Workflow plan is invalid",
          ...(validation.code ? { code: validation.code } : {}),
          issues: validation.issues,
        },
        { status: 400 },
      );
    }

    try {
      const item = await deps.createDefinition(projectPath, validation.draft);
      return NextResponse.json({ item }, { status: 201 });
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

    return NextResponse.json({ item, resolved });
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

    const [repoConfig, globalConfig] = await Promise.all([
      deps.readRepoConfig(projectPath),
      deps.readConfig(),
    ]);
    const validation = validateWorkflowPlan(rawBody, {
      validationCommandPreflight: createValidationCommandPreflight(
        repoConfig?.validation,
        globalConfig.validation,
      ),
    });
    if (!validation.ok) {
      logger.warn("workflow-graph.definition-replace.rejected", {
        projectPath,
        workflowId,
        issueCount: validation.issues.length,
        code: validation.code ?? "invalid_plan",
      });
      return NextResponse.json(
        {
          error: "Workflow plan is invalid",
          ...(validation.code ? { code: validation.code } : {}),
          issues: validation.issues,
        },
        { status: 400 },
      );
    }

    try {
      const item = await deps.updateDefinition(
        projectPath,
        workflowId,
        validation.draft,
      );
      return NextResponse.json({ item });
    } catch (error) {
      // Ordered before the 404 fallback on purpose: an unresolvable assignment
      // reference is a refusal of the SUBMITTED document, not a missing id, and
      // reporting it as "not found" hid its located issues entirely.
      const refusal = assignmentReferenceRefusal(error);
      if (refusal) return refusal;
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
    return runDefinitionEditRequest({
      rawBody,
      notFoundError: "Workflow not found",
      loadRecord: () => deps.getDefinition(projectPath, workflowId),
      loadValidationCommandPreflight: async () => {
        const [repoConfig, globalConfig] = await Promise.all([
          deps.readRepoConfig(projectPath),
          deps.readConfig(),
        ]);
        return createValidationCommandPreflight(
          repoConfig?.validation,
          globalConfig.validation,
        );
      },
      persist: (draft) => deps.updateDefinition(projectPath, workflowId, draft),
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

    const deleted = await deps.deleteDefinition(projectPath, workflowId);
    if (!deleted) {
      return notFound("Workflow not found");
    }

    return NextResponse.json({ ok: true });
  }

  return { LIST, CREATE, GET, UPDATE, EDIT, DELETE };
}
