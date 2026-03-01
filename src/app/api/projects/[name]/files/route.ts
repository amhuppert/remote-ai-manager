import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { scanProjectFiles } from "@/lib/file-scanner";
import { withTracing } from "@/lib/logging";
import type { ApiError, ProjectFilesResponse } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/files — list all project files */
export const GET = withTracing(async (_request, { params }) => {
  const name = (await params)["name"] ?? "";

  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  try {
    const items = await scanProjectFiles(projectPath);
    const response: ProjectFilesResponse = { items };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to scan files";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
