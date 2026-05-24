import { NextResponse } from "next/server";
import { z } from "zod";
import { readConfig } from "@/lib/config/loader";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import type { ApiError } from "@/lib/api/errors";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { WorkflowDefinitionRecord } from "@/lib/workflows/schemas";
import {
  createWorkflowStorageService,
  type WorkflowDefinitionDraft,
  type WorkflowDefinitionSummary,
} from "@/lib/workflow-graph/storage";
import {
  workflowSemanticDefinitionSchema,
  graphWorkflowVisualLayoutSchema,
} from "@/lib/workflows/schemas";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";

const workflowDefinitionMutationSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().optional(),
  definition: workflowSemanticDefinitionSchema,
  layout: graphWorkflowVisualLayoutSchema,
});

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface WorkflowDefinitionRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  readConfig(): Promise<GlobalConfig>;
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
  listDefinitions: (projectPath) => defaultStorage.list(projectPath),
  getDefinition: (projectPath, workflowId) =>
    defaultStorage.get(projectPath, workflowId),
  createDefinition: (projectPath, draft) =>
    defaultStorage.create(projectPath, draft),
  updateDefinition: (projectPath, workflowId, draft) =>
    defaultStorage.update(projectPath, workflowId, draft),
  deleteDefinition: (projectPath, workflowId) =>
    defaultStorage.delete(projectPath, workflowId),
};

async function resolveProjectOr404(
  deps: WorkflowDefinitionRouteDeps,
  name: string,
): Promise<string | Response> {
  const projectPath = await deps.resolveProjectPath(name);
  if (projectPath) {
    return projectPath;
  }

  return NextResponse.json({ error: "Project not found" } satisfies ApiError, {
    status: 404,
  });
}

export function createWorkflowDefinitionRouteHandlers(
  deps: WorkflowDefinitionRouteDeps = defaultDeps,
) {
  async function LIST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const projectPath = await resolveProjectOr404(deps, name);
    if (projectPath instanceof Response) {
      return projectPath;
    }

    const items = await deps.listDefinitions(projectPath);
    return NextResponse.json({ items });
  }

  async function CREATE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const projectPath = await resolveProjectOr404(deps, name);
    if (projectPath instanceof Response) {
      return projectPath;
    }

    let body: WorkflowDefinitionDraft;
    try {
      const parsed = workflowDefinitionMutationSchema.parse(
        await request.json(),
      );
      body = {
        name: parsed.name,
        description: parsed.description ?? null,
        definition: parsed.definition,
        layout: parsed.layout,
      };
    } catch (error) {
      const detail =
        error instanceof z.ZodError
          ? error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : "name, definition, and layout are required";
      return NextResponse.json(
        {
          error: `Invalid request: ${detail}`,
        } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      const item = await deps.createDefinition(projectPath, body);
      return NextResponse.json({ item }, { status: 201 });
    } catch (error) {
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
    const projectPath = await resolveProjectOr404(deps, name);
    if (projectPath instanceof Response) {
      return projectPath;
    }

    const item = await deps.getDefinition(projectPath, workflowId);
    if (!item) {
      return NextResponse.json(
        { error: "Workflow not found" } satisfies ApiError,
        { status: 404 },
      );
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
    const projectPath = await resolveProjectOr404(deps, name);
    if (projectPath instanceof Response) {
      return projectPath;
    }

    let body: WorkflowDefinitionDraft;
    try {
      const parsed = workflowDefinitionMutationSchema.parse(
        await request.json(),
      );
      body = {
        name: parsed.name,
        description: parsed.description ?? null,
        definition: parsed.definition,
        layout: parsed.layout,
      };
    } catch (error) {
      const detail =
        error instanceof z.ZodError
          ? error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : "name, definition, and layout are required";
      return NextResponse.json(
        {
          error: `Invalid request: ${detail}`,
        } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      const item = await deps.updateDefinition(projectPath, workflowId, body);
      return NextResponse.json({ item });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update workflow";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 404,
      });
    }
  }

  async function DELETE(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name = "", workflowId = "" } = await context.params;
    const projectPath = await resolveProjectOr404(deps, name);
    if (projectPath instanceof Response) {
      return projectPath;
    }

    const deleted = await deps.deleteDefinition(projectPath, workflowId);
    if (!deleted) {
      return NextResponse.json(
        { error: "Workflow not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  }

  return { LIST, CREATE, GET, UPDATE, DELETE };
}
