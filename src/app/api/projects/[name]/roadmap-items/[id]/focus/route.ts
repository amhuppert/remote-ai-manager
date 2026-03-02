import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getRoadmapItems, updateRoadmapItem } from "@/lib/state";
import { createSessionFocus } from "@/lib/sessions";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/roadmap-items/[id]/focus — start a Focus session from a roadmap item */
export const POST = withTracing(async (_request, { params }) => {
  const { name = "", id = "" } = await params;
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const items = await getRoadmapItems(projectPath);
  const item = items.find((i) => i.id === id);
  if (!item) {
    return NextResponse.json(
      { error: "Roadmap item not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  // Compose objective from title + description
  const objective = item.description
    ? `${item.title}\n\n${item.description}`
    : item.title;

  try {
    const session = await createSessionFocus(projectPath, objective);

    // Mark item as done
    await updateRoadmapItem(projectPath, id, { status: "done" });

    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create focus session";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
