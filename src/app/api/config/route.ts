import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

export const GET = withTracing(async () => {
  try {
    const config = await readConfig();
    return NextResponse.json({ baseDir: config.baseDir });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
