/**
 * Pin route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createPinRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { setProjectPinned as defaultSetProjectPinned } from "@/lib/state-store";
import type { ApiError } from "@/lib/api/errors";
// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface PinRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  setProjectPinned: (projectPath: string, pinned: boolean) => Promise<void>;
}

const defaultDeps: PinRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  setProjectPinned: defaultSetProjectPinned,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const pinRequestSchema = z.object({
  pinned: z.boolean(),
});

type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPinRouteHandlers(deps: PinRouteDeps = defaultDeps) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";

    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    let body: { pinned: boolean };
    try {
      body = pinRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "pinned (boolean) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      await deps.setProjectPinned(projectPath, body.pinned);
      return NextResponse.json({ ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update pin state";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }

  return { POST };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultPinHandlers = createPinRouteHandlers();
export const pinProject = _defaultPinHandlers.POST;
