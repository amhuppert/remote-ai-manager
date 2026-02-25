import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

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
export const GET = withTracing(async (request, { params }) => {
  const { name } = await params;
  const projectPath = await resolveProjectPath(name ?? "");
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const filePath = url.searchParams.get("path");

  const kiroRoot = path.join(projectPath, ".kiro");

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
        return NextResponse.json(
          { error: "File not found" } satisfies ApiError,
          { status: 404 },
        );
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

  const steering = await listMarkdownFiles(steeringDir);

  const featureDirs = await listSubdirs(specsDir);
  const specs: Record<string, string[]> = {};
  for (const feature of featureDirs) {
    const files = await listMarkdownFiles(path.join(specsDir, feature));
    if (files.length > 0) {
      specs[feature] = files;
    }
  }

  return NextResponse.json({ steering, specs });
});
