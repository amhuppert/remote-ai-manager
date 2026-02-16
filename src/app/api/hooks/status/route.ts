import { NextResponse } from "next/server";
import { detectHooksStatus } from "@/lib/hooks";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

/** GET /api/hooks/status — check if Claude Code hooks are configured */
export const GET = withTracing(async () => {
  const status = await detectHooksStatus();
  return NextResponse.json(status);
});
