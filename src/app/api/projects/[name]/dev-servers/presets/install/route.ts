import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProjectPath } from "@/lib/project-resolver";
import { withTracing } from "@/lib/logging";
import { getPreset, installPreset } from "@/lib/dev-server-presets";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const installPresetRequestSchema = z.object({
  presetId: z.string().min(1),
  subdir: z.string().min(1).optional(),
});

/** POST /api/projects/[name]/dev-servers/presets/install — install a preset into a project */
export const POST = withTracing(async (request, { params }) => {
  const { name } = await params;
  const projectPath = await resolveProjectPath(name ?? "");
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const body = installPresetRequestSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid request: presetId is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  const { presetId, subdir } = body.data;

  if (!getPreset(presetId)) {
    return NextResponse.json(
      { error: `Unknown preset: ${presetId}` } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    const result = await installPreset({ projectPath, presetId, subdir });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Installation failed";
    if (message.includes("already installed")) {
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 409,
      });
    }
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
