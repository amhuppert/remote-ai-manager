/**
 * Library CRUD over HTTP — one handler set per storage scope (R10, D22).
 *
 * The route TREE is the scope: `/api/agent-profiles` runs with no project in
 * play, `/api/projects/[name]/agent-profiles` runs inside the project its
 * `RouteResolution` step resolved. That is what makes cross-project isolation
 * structural rather than a check: a project-tier record is only ever addressed
 * through its own project's route, so another project's route cannot list,
 * read, or mutate it — there is no parameter to spell it with.
 *
 * A record is addressed by its QUALIFIED reference (`/[tier]/[id]`), because
 * `global:reviewer` and `project:reviewer` are different profiles and a bare id
 * would have to guess between them. The tier segment is a routing input, not a
 * permission: mutability is the library service's rule, so the builtin refusal
 * arrives from `assertMutableProfileTier` rather than being re-derived here.
 *
 * Two response rules carry contracts:
 *  - Mutations answer with the LISTING projection, not the record. The author
 *    already holds the text they just sent, and R6.3 confines instruction text
 *    to the authorized get; echoing it back would widen that surface for
 *    nothing.
 *  - The change event publishes strictly AFTER the service call returns, so a
 *    subscriber that refetches on it can never read state older than the event,
 *    and a refused or conflicted write publishes nothing at all.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  publishEvent,
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import { createWorkflowProfileReferenceReporter } from "@/lib/workflow-graph/profile-reference-reporter";

import { AgentProfileInstructionCollisionError } from "./composer";
import {
  agentProfileLibraryItemOf,
  createAgentProfileLibraryService,
  AgentProfileDeletionNotConfirmedError,
  AgentProfileNotResolvableError,
  type AgentProfileLibraryService,
  type AgentProfileProjectScope,
} from "./library-service";
import {
  AgentProfileIdConflictError,
  AgentProfileNotFoundError,
  AgentProfileProjectScopeRequiredError,
  AgentProfileRevisionConflictError,
} from "./storage";
import {
  agentProfileContentSchema,
  agentProfileIdSchema,
  agentProfileRefSchema,
  agentProfileTierSchema,
  AgentProfileInvalidIdError,
  AgentProfileTierReadOnlyError,
  type AgentProfileLibraryChangeAction,
  type AgentProfileLibraryChangedEvent,
  type AgentProfileLibraryEntry,
  type AgentProfileTier,
  type MutableAgentProfileTier,
} from "./schemas";

const logger = createLogger("agent-profile-routes");

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AgentProfileRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  library: AgentProfileLibraryService;
  publish: PublishFn;
}

/**
 * The composition root for the library's HTTP surface — and the ONLY place the
 * deletion-reference reporter is wired.
 *
 * The library declares the reporter port and refuses to answer a delete or a
 * preview without one; the workflow domain implements it; this module, which
 * already depends on both, is where the two meet. That is what lets
 * `agent-profiles` stay ignorant of `workflow-graph`: the dependency exists
 * only in the composition, never in the domain.
 */
const defaultDeps: AgentProfileRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  library: createAgentProfileLibraryService({
    referenceReporter: createWorkflowProfileReferenceReporter(),
  }),
  publish: publishEvent,
};

type RouteContext = { params: Promise<Record<string, string>> };

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * Create carries the editable content plus an optional id. `id` is optional
 * because the library derives one from the name; it is accepted because the
 * author may override that default — but only here, since an id is immutable
 * once the record exists.
 */
const createBodySchema = agentProfileContentSchema.extend({
  id: agentProfileIdSchema.optional(),
});

const updateBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    /** A whole replacement, never a patch: a half-written record is not a state. */
    content: agentProfileContentSchema,
  })
  .strict();

const deleteBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    /** Server-enforced: an unconfirmed delete is refused, not inferred. */
    confirm: z.boolean(),
  })
  .strict();

