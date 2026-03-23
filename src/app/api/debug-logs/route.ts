import { NextResponse } from "next/server";
import { readState } from "@/lib/state";
import { debugLogEntrySchema } from "@/lib/schemas";
import { appendDebugLogEntry, getDebugLogStats } from "@/lib/debug-log";
import { broadcast } from "@/lib/sse-broadcaster";
import type { ConversationState, SessionState } from "@/types";

export const dynamic = "force-dynamic";

interface ConversationContext {
  projectName: string;
  sessionName: string;
  conversation: ConversationState;
  session: SessionState;
}

/** Look up a conversation by ID across all projects/sessions */
async function findConversationContext(
  conversationId: string,
): Promise<ConversationContext | null> {
  const state = await readState();
  for (const [projectName, project] of Object.entries(state.projects)) {
    for (const [, session] of Object.entries(project.sessions)) {
      const conversation = session.conversations.find(
        (c) => c.id === conversationId,
      );
      if (conversation) {
        return {
          projectName,
          sessionName: session.sessionName,
          conversation,
          session,
        };
      }
    }
  }
  return null;
}

/** POST /api/debug-logs?conversationId={id} — receive debug log entries from instrumented app */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) {
    // Always return 200 so instrumented app doesn't break
    return NextResponse.json({ ok: true });
  }

  const ctx = await findConversationContext(conversationId);
  if (!ctx) {
    return NextResponse.json({ ok: true });
  }

  // If debug mode is not active or recording is paused, silently drop
  if (
    !ctx.conversation.debugMode?.active ||
    !ctx.conversation.debugMode.recording
  ) {
    return NextResponse.json({ ok: true });
  }

  const logFilePath = ctx.conversation.debugMode.logFilePath;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  // Accept single entry or array of entries
  const entries = Array.isArray(body) ? body : [body];
  let written = 0;

  for (const raw of entries) {
    const result = debugLogEntrySchema.safeParse(raw);
    if (result.success) {
      appendDebugLogEntry(logFilePath, result.data);
      written++;
    }
  }

  if (written > 0) {
    const stats = getDebugLogStats(logFilePath);
    broadcast({
      type: "debug-log-received",
      projectName: ctx.projectName,
      sessionName: ctx.sessionName,
      conversationId,
      entryCount: stats.entryCount,
    });
  }

  return NextResponse.json({ ok: true });
}
