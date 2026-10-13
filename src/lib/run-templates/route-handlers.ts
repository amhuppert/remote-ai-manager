/**
 * Run template library over HTTP.
 *
 * - GET    /api/projects/[name]/run-templates            → the project's templates and the global ones
 * - GET    /api/projects/[name]/run-templates/[tier]/[id] → one template, with the global tier it falls back to
 * - PUT    /api/projects/[name]/run-templates/[tier]/[id] → create (expectedRevision null) or replace it
 * - DELETE /api/projects/[name]/run-templates/[tier]/[id] → delete it at its current revision
 *
 * The project route tree is the scope, as for agent profiles: a project's
 * templates are reached only through its own routes, and the global tier
 * through any project's. Each committed write publishes one
 * `run-template-changed` after the write returns; a refused write publishes
 * nothing.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  publishEvent,
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import { createLogger, withTracing, type Logger } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  runTemplateTierSchema,
  type RunTemplateTier,
} from "@/lib/runs/schemas";
import { RUN_SETTING_DEFAULTS } from "@/lib/runs/settings";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  type RouteResolution,
} from "@/lib/shared/route-resolution";

import type { RunTemplateDetailResponse } from "./document";
import {
  runTemplateIdSchema,
  type RunTemplateChangeAction,
  type RunTemplateChangedEvent,
  type RunTemplateDeletedResponse,
} from "./schemas";
import { createProductionRunTemplateService } from "./production";
import type { RunTemplateRefusal, RunTemplateService } from "./service";

type RouteContext = { params: Promise<Record<string, string>> };
type Handler = (request: Request, context: RouteContext) => Promise<Response>;

export interface RunTemplateRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  templates: RunTemplateService;
  publish: PublishFn;
  log: Pick<Logger, "info" | "warn">;
}

const saveBodySchema = z
  .object({
    /** Null creates the template; a number replaces that revision. */
    expectedRevision: z.number().int().positive().nullable(),
    /** The whole template content; checked by the library, which locates each issue. */
    template: z.unknown(),
  })
  .strict();

const deleteBodySchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();

interface Addressed {
  projectPath: string;
  tier: RunTemplateTier;
  id: string;
}

async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<RouteResolution<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonError("Request body must be JSON", 400, "invalid_request"),
    };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: "Invalid run template request",
        code: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    ),
  };
}

function refusalResponse(refusal: RunTemplateRefusal): Response {
  switch (refusal.code) {
    case "run_template_invalid":
      return NextResponse.json(
        {
          error: refusal.message,
          code: refusal.code,
          issues: refusal.issues,
        },
        { status: 400 },
      );
    case "run_template_not_found":
      return notFound(refusal.message, refusal.code);
    case "run_template_exists":
      return jsonError(
        refusal.message,
        409,
        refusal.code,
        undefined,
        "Replace it at its current revision, or choose another id.",
      );
    case "run_template_revision_conflict":
      return jsonError(
        refusal.message,
        409,
        refusal.code,
        { currentRevision: refusal.currentRevision },
        "Read the template again and reapply your change to its current revision.",
      );
  }
}

