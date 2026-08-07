import { describe, expect, it } from "vitest";
import {
  createCapturingLogger,
  type CapturingLogger,
} from "@/lib/shared/testing/capturing-logger";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";
import {
  createAbortHandlers,
  createProjectAbortHandlers,
} from "./abort-route-handlers";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";
import type { ConversationState } from "./schemas";
import { makeConversationState } from "./testing/conversation-state-fixture";

/**
 * Stop for a project conversation (R5.1 / R5.2 / D13).
 *
 * A project conversation executes directly in the shared main worktree, so a
 * turn nobody can interrupt is the highest-severity gap in the parity set. The
 * mechanism it needs already exists and is already scope-neutral — the abort
 * registry is keyed by conversation id, and the machine owns the ABORT_TURN
 * transition including pending-question clearing. What was session-shaped was
 * route resolution: the only abort endpoint demanded a session record.
 *
 * These drive the real handlers with the seams they already expose, so what is
 * asserted is that the project adapter reaches the SAME registry and the SAME
 * machine transition the session adapter does — not that a parallel mechanism
 * was built for project scope.
 */

const ts = "2026-01-01T00:00:00.000Z";
const PROJECT_PATH = "/repos/cc";
const SESSION = "auth";
const CONV = "conv-1";

function conversation(id: string): ConversationState {
  return makeConversationState({
    id,
    scope: "project",
    status: "running",
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: ts,
  });
}

interface SentEvent {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  event: ConversationEvent;
}

/** Records what the shared registry + machine seams were asked to do. */
function recorder(options: { running?: string[]; machineAccepts?: boolean }) {
  const running = new Set(options.running ?? [CONV]);
  const signalled: string[] = [];
  const sent: SentEvent[] = [];
  const log: CapturingLogger = createCapturingLogger();
  return {
    running,
    signalled,
    sent,
    log,
    abortConversation(conversationId: string): boolean {
      if (!running.has(conversationId)) return false;
      running.delete(conversationId);
      signalled.push(conversationId);
      return true;
    },
    sendConversationEvent(
      projectPath: string,
      sessionName: string,
      conversationId: string,
      event: ConversationEvent,
    ): boolean {
      sent.push({ projectPath, sessionName, conversationId, event });
      return options.machineAccepts ?? true;
    },
  };
}

function projectHandlers(rec: ReturnType<typeof recorder>) {
  return createProjectAbortHandlers({
    async resolveProjectPath() {
      return PROJECT_PATH;
    },
    async getProjectConversation(_projectPath: string, conversationId: string) {
      return rec.running.has(conversationId) || conversationId === CONV
        ? conversation(conversationId)
        : null;
    },
    abortConversation: rec.abortConversation,
    sendConversationEvent: rec.sendConversationEvent,
    log: rec.log,
  });
}

function projectRequest(conversationId = CONV) {
  return {
    request: new Request(
      `http://127.0.0.1/api/projects/cc/conversations/${conversationId}/abort`,
      { method: "POST" },
    ),
    context: {
      params: Promise.resolve({ name: "cc", conversationId }),
    },
  };
}

describe("project conversation abort (R5.1)", () => {
  it("halts backend execution through the conversation-keyed abort registry", async () => {
    const rec = recorder({});
    const { request, context } = projectRequest();

    const res = await projectHandlers(rec).POST(request, context);

    expect(res.status).toBe(200);
    // The same registry the session path signals — keyed by conversation id,
    // with no session in the key.
    expect(rec.signalled).toEqual([CONV]);
  });

  it("settles the conversation through the same ABORT_TURN transition the session path uses", async () => {
    const rec = recorder({});
    const { request, context } = projectRequest();

    await projectHandlers(rec).POST(request, context);

    // Halting execution without the transition would leave the conversation
    // settling into the wrong terminal state and could strand a pending
    // question, so both are required.
    expect(rec.sent).toEqual([
      {
        projectPath: PROJECT_PATH,
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId: CONV,
        event: { type: "ABORT_TURN", reason: "user" },
      },
    ]);
  });

  it("sends the transition even when no controller was running, and reports 409", async () => {
    const rec = recorder({ running: [] });
    const { request, context } = projectRequest();

    const res = await projectHandlers(rec).POST(request, context);

    expect(res.status).toBe(409);
    // A conversation parked on a pending question has no controller to signal;
    // the transition is what clears the question, so it must still be sent.
    expect(rec.sent).toHaveLength(1);
  });

  it("404s an unknown project conversation without touching the registry", async () => {
    const rec = recorder({});
    const { request, context } = projectRequest("nope");

    const res = await projectHandlers(rec).POST(request, context);

    expect(res.status).toBe(404);
    expect(rec.signalled).toEqual([]);
    expect(rec.sent).toEqual([]);
  });

  it("never emits the internal sentinel as a session identity in diagnostics", async () => {
    const rec = recorder({ running: [], machineAccepts: false });
    const { request, context } = projectRequest();

    await projectHandlers(rec).POST(request, context);

    expect(rec.log.entries.map((e) => e.message)).toContain(
      "abort.event_rejected",
    );
    expect(rec.log.allFieldValues()).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    for (const entry of rec.log.entries) {
      expect(entry.fields).not.toHaveProperty("sessionName");
      expect(entry.fields["scope"]).toBe("project");
    }
  });
});

describe("project conversation abort isolation (R5.2)", () => {
  it("leaves other project conversations' turns running", async () => {
    const rec = recorder({ running: [CONV, "conv-2", "conv-3"] });
    const { request, context } = projectRequest();

    await projectHandlers(rec).POST(request, context);

    expect(rec.signalled).toEqual([CONV]);
    expect([...rec.running]).toEqual(["conv-2", "conv-3"]);
    expect(rec.sent.map((s) => s.conversationId)).toEqual([CONV]);
  });
});

describe("session conversation abort keeps its shape", () => {
  function sessionHandlers(rec: ReturnType<typeof recorder>) {
    return createAbortHandlers({
      async resolveProjectPath() {
        return PROJECT_PATH;
      },
      async getSession() {
        return { conversations: [conversation(CONV)] };
      },
      abortConversation: rec.abortConversation,
      sendConversationEvent: rec.sendConversationEvent,
      log: rec.log,
    });
  }

  it("signals the registry and sends ABORT_TURN with the real session name", async () => {
    const rec = recorder({});

    const res = await sessionHandlers(rec).POST(
      new Request(
        `http://127.0.0.1/api/projects/cc/sessions/${SESSION}/conversations/${CONV}/abort`,
        { method: "POST" },
      ),
      {
        params: Promise.resolve({
          name: "cc",
          session: SESSION,
          conversationId: CONV,
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(rec.signalled).toEqual([CONV]);
    expect(rec.sent[0]?.sessionName).toBe(SESSION);
  });

  it("refuses the internal sentinel in the public session position", async () => {
    const rec = recorder({});

    const res = await sessionHandlers(rec).POST(
      new Request("http://127.0.0.1/abort", { method: "POST" }),
      {
        params: Promise.resolve({
          name: "cc",
          session: PROJECT_CONVERSATION_SESSION_SENTINEL,
          conversationId: CONV,
        }),
      },
    );

    expect(res.status).toBe(400);
    expect(rec.signalled).toEqual([]);
  });
});
