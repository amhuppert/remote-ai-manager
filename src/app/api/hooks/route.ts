import { NextResponse, type NextRequest } from "next/server";
import { processHookEvent, type HookEventData } from "@/lib/hooks";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/hooks — receive Claude Code hook events.
 *
 * Claude hooks fire with JSON on stdin. The hook command should forward
 * this data to this endpoint via curl:
 *
 *   cat | curl -s -X POST http://localhost:3000/api/hooks \
 *     -H "Content-Type: application/json" -d @-
 *
 * The endpoint matches the `cwd` to a managed session's worktreePath
 * and updates the session's claudeSessionId and transcriptPath.
 */
export async function POST(request: NextRequest) {
  let body: HookEventData;
  try {
    body = (await request.json()) as HookEventData;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    const matched = await processHookEvent(body);
    return NextResponse.json({ matched });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to process hook event";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
}