export function createRunTemplateRouteHandlers(
  deps: RunTemplateRouteDeps,
): Record<"list" | "get" | "save" | "remove", Handler> {
  const { templates, log } = deps;

  async function project(
    context: RouteContext,
  ): Promise<RouteResolution<string>> {
    const { name } = await context.params;
    return resolveProjectOr404(deps, name ?? "");
  }

  /** The project, and the template its `[tier]/[id]` segments name. */
  async function addressed(
    context: RouteContext,
  ): Promise<RouteResolution<Addressed>> {
    const resolved = await project(context);
    if (!resolved.ok) return resolved;
    const params = await context.params;
    const tier = runTemplateTierSchema.safeParse(params["tier"]);
    if (!tier.success)
      return {
        ok: false,
        response: notFound(
          `Unknown run template tier ${JSON.stringify(params["tier"] ?? "")}; use project or global`,
          "run_template_unknown_tier",
        ),
      };
    const id = runTemplateIdSchema.safeParse(params["id"]);
    if (!id.success)
      return {
        ok: false,
        response: jsonError(
          `Invalid run template id ${JSON.stringify(params["id"] ?? "")}: ${id.error.issues[0]?.message ?? "malformed"}`,
          400,
          "run_template_invalid_id",
        ),
      };
    return {
      ok: true,
      value: { projectPath: resolved.value, tier: tier.data, id: id.data },
    };
  }

  /** Called only after a write commits, so a refused write is silent on the wire. */
  function publishChange(
    target: Addressed,
    revision: number,
    action: RunTemplateChangeAction,
  ): void {
    publishEventBestEffort({
      build: (): RunTemplateChangedEvent =>
        target.tier === "global"
          ? {
              type: "run-template-changed",
              scope: "global",
              id: target.id,
              revision,
              action,
            }
          : {
              type: "run-template-changed",
              scope: "project",
              projectPath: target.projectPath,
              id: target.id,
              revision,
              action,
            },
      logger: log,
      failureEvent: "run-templates.publish_failed",
      context: { tier: target.tier, templateId: target.id, action },
      publish: deps.publish,
    });
  }

  function refused(
    operation: "save" | "delete",
    target: Addressed,
    refusal: RunTemplateRefusal,
  ): Response {
    log.info(`run-templates.${operation}_refused`, {
      tier: target.tier,
      templateId: target.id,
      code: refusal.code,
      ...(refusal.code === "run_template_invalid"
        ? { issues: refusal.issues.length }
        : {}),
    });
    return refusalResponse(refusal);
  }

  return {
    async list(_request, context) {
      const resolved = await project(context);
      if (!resolved.ok) return resolved.response;
      return NextResponse.json(await templates.list(resolved.value));
    },

    async get(_request, context) {
      const target = await addressed(context);
      if (!target.ok) return target.response;
      const { projectPath, tier, id } = target.value;
      const read = await templates.get(projectPath, tier, id);
      if (read.kind === "absent")
        return notFound(
          `Run template ${tier}:${id} does not exist`,
          "run_template_not_found",
        );
      if (read.kind === "unreadable")
        return notFound(
          `Run template ${tier}:${id} cannot be read (${read.reason}); fix or remove ${read.path}`,
          "run_template_not_found",
        );
      const body: RunTemplateDetailResponse = {
        template: read.record,
        globals: RUN_SETTING_DEFAULTS,
      };
      return NextResponse.json(body);
    },

    async save(request, context) {
      const target = await addressed(context);
      if (!target.ok) return target.response;
      const body = await readBody(request, saveBodySchema);
      if (!body.ok) return body.response;
      const saved = await templates.save({
        ...target.value,
        expectedRevision: body.value.expectedRevision,
        content: body.value.template,
      });
      if (!saved.ok) return refused("save", target.value, saved.refusal);
      publishChange(target.value, saved.record.revision, saved.action);
      return NextResponse.json(
        { template: saved.record },
        { status: saved.action === "created" ? 201 : 200 },
      );
    },

    async remove(request, context) {
      const target = await addressed(context);
      if (!target.ok) return target.response;
      const body = await readBody(request, deleteBodySchema);
      if (!body.ok) return body.response;
      const deleted = await templates.delete({
        ...target.value,
        expectedRevision: body.value.expectedRevision,
      });
      if (!deleted.ok) return refused("delete", target.value, deleted.refusal);
      publishChange(target.value, deleted.record.revision, "deleted");
      const response: RunTemplateDeletedResponse = {
        ok: true,
        tier: target.value.tier,
        id: target.value.id,
        revision: deleted.record.revision,
      };
      return NextResponse.json(response);
    },
  };
}

const handlers = createRunTemplateRouteHandlers({
  resolveProjectPath,
  templates: createProductionRunTemplateService(),
  publish: publishEvent,
  log: createLogger("run-templates"),
});

export const listRunTemplatesGET = withTracing(handlers.list);
export const getRunTemplateGET = withTracing(handlers.get);
export const saveRunTemplatePUT = withTracing(handlers.save);
export const deleteRunTemplateDELETE = withTracing(handlers.remove);
