/**
 * Shared route-resolution plumbing for Next.js API handlers.
 *
 * Route handlers across domains repeat the same opening cross-section: unwrap
 * dynamic params, resolve the addressed entities (404 on miss), and validate
 * the request body (400 on miss). These helpers collapse that ladder behind a
 * single `RouteResolution<T>` contract so each handler threads preconditions
 * with `if (!r.ok) return r.response;` and keeps only its own service call and
 * response shape.
 *
 * Domain-specific resolvers (e.g. session-scoped vs project-scoped
 * conversations) compose `resolveProjectOr404` and return the same
 * `RouteResolution` shape, so they are interchangeable adapters at this seam.
 */

import { NextResponse } from "next/server";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import {
  CONVERSATION_ID_PLACEHOLDER,
  projectRouteForSessionRequestPath,
  type ProjectRouteEquivalent,
} from "@/lib/conversations/project-route-equivalent";
import { getTraceContext } from "@/lib/logging/context";
import type { ApiError } from "@/lib/api/errors";

/**
 * Outcome of a route precondition step. `ok: true` carries the resolved value;
 * `ok: false` carries a ready-to-return error `Response`. The failure variant
 * is independent of `T`, so a failure from one step can be returned directly
 * from a resolver producing a different `T`.
 */
export type RouteResolution<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

/**
 * Build a JSON `{ error }` Response with the given HTTP status. The optional
 * `code` and `details` map to the corresponding `ApiError` fields. Omitted
 * fields are absent from the body (not `undefined`), preserving the wire shape
 * of handlers that never sent them.
 */
export function jsonError(
  message: string,
  status: number,
  code?: string,
  details?: ApiError["details"],
): Response {
  const body: ApiError = { error: message };
  if (code !== undefined) body.code = code;
  if (details !== undefined) body.details = details;
  return NextResponse.json(body, { status });
}

/**
 * Build the seam's 404 `{ error }` Response. Handlers use this for
 * single-entity misses (`if (!item) return notFound("X not found");`) so the
 * 404 wire shape lives here rather than being hand-rolled per handler.
 */
export function notFound(
  message: string,
  code?: string,
  details?: ApiError["details"],
): Response {
  return jsonError(message, 404, code, details);
}

/**
 * Refuse the internal project-conversation sentinel when it arrives in a PUBLIC
 * session route position, naming the project-shaped route to use instead (D2).
 *
 * This is a malformed request, not a missing resource: returning the seam's
 * "Session not found" 404 would tell a caller the conversation does not exist
 * when it does, and silently accepting the sentinel (as the answer route did)
 * would keep a second, undocumented addressing contract alive. The message never
 * echoes the sentinel — it is an internal value, not a public one.
 *
 * The named replacement is resolved from the REQUEST PATH (via the trace context
 * `withTracing` establishes), not from the route params: params say which
 * conversation was addressed but not which of its endpoints, and a `/prompt`
 * request answered with the conversation base has been pointed at a route that
 * does not run its turn. The path is also the only input that can tell a
 * session-LEVEL operation with a project counterpart (`/commands`) from one
 * without (`/merge`), so the derivation decides in every traced request — which
 * every production handler is. The fallback below covers the untraced direct
 * call, where the addressed endpoint is simply unknowable and the conversation
 * shape is the most the caller's own params can say.
 *
 * Takes the session route param as received, decoded or not: the session
 * resolution seam decodes before calling, while a route that resolves its own
 * project generally passes the raw param, and a refusal that depended on which
 * is which would be a refusal a caller can spell its way around.
 *
 * Returns `null` when the session position is legitimate, so callers guard with
 * `const refusal = refuseProjectSentinelSessionParam(...); if (refusal) return refusal;`.
 */
export function refuseProjectSentinelSessionParam(
  sessionName: string,
  projectName: string,
  conversationId?: string,
): Response | null {
  if (
    !isProjectSentinel(sessionName) &&
    !isProjectSentinel(decodeParam(sessionName))
  ) {
    return null;
  }
  return jsonError(
    projectSentinelRefusalMessage(
      resolveProjectSentinelRefusalTarget(() => {
        const project = encodeURIComponent(projectName);
        const conversation =
          conversationId === undefined || conversationId === ""
            ? CONVERSATION_ID_PLACEHOLDER
            : encodeURIComponent(conversationId);
        return {
          kind: "project-route",
          route: `/api/projects/${project}/conversations/${conversation}`,
        };
      }),
    ),
    400,
    PROJECT_SENTINEL_REFUSAL_CODE,
  );
}

