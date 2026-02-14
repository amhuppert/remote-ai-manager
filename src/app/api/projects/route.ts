import { NextResponse } from "next/server";
import { discoverProjects } from "@/lib/discovery";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const projects = await discoverProjects();
    return NextResponse.json(projects);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to discover projects";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
