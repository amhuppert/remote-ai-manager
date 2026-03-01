import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { discoverCommands } from "@/lib/commands";
import { withTracing } from "@/lib/logging";
import type { ApiError, CommandsResponse } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/commands — discover available commands from the project root */
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
    const items = await discoverCommands(projectPath);
    const response: CommandsResponse = { items };
    return NextResponse.json(response);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to discover commands";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
