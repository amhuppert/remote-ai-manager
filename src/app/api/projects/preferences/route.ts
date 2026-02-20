import { NextResponse } from "next/server";
import { getArchivedProjects, getPinnedProjects } from "@/lib/state";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

export const GET = withTracing(async () => {
  try {
    const [archivedSet, pinnedSet] = await Promise.all([
      getArchivedProjects(),
      getPinnedProjects(),
    ]);
    return NextResponse.json({
      archived: Array.from(archivedSet),
      pinned: Array.from(pinnedSet),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read project preferences";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
