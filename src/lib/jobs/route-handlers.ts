import { NextResponse } from "next/server";
import { withTracing } from "@/lib/logging";
import { getActiveJobs } from "./queue";

/** GET /api/jobs — returns all currently running background jobs */
export const GET = withTracing(async () => {
  return NextResponse.json({ jobs: getActiveJobs() });
});
