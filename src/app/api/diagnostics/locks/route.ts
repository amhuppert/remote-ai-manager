import { NextResponse } from "next/server";
import { getHeldSessionLocks, forceReleaseSessionLock } from "@/lib/lock";
import { getQuerySemaphoreStatus } from "@/lib/query-semaphore";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

/** GET /api/diagnostics/locks — list held session locks and semaphore status */
export const GET = withTracing(async () => {
  return NextResponse.json({
    sessionLocks: getHeldSessionLocks(),
    semaphore: getQuerySemaphoreStatus(),
  });
});

/** DELETE /api/diagnostics/locks — force-release a specific session lock */
export const DELETE = withTracing(async (request) => {
  const { projectPath, sessionName } = await request.json();
  if (!projectPath || !sessionName) {
    return NextResponse.json(
      { error: "projectPath and sessionName are required" },
      { status: 400 },
    );
  }

  const released = forceReleaseSessionLock(projectPath, sessionName);
  return NextResponse.json({ released });
});