/** Percent-decode a route param, treating a malformed sequence as literal text. */
function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The refusal's replacement route, derived from the in-flight request path when
 * one is available and from `fallback` otherwise (background work, a direct
 * call outside `withTracing`). Shared so every public session route — including
 * the ones that refuse by throwing a domain error rather than returning a
 * Response — names the same endpoint for the same request.
 */
export function resolveProjectSentinelRefusalTarget(
  fallback: () => ResolvedRefusalTarget,
): ResolvedRefusalTarget {
  const requestPath = getTraceContext()?.requestPath;
  if (requestPath === undefined) return fallback();
  const derived = projectRouteForSessionRequestPath(requestPath);
  return derived.kind === "unknown" ? fallback() : derived;
}

/** The one error code every public session route uses to refuse the sentinel. */
export const PROJECT_SENTINEL_REFUSAL_CODE =
  "project_conversation_route_required";

const REFUSAL_PREAMBLE =
  "Project conversations are not addressable through a session route";

/**
 * The refusal text, shared so every public session route refuses identically.
 * Names the concrete project-shaped path for THAT endpoint when one exists, and
 * says so plainly when the operation has no project-scoped route — naming a
 * route that would 404 is the same misdirection R1.2 exists to prevent. Never
 * echoes the sentinel itself.
 */
export type ResolvedRefusalTarget = Exclude<
  ProjectRouteEquivalent,
  { kind: "unknown" }
>;

export function projectSentinelRefusalMessage(
  target: ResolvedRefusalTarget,
): string {
  if (target.kind === "project-route") {
    return `${REFUSAL_PREAMBLE} — use ${target.route} instead`;
  }
  return `${REFUSAL_PREAMBLE} — the "${target.operation}" operation is session-only and has no project-scoped route`;
}

export interface ResolveProjectDeps {
  resolveProjectPath(name: string): Promise<string | null>;
}

/**
 * Resolve a project root path from its display name, or a 404 Response when the
 * name does not map to a known project.
 */
export async function resolveProjectOr404(
  deps: ResolveProjectDeps,
  name: string,
): Promise<RouteResolution<string>> {
  const projectPath = await deps.resolveProjectPath(name);
  if (!projectPath) {
    return { ok: false, response: jsonError("Project not found", 404) };
  }
  return { ok: true, value: projectPath };
}

export interface ResolveProjectSessionDeps<S> extends ResolveProjectDeps {
  getSession(projectPath: string, sessionName: string): Promise<S | null>;
}

/**
 * Resolve a project path plus one of its sessions, or a 404 Response
 * ("Project not found" / "Session not found"). Generic over the session type
 * so domains with narrowed session deps reuse it without importing the full
 * session schema here.
 */
export async function resolveProjectSessionOr404<S>(
  deps: ResolveProjectSessionDeps<S>,
  projectName: string,
  sessionName: string,
): Promise<RouteResolution<{ projectPath: string; session: S }>> {
  const refusal = refuseProjectSentinelSessionParam(sessionName, projectName);
  if (refusal) return { ok: false, response: refusal };

  const project = await resolveProjectOr404(deps, projectName);
  if (!project.ok) return project;

  const session = await deps.getSession(project.value, sessionName);
  if (!session) {
    return { ok: false, response: notFound("Session not found") };
  }
  return { ok: true, value: { projectPath: project.value, session } };
}

/**
 * Parse and validate a JSON request body against `schema`, or a 400 Response
 * carrying `errorMessage` when the body is absent or fails validation. The
 * schema is the structural minimum (`parse(unknown): T`) so any Zod schema —
 * or a hand-rolled validator — satisfies it without coupling to a Zod version.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: { parse(input: unknown): T },
  errorMessage: string,
): Promise<RouteResolution<T>> {
  try {
    return { ok: true, value: schema.parse(await request.json()) };
  } catch {
    return { ok: false, response: jsonError(errorMessage, 400) };
  }
}
