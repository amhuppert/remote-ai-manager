/**
 * Route handler for /api/projects/[name]/kiro-docs.
 *
 * Two modes:
 * - No `path` query param: returns the full tree of available .kiro/ markdown files.
 * - With `path` query param: returns the content of a specific file.
 *
 * When a `session` query param is supplied and the session worktree contains
 * a `.kiro/` directory, the handler reads from the worktree instead of the
 * project root.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { notFound, resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";

/** Only allow paths matching steering/{file}.md or specs/{feature}/{file}.md */
const VALID_PATH = /^(steering\/[\w.-]+\.md|specs\/[\w.-]+\/[\w.-]+\.md)$/;

/** List all .md files in a directory, returning just filenames sorted */
async function listMarkdownFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** List all subdirectories in a directory */
async function listSubdirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * GET /api/projects/[name]/kiro-docs
 *
 * Two modes:
 * - No `path` query param: returns the full tree of available .kiro/ markdown files
 * - With `path` query param: returns the content of a specific file
 */
export const getProjectKiroDocs = withTracing(async (request, { params }) => {
  const { name } = await params;
  const project = await resolveProjectOr404({ resolveProjectPath }, name ?? "");
  if (!project.ok) return project.response;
  const projectPath = project.value;

  const url = new URL(request.url);
  const filePath = url.searchParams.get("path");
  const sessionName = url.searchParams.get("session");

  // When a session is specified, read from its worktree instead of the project root
  let basePath = projectPath;
  if (sessionName) {
    const session = await getSession(projectPath, sessionName);
    if (session?.worktreePath) {
      const worktreeKiro = path.join(session.worktreePath, ".kiro");
      if (existsSync(worktreeKiro)) {
        basePath = session.worktreePath;
      }
    }
  }

  const kiroRoot = path.join(basePath, ".kiro");

  // --- Read mode: return content of a specific file ---
  if (filePath) {
    if (!VALID_PATH.test(filePath)) {
      return NextResponse.json({ error: "Invalid path" } satisfies ApiError, {
        status: 400,
      });
    }

    const absolutePath = path.join(kiroRoot, filePath);

    try {
      const content = await readFile(absolutePath, "utf-8");
      return NextResponse.json({ content });
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return notFound("File not found");
      }
      return NextResponse.json(
        { error: "Failed to read file" } satisfies ApiError,
        { status: 500 },
      );
    }
  }

  // --- List mode: return full directory tree ---
  const steeringDir = path.join(kiroRoot, "steering");
  const specsDir = path.join(kiroRoot, "specs");

  const [steering, featureDirs] = await Promise.all([
    listMarkdownFiles(steeringDir),
    listSubdirs(specsDir),
  ]);
  const featureFiles = await Promise.all(
    featureDirs.map(async (feature) => ({
      feature,
      files: await listMarkdownFiles(path.join(specsDir, feature)),
    })),
  );
  const specs: Record<string, string[]> = {};
  for (const { feature, files } of featureFiles) {
    if (files.length > 0) {
      specs[feature] = files;
    }
  }

  return NextResponse.json({ steering, specs });
});