const duplicateBodySchema = z
  .object({
    source: agentProfileRefSchema,
    /** Defaults to the route scope's own tier. */
    targetTier: agentProfileTierSchema.optional(),
    /** Defaults to the source id; a collision refuses rather than suffixing. */
    targetId: agentProfileIdSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Scope adapter
// ---------------------------------------------------------------------------

/**
 * The storage scope a route tree addresses. `projectPath` is null on the
 * project-less tree; `tier` is where its creates land and what its duplicates
 * target by default.
 */
interface AgentProfileRouteScope {
  projectPath: AgentProfileProjectScope;
  tier: MutableAgentProfileTier;
}

const GLOBAL_SCOPE: AgentProfileRouteScope = {
  projectPath: null,
  tier: "global",
};

// ---------------------------------------------------------------------------
// Refusal mapping
// ---------------------------------------------------------------------------

/**
 * Map the library's typed refusals onto their HTTP shapes. The domain owns
 * which refusals exist and what they mean; this owns only how each is spelled
 * on the wire, so a new refusal shows up as a 500 here rather than as a
 * plausible-but-wrong status invented at a call site.
 */
function refusalResponse(err: unknown): Response {
  if (err instanceof AgentProfileRevisionConflictError) {
    return jsonError(err.message, 409, err.code, {
      expectedRevision: err.expectedRevision,
      winningRevision: err.winningRevision,
    });
  }
  if (err instanceof AgentProfileIdConflictError) {
    return jsonError(err.message, 409, err.code);
  }
  if (err instanceof AgentProfileTierReadOnlyError) {
    // Understood and refused on the record's own identity — not a missing
    // resource, and not something another caller could be permitted to do.
    return jsonError(err.message, 403, err.code);
  }
  if (
    err instanceof AgentProfileNotResolvableError ||
    err instanceof AgentProfileNotFoundError
  ) {
    return notFound(err.message, err.code);
  }
  if (
    err instanceof AgentProfileDeletionNotConfirmedError ||
    err instanceof AgentProfileInvalidIdError ||
    err instanceof AgentProfileInstructionCollisionError ||
    err instanceof AgentProfileProjectScopeRequiredError
  ) {
    return jsonError(err.message, 400, err.code);
  }

  logger.error("agent-profile-routes.failed", { error: getErrorMessage(err) });
  return jsonError("Agent profile request failed", 500);
}

function invalidBody(error: z.ZodError): Response {
  return jsonError(
    `Invalid agent profile request: ${error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
      .join("; ")}`,
    400,
    "agent_profile_invalid_request",
  );
}

async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<RouteResolution<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonError(
        "Invalid agent profile request: a JSON body is required",
        400,
        "agent_profile_invalid_request",
      ),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: invalidBody(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentProfileRouteHandlers(
  deps: AgentProfileRouteDeps = defaultDeps,
) {
  const { library } = deps;

  /**
   * Announce a committed change. Called only after the service call returns, so
   * a refused or conflicted write is silent on the wire. Best-effort by policy:
   * the record is already durable, so a wire failure must not fail the request.
   *
   * `tier` is the CHANGED RECORD's tier, which is also the scope consumers
   * invalidate by — a global record edited from a project route reaches every
   * project, and says so.
   */
  function publishChange(
    tier: AgentProfileTier,
    scope: AgentProfileRouteScope,
    id: string,
    revision: number,
    action: AgentProfileLibraryChangeAction,
  ): void {
    publishEventBestEffort({
      build: (): AgentProfileLibraryChangedEvent => {
        if (tier === "global") {
          return {
            type: "agent-profile-library-changed",
            scope: "global",
            tier: "global",
            id,
            revision,
            action,
          };
        }
        // Both remaining impossibilities are stated here rather than guarded at
        // each call site, and they throw INSIDE the best-effort build: the write
        // has already committed, so a defensive check must not turn a succeeded
        // mutation into a failed request.
        if (tier === "builtin") {
          throw new Error(
            `Refusing to announce a change to the read-only builtin tier (${id}).`,
          );
        }
        if (scope.projectPath === null) {
          throw new AgentProfileProjectScopeRequiredError();
        }
        return {
          type: "agent-profile-library-changed",
          scope: "project",
          projectPath: scope.projectPath,
          tier: "project",
          id,
          revision,
          action,
        };
      },
      logger,
      failureEvent: "agent-profile-routes.publish_failed",
      context: { tier, profileId: id, action },
      publish: deps.publish,
    });
  }

  function itemResponse(
    entry: AgentProfileLibraryEntry,
    status: number,
  ): Response {
    return NextResponse.json(agentProfileLibraryItemOf(entry), { status });
  }

  /** The qualified reference a record route addresses. */
  function refFromParams(
    params: Record<string, string>,
  ): RouteResolution<{ tier: AgentProfileTier; id: string }> {
    const tier = agentProfileTierSchema.safeParse(params["tier"]);
    if (!tier.success) {
      // An unspellable tier addresses no record, so this is a miss rather than
      // a malformed request — the same answer a valid tier with no record gives.
      return {
        ok: false,
        response: notFound(
          `Unknown agent profile tier ${JSON.stringify(params["tier"] ?? "")}. Expected builtin, global, or project.`,
          "agent_profile_unknown_tier",
        ),
      };
    }
    const id = agentProfileIdSchema.safeParse(params["id"]);
    if (!id.success) {
      return {
        ok: false,
        response: jsonError(
          new AgentProfileInvalidIdError(params["id"] ?? "").message,
          400,
          "agent_profile_invalid_id",
        ),
      };
    }
    return { ok: true, value: { tier: tier.data, id: id.data } };
  }

  /**
   * One scope's handler set. `resolveScope` is the RouteResolution step that
   * differs between the trees; everything below it is identical, which is the
   * point — two scopes, one set of semantics.
   */
  function handlersForScope(
    resolveScope: (
      context: RouteContext | undefined,
    ) => Promise<RouteResolution<AgentProfileRouteScope>>,
  ) {
    async function list(
      _request: Request,
      context?: RouteContext,
    ): Promise<Response> {
      const scope = await resolveScope(context);
      if (!scope.ok) return scope.response;
      try {
        return NextResponse.json(await library.list(scope.value.projectPath));
      } catch (err) {
        return refusalResponse(err);
      }
    }

    async function create(
      request: Request,
      context?: RouteContext,
    ): Promise<Response> {
      const scope = await resolveScope(context);
      if (!scope.ok) return scope.response;
      const parsed = await parseBody(request, createBodySchema);
      if (!parsed.ok) return parsed.response;

      const { id, ...content } = parsed.value;
      try {
        const entry = await library.create({
          projectPath: scope.value.projectPath,
          tier: scope.value.tier,
          ...(id === undefined ? {} : { id }),
          ...content,
        });
        publishChange(
          entry.tier,
          scope.value,
          entry.id,
          entry.revision,
          "created",
        );
        return itemResponse(entry, 201);
      } catch (err) {
        return refusalResponse(err);
      }
    }

    async function duplicate(
      request: Request,
      context?: RouteContext,
    ): Promise<Response> {
      const scope = await resolveScope(context);
      if (!scope.ok) return scope.response;
      const parsed = await parseBody(request, duplicateBodySchema);
      if (!parsed.ok) return parsed.response;

      const targetTier = parsed.value.targetTier ?? scope.value.tier;
      try {
        const entry = await library.duplicateToScope({
          projectPath: scope.value.projectPath,
          source: parsed.value.source,
          targetTier,
          ...(parsed.value.targetId === undefined
            ? {}
            : { targetId: parsed.value.targetId }),
        });
        // The copy's own tier decides who sees it, not the route it came from.
        publishChange(
          entry.tier,
          scope.value,
          entry.id,
          entry.revision,
          "created",
        );
        return itemResponse(entry, 201);
      } catch (err) {
        return refusalResponse(err);
      }
    }

    async function get(
      _request: Request,
      context?: RouteContext,
    ): Promise<Response> {
      const scope = await resolveScope(context);
      if (!scope.ok) return scope.response;
      const params = context ? await context.params : {};
      const ref = refFromParams(params);
      if (!ref.ok) return ref.response;

      try {
        // The one surface that carries instruction text (R6.3): an author
        // cannot edit what they cannot read.
        return NextResponse.json(
          await library.read(scope.value.projectPath, ref.value),
        );
      } catch (err) {
        return refusalResponse(err);
      }
    }

    async function update(
      request: Request,
      context?: RouteContext,
    ): Promise<Response> {
      const scope = await resolveScope(context);
      if (!scope.ok) return scope.response;
      const params = context ? await context.params : {};
      const ref = refFromParams(params);
      if (!ref.ok) return ref.response;
      const parsed = await parseBody(request, updateBodySchema);
      if (!parsed.ok) return parsed.response;

      try {
        const entry = await library.update({
          projectPath: scope.value.projectPath,
          ref: ref.value,
          expectedRevision: parsed.value.expectedRevision,
          content: parsed.value.content,
        });
        publishChange(
          entry.tier,
          scope.value,
          entry.id,
          entry.revision,
          "updated",
        );
        return itemResponse(entry, 200);
      } catch (err) {
        return refusalResponse(err);
      }
    }

    /**
     * What a delete would cost, without doing it. A GET because it is a read:
     * the delete dialog asks on open, and asking must never be able to change
     * anything — including on a double-open or a retry.
     */
    async function deletionPreview(
      _request: Request,
      context?: RouteContext,
    ): Promise<Response> {
      const scope = await resolveScope(context);
      if (!scope.ok) return scope.response;
      const params = context ? await context.params : {};
      const ref = refFromParams(params);
      if (!ref.ok) return ref.response;

      try {
        return NextResponse.json(
          await library.previewDeletion(scope.value.projectPath, ref.value),
        );
      } catch (err) {
        return refusalResponse(err);
      }
    }

    async function remove(
      request: Request,
      context?: RouteContext,
    ): Promise<Response> {
      const scope = await resolveScope(context);
      if (!scope.ok) return scope.response;
      const params = context ? await context.params : {};
      const ref = refFromParams(params);
      if (!ref.ok) return ref.response;
      const parsed = await parseBody(request, deleteBodySchema);
      if (!parsed.ok) return parsed.response;

      try {
        const report = await library.delete({
          projectPath: scope.value.projectPath,
          ref: ref.value,
          expectedRevision: parsed.value.expectedRevision,
          confirmed: parsed.value.confirm,
        });
        publishChange(
          report.ref.tier,
          scope.value,
          report.ref.id,
          report.deletedRevision,
          "deleted",
        );
        return NextResponse.json(report);
      } catch (err) {
        return refusalResponse(err);
      }
    }

    return { list, create, duplicate, get, update, deletionPreview, remove };
  }

  const global = handlersForScope(async () => ({
    ok: true,
    value: GLOBAL_SCOPE,
  }));

  const project = handlersForScope(async (context) => {
    const params = context ? await context.params : {};
    const resolved = await resolveProjectOr404(deps, params["name"] ?? "");
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      value: { projectPath: resolved.value, tier: "project" },
    };
  });

  return { global, project };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _handlers = createAgentProfileRouteHandlers();

export const listGlobalAgentProfiles = withTracing(_handlers.global.list);
export const createGlobalAgentProfile = withTracing(_handlers.global.create);
export const duplicateGlobalAgentProfile = withTracing(
  _handlers.global.duplicate,
);
export const getGlobalAgentProfile = withTracing(_handlers.global.get);
export const updateGlobalAgentProfile = withTracing(_handlers.global.update);
export const previewGlobalAgentProfileDeletion = withTracing(
  _handlers.global.deletionPreview,
);
export const deleteGlobalAgentProfile = withTracing(_handlers.global.remove);

export const listProjectAgentProfiles = withTracing(_handlers.project.list);
export const createProjectAgentProfile = withTracing(_handlers.project.create);
export const duplicateProjectAgentProfile = withTracing(
  _handlers.project.duplicate,
);
export const getProjectAgentProfile = withTracing(_handlers.project.get);
export const updateProjectAgentProfile = withTracing(_handlers.project.update);
export const previewProjectAgentProfileDeletion = withTracing(
  _handlers.project.deletionPreview,
);
export const deleteProjectAgentProfile = withTracing(_handlers.project.remove);
