import { NextResponse } from "next/server";
import { readState } from "@/lib/state";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

interface ActiveConversation {
  id: string;
  name: string | null;
  status: "running" | "awaiting" | "waiting_for_input";
  lastActivityAt: string;
  projectName: string;
  projectPath: string;
  sessionName: string;
}

/**
 * GET /api/conversations/active
 *
 * Returns all conversations with status `running` or `awaiting` across
 * all projects and sessions, sorted by most recent activity first.
 * Excludes conversations in archived sessions.
 */
export async function GET() {
  try {
    const state = await readState();
    const conversations: ActiveConversation[] = [];

    for (const [projectPath, project] of Object.entries(state.projects)) {
      // Skip archived projects
      if (state.archivedProjects.includes(projectPath)) continue;

      const projectName = projectPath.split("/").pop() ?? projectPath;

      for (const session of Object.values(project.sessions)) {
        // Skip archived sessions
        if (session.archived) continue;

        for (const convo of session.conversations) {
          if (convo.archived) continue;
          if (
            convo.status !== "running" &&
            convo.status !== "awaiting" &&
            convo.status !== "waiting_for_input"
          )
            continue;

          conversations.push({
            id: convo.id,
            name: convo.name ?? convo.summary ?? null,
            status: convo.status,
            lastActivityAt: convo.lastActivityAt,
            projectName,
            projectPath,
            sessionName: session.sessionName,
          });
        }
      }
    }

    // Sort by most recent activity first
    conversations.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime(),
    );

    return NextResponse.json({ conversations });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Failed to read active conversations";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
}
