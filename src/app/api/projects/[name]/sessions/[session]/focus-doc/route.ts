import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions/[session]/focus-doc — read focus.md from session worktree */
export const GET = withTracing(async (_request, { params }) => {
  const { name, session } = await params;
  const projectPath = await resolveProjectPath(name ?? "");
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const sessionState = await getSession(projectPath, session ?? "");
  if (!sessionState) {
    return NextResponse.json(
      { error: "Session not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const focusPath = path.join(
    sessionState.worktreePath,
    "memory-bank",
    "focus.md",
  );

  try {
    const content = await readFile(focusPath, "utf-8");
    return NextResponse.json({ content });
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return NextResponse.json(
        { error: "Focus document not found" } satisfies ApiError,
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "Failed to read focus document" } satisfies ApiError,
      { status: 500 },
    );
  }
});
