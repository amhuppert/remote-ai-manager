/**
 * Diagnostics route handlers for /api/diagnostics/locks.
 *
 * GET returns the currently held session locks and semaphore status.
 * DELETE force-releases a specific session lock.
 */

import { NextResponse } from "next/server";
import {
  getHeldSessionLocks,
  forceReleaseSessionLock,
} from "@/lib/prompt/single-flight";
import { getQuerySemaphoreStatus } from "@/lib/shared/query-semaphore";
import { withTracing } from "@/lib/logging";

/** GET /api/diagnostics/locks — list held session locks and semaphore status */
export const getLocks = withTracing(async () => {
  return NextResponse.json({
    sessionLocks: getHeldSessionLocks(),
    semaphore: getQuerySemaphoreStatus(),
  });
});

/** DELETE /api/diagnostics/locks — force-release a specific session lock */
export const forceReleaseLock = withTracing(async (request) => {
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
