import { NextResponse } from "next/server";
import { detectHooksStatus } from "@/lib/hooks";

export const dynamic = "force-dynamic";

/** GET /api/hooks/status — check if Claude Code hooks are configured */
export async function GET(): Promise<NextResponse> {
  const status = await detectHooksStatus();
  return NextResponse.json(status);
}
