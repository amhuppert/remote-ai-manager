import { NextResponse } from "next/server";
import { z } from "zod";
import { readConfig as defaultReadConfig } from "@/lib/config/loader";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import type { ApiError } from "@/lib/api/errors";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { WorkflowDefinitionRecord } from "@/lib/workflows/schemas";
import {
  workflowSemanticDefinitionSchema,
  graphWorkflowVisualLayoutSchema,
} from "@/lib/workflows/schemas";
import { resolveWorkflowDefinition } from "./resolve-config";
import {
  createWorkflowStorageService,
  type WorkflowDefinitionDraft,
  type WorkflowDefinitionSummary,
} from "./storage";
import {
  createTemplateLibraryService,
  type TemplateLibraryItem,
} from "./template-library-service";

const workflowDefinitionMutationSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().optional(),
  definition: workflowSemanticDefinitionSchema,
  layout: graphWorkflowVisualLayoutSchema,
});

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

async function resolveProjectOr404(
  deps: TemplateLibraryRouteDeps,
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

function parseMutationBody(
  raw: unknown,
):
  | { ok: true; draft: WorkflowDefinitionDraft }
  | { ok: false; detail: string } {
  const parsed = workflowDefinitionMutationSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      detail: detail || "name, definition, and layout are required",
    };
  }

  return {
    ok: true,
    draft: {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      definition: parsed.data.definition,
      layout: parsed.data.layout,
    },
  };
}

export function createTemplateLibraryRouteHandlers(
  deps: TemplateLibraryRouteDeps = defaultDeps,
) {
  async function LIST_TEMPLATES(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const projectPath = await resolveProjectOr404(deps, name);
    if (projectPath instanceof Response) {
      return projectPath;
    }

    const items = await deps.list(projectPath);
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
    const parsed = parseMutationBody(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json(
        { error: `Invalid request: ${parsed.detail}` } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      const item = await deps.createGlobal(parsed.draft);
      return NextResponse.json({ item }, { status: 201 });
    } catch (error) {
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
      return NextResponse.json(
        { error: "Template not found" } satisfies ApiError,
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
    const { workflowId = "" } = await context.params;
    const parsed = parseMutationBody(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json(
        { error: `Invalid request: ${parsed.detail}` } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      const item = await deps.updateGlobal(workflowId, parsed.draft);
      return NextResponse.json({ item });
    } catch (error) {
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

  async function DELETE(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { workflowId = "" } = await context.params;
    const deleted = await deps.deleteGlobal(workflowId);
    if (!deleted) {
      return NextResponse.json(
        { error: "Template not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  }

  return { LIST_TEMPLATES, LIST_GLOBAL, CREATE, GET, UPDATE, DELETE };
}
