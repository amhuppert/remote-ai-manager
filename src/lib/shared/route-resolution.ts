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

/** Build a JSON `{ error }` Response with the given HTTP status. */
export function jsonError(message: string, status: number): Response {
  return NextResponse.json({ error: message } satisfies ApiError, { status });
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
