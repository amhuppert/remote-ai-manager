/**
 * Active conversations route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createActiveConversationsRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { readState as defaultReadState } from "@/lib/state";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/project-resolver";
import type { ManagerState, ConversationStatus } from "@/types";
import type { ApiError } from "@/types";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ActiveConversationsRouteDeps {
  readState: () => Promise<ManagerState>;
  getProjectDisplayName: (projectPath: string) => string;
}

const defaultDeps: ActiveConversationsRouteDeps = {
  readState: defaultReadState,
  getProjectDisplayName: defaultGetProjectDisplayName,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveConversation {
  id: string;
  name: string | null;
  status: ConversationStatus;
  lastActivityAt: string;
  projectName: string;
  projectPath: string;
  sessionName: string;
}

/** Statuses that qualify a conversation as "active" (visible in panels). */
const ACTIVE_STATUSES: ReadonlySet<ConversationStatus> = new Set([
  "new",
  "running",
  "awaiting",
  "waiting_for_input",
]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createActiveConversationsRouteHandlers(
  deps: ActiveConversationsRouteDeps = defaultDeps,
) {
  async function GET(): Promise<Response> {
    try {
      const state = await deps.readState();
      const conversations: ActiveConversation[] = [];

      for (const [projectPath, project] of Object.entries(state.projects)) {
        if (state.archivedProjects.includes(projectPath)) continue;

        const projectName = deps.getProjectDisplayName(projectPath);

        for (const session of Object.values(project.sessions)) {
          if (session.archived) continue;

          for (const convo of session.conversations) {
            if (convo.archived) continue;
            if (!ACTIVE_STATUSES.has(convo.status)) continue;

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

  return { GET };
}
