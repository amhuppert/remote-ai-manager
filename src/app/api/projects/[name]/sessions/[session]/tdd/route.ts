import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, setSessionTddEnabled } from "@/lib/state";
import { sessionTddRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

// Publication audit (server-broadcasts context, task: audit-tdd-route):
// This route mutates session.tddEnabled, which is read by clients via the
// cached sessionKeys.list/detail queries. The originating client picks up
// the change via the mutation's onSuccess invalidation (see
// useTddToggleMutation in src/lib/mutations.ts).
// Cross-client sync would benefit from an SSE event, but none of the events
// defined in the foundation-event-contract catalog (`message-appended`,
// `message-updated`, `conversation-created`, `conversation-renamed`,
// `conversation-archived`) carries a session-level setting toggle, and the
// existing `conversation-status` event is conversation-scoped (not
// session-scoped). Per the audit-tdd-route task instructions, no new event
// schema is added here — that belongs to a future foundation-event-contract
// extension.
// TODO(sse-improvements): introduce a session-setting-changed event (or
// equivalent) so other clients pick up TDD toggles without window-focus
// refetch (which is being disabled in the polling-focus-cleanup context).

/** PATCH /api/projects/[name]/sessions/[session]/tdd — toggle TDD mode */
export const PATCH = withTracing(async (request, { params }) => {
  const bodyPromise = request.json();
  const resolvedParams = await params;
  const name = resolvedParams["name"] ?? "";
  const sessionSlug = resolvedParams["session"] ?? "";
  const sessionName = decodeURIComponent(sessionSlug);

  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const session = await getSession(projectPath, sessionName);
  if (!session) {
    return NextResponse.json(
      { error: "Session not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  let body: { tddEnabled: boolean };
  try {
    body = sessionTddRequestSchema.parse(await bodyPromise);
  } catch {
    return NextResponse.json(
      { error: "tddEnabled (boolean) is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    await setSessionTddEnabled(projectPath, sessionName, body.tddEnabled);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update TDD mode";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
