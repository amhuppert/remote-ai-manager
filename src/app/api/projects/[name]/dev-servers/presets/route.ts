import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { withTracing } from "@/lib/logging";
import { getPresets, getInstalledPresets } from "@/lib/dev-server-presets";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/dev-servers/presets — list available presets with installed status */
export const GET = withTracing(async (_request, { params }) => {
  const { name } = await params;
  const projectPath = await resolveProjectPath(name ?? "");
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const allPresets = getPresets();
  const installed = await getInstalledPresets(projectPath);

  const presets = allPresets.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    badge: p.badge,
    files: [
      `.cc/dev-servers/_helpers.sh`,
      `.cc/dev-servers/${p.scriptFileName}`,
      "CommandCenter.json",
    ],
    installed: installed.includes(p.id),
  }));

  return NextResponse.json({ presets });
});
