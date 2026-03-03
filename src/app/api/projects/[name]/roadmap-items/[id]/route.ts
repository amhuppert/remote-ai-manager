import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { updateRoadmapItem, deleteRoadmapItem } from "@/lib/state";
import { updateRoadmapItemRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** PATCH /api/projects/[name]/roadmap-items/[id] — update a roadmap item */
export const PATCH = withTracing(async (request, { params }) => {
  const { name = "", id = "" } = await params;
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  let body;
  try {
    body = updateRoadmapItemRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      {
        error:
          "Invalid request: at least one of title, description, status, or archived is required",
      } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    await updateRoadmapItem(projectPath, id, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update item";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 404,
    });
  }
});

/** DELETE /api/projects/[name]/roadmap-items/[id] — delete a roadmap item */
export const DELETE = withTracing(async (_request, { params }) => {
  const { name = "", id = "" } = await params;
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  try {
    await deleteRoadmapItem(projectPath, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to delete item";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 404,
    });
  }
});
