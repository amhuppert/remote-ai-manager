import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { resolveProjectPath } from "@/lib/project-resolver";
import { setProjectPinned } from "@/lib/state";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const pinRequestSchema = z.object({
  pinned: z.boolean(),
});

type RouteParams = { params: Promise<{ name: string }> };

/** POST /api/projects/[name]/pin — pin or unpin a project */
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
    await setProjectPinned(projectPath, body.pinned);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update pin state";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
}
