import { NextResponse } from "next/server";
import { getActiveJobs } from "@/lib/background-jobs";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

/** GET /api/jobs — returns all currently running background jobs */
export const GET = withTracing(async () => {
  return NextResponse.json({ jobs: getActiveJobs() });
});
