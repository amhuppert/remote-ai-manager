import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { resolveProjectPath } from "@/lib/project-resolver";
import { setProjectArchived } from "@/lib/state";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const archiveRequestSchema = z.object({
  archived: z.boolean(),
});

type RouteParams = { params: Promise<{ name: string }> };

/** POST /api/projects/[name]/archive — archive or unarchive a project */
export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { name } = await params;
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  let body: { archived: boolean };
  try {
    body = archiveRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "archived (boolean) is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    await setProjectArchived(projectPath, body.archived);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update archive state";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
}
