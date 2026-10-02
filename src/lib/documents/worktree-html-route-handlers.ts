import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import type { SessionState } from "@/lib/sessions/schemas";
import { getSession } from "@/lib/state-store";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { normalizeWorktreeLocator } from "./path";
import { documentContentPathSchema } from "./schemas";
import { isHtmlPath, type LinkedFileScope } from "./worktree-links";

const logger = createLogger("documents-worktree-html-route");

// Reports may run inline interactions, but must not inherit CC's origin or
// send requests to its unauthenticated browser APIs. All assets are embedded.
const HTML_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts",
].join("; ");

export interface WorktreeHtmlRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
}

type RouteContext = { params: Promise<Record<string, string>> };

async function serveHtml(
  request: Request,
  root: string,
  owner: LinkedFileScope,
): Promise<Response> {
  const rawPath = documentContentPathSchema.safeParse(
    new URL(request.url).searchParams.get("path"),
  );
  if (!rawPath.success) return jsonError("path query is required", 400);
  if (!isHtmlPath(rawPath.data)) return jsonError("Not an HTML path", 400);

  const located = normalizeWorktreeLocator(rawPath.data, root);
  if (located.location !== "worktree") return notFound("HTML file not found");

  try {
    // Check actual paths too: a link or parent directory can escape the root.
    const [realRoot, realFile] = await Promise.all([
      realpath(root),
      realpath(join(root, located.path)),
    ]);
    if (normalizeWorktreeLocator(realFile, realRoot).location !== "worktree") {
      return notFound("HTML file not found");
    }
    if (!(await stat(realFile)).isFile())
      return notFound("HTML file not found");
    const bytes = await readFile(realFile);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(bytes.byteLength),
        "content-disposition": "inline",
        "cache-control": "private, no-cache",
        "content-security-policy": HTML_CONTENT_SECURITY_POLICY,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "ELOOP")
    ) {
      return notFound("HTML file not found");
    }
    logger.error("documents-worktree-html.read.failed", {
      projectName: owner.projectName,
      ...(owner.sessionName === null
        ? { scope: "project" }
        : { sessionName: owner.sessionName }),
      htmlPath: located.path,
      error: getErrorMessage(err),
    });
    return jsonError("Failed to read HTML file", 500);
  }
}

export function createWorktreeHtmlRouteHandlers(
  deps: WorktreeHtmlRouteDeps = { resolveProjectPath, getSession },
) {
  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = decodeURIComponent(params["session"] ?? "");
    const resolved = await resolveProjectSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (!resolved.ok) return resolved.response;
    return serveHtml(request, resolved.value.session.worktreePath, {
      projectName,
      sessionName,
    });
  }

  async function projectGET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const projectName = (await context.params)["name"] ?? "";
    const resolved = await resolveProjectOr404(deps, projectName);
    if (!resolved.ok) return resolved.response;
    return serveHtml(request, resolved.value, {
      projectName,
      sessionName: null,
    });
  }
  return { GET, projectGET };
}

const handlers = createWorktreeHtmlRouteHandlers();
export const getWorktreeHtml = withTracing(handlers.GET);
export const getProjectWorktreeHtml = withTracing(handlers.projectGET);
