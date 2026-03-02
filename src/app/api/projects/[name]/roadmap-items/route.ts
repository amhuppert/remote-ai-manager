import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getRoadmapItems, createRoadmapItem } from "@/lib/state";
import { createRoadmapItemRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/roadmap-items — list all roadmap items */
export const GET = withTracing(async (_request, { params }) => {
  const name = (await params)["name"] ?? "";
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const items = await getRoadmapItems(projectPath);
  return NextResponse.json({ items });
});

/** POST /api/projects/[name]/roadmap-items — create a new roadmap item */
export const POST = withTracing(async (request, { params }) => {
  const name = (await params)["name"] ?? "";
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  let body;
  try {
    body = createRoadmapItemRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      {
        error: "Invalid request: title and type are required",
      } satisfies ApiError,
      { status: 400 },
    );
  }

  const item = await createRoadmapItem(projectPath, body);
  return NextResponse.json({ item }, { status: 201 });
});
