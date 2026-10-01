/**
 * Route handler for images linked from agent messages, extracted for
 * dependency injection. The route shell delegates to the `withTracing`-wrapped
 * named export; tests build handlers over a real-store fixture (plus a faked
 * `readFile`) via `createWorktreeImageRouteHandlers(deps)`.
 *
 * - GET /api/projects/[name]/sessions/[session]/worktree-images?path=
 * - GET /api/projects/[name]/worktree-images?path= (project conversations)
 *
 * Serves an image file addressed by a relative or absolute path that resolves
 * inside the session worktree, or inside the project root for a project
 * conversation. Non-image paths return 400; paths outside that root and
 * missing files return 404.
 */

import { readFile as defaultReadFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import type { SessionState } from "@/lib/sessions/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { normalizeWorktreeLocator } from "./path";
import { documentContentPathSchema } from "./schemas";
import { imageMediaType } from "./worktree-links";

const logger = createLogger("documents-worktree-image-route");

export interface WorktreeImageRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  readFile(absPath: string): Promise<Uint8Array>;
}

const defaultDeps: WorktreeImageRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  readFile: (absPath) => defaultReadFile(absPath),
};

type RouteContext = { params: Promise<Record<string, string>> };

// An SVG opened directly (e.g. in a new tab) is a same-origin document; the
// sandbox keeps any script an agent wrote into it from running.
const IMAGE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function createWorktreeImageRouteHandlers(
  deps: WorktreeImageRouteDeps = defaultDeps,
) {
  async function serveImage(
    request: Request,
    root: string,
    owner: { projectName: string; sessionName: string | null },
  ): Promise<Response> {
    const rawPath = documentContentPathSchema.safeParse(
      new URL(request.url).searchParams.get("path"),
    );
    if (!rawPath.success) return jsonError("path query is required", 400);

    const mediaType = imageMediaType(rawPath.data);
    if (mediaType === null) return jsonError("Not an image path", 400);

    const located = normalizeWorktreeLocator(rawPath.data, root);
    if (located.location !== "worktree") return notFound("Image not found");
    const absPath = `${root.replace(/\/+$/, "")}/${located.path}`;

    let bytes: Uint8Array;
    try {
      bytes = await deps.readFile(absPath);
    } catch (err) {
      if (isEnoent(err)) return notFound("Image file not found");
      logger.error("documents-worktree-image.read.failed", {
        ...owner,
        imagePath: located.path,
        error: getErrorMessage(err),
      });
      return jsonError("Failed to read image", 500);
    }

    // A response body must be ArrayBuffer-backed; `readFile` only promises an
    // ArrayBufferLike view, so copy rather than cast.
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new NextResponse(body, {
      headers: {
        "content-type": mediaType,
        "content-length": String(body.byteLength),
        // Agents overwrite screenshots in place, so always revalidate.
        "cache-control": "private, no-cache",
        "content-security-policy": IMAGE_CONTENT_SECURITY_POLICY,
        "x-content-type-options": "nosniff",
      },
    });
  }

  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const projectName = resolvedParams["name"] ?? "";
    const sessionName = decodeURIComponent(resolvedParams["session"] ?? "");
    const resolved = await resolveProjectSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (!resolved.ok) return resolved.response;
    return serveImage(request, resolved.value.session.worktreePath, {
      projectName,
      sessionName,
    });
  }

  // Project conversations run in the project's main checkout.
  async function projectGET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const projectName = (await context.params)["name"] ?? "";
    const resolved = await resolveProjectOr404(deps, projectName);
    if (!resolved.ok) return resolved.response;
    return serveImage(request, resolved.value, {
      projectName,
      sessionName: null,
    });
  }

  return { GET, projectGET };
}

const _handlers = createWorktreeImageRouteHandlers();
export const getWorktreeImage = withTracing(_handlers.GET);
export const getProjectWorktreeImage = withTracing(_handlers.projectGET);
