import { describe, expect, it, vi } from "vitest";

import {
  buildNotepadFeedbackPayload,
  deliverNotepadFeedback,
  type DispatchFetch,
} from "./notepad-comment-dispatch";
import type { DocumentFeedbackTarget } from "@/lib/document-comments/schemas";
import type {
  NotepadCommentStatus,
  ResolvedNotepadCommentThread,
} from "@/lib/notepads/schemas";

const NOTEPAD = {
  notepadId: "np-1",
  name: "Release plan",
  scope: "global" as const,
  projectName: null,
};

function thread(
  id: string,
  status: NotepadCommentStatus,
  overrides: {
    body?: string;
    location?: string;
    quote?: string;
    state?: "anchored" | "stale";
  } = {},
): ResolvedNotepadCommentThread {
  return {
    comment: {
      id,
      notepadId: "np-1",
      anchor: {
        sectionId: "rollout",
        headingLabel: "Rollout",
        line: 12,
        charStart: 0,
        charEnd: 14,
        quote: overrides.quote ?? "ship on Friday",
        prefix: "",
        suffix: "",
        notepadRevision: 3,
      },
      body: overrides.body ?? "deploys are frozen on Friday",
      status,
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z",
      resolvedAt: status === "resolved" ? "2026-03-03T01:00:00.000Z" : null,
    },
    replies: [],
    passage: {
      quote: overrides.quote ?? "ship on Friday",
      location: overrides.location ?? "§ Rollout · L12",
      state: overrides.state ?? "anchored",
    },
  };
}

const TARGET: DocumentFeedbackTarget = {
  projectName: "proj",
  projectPath: "/proj",
  sessionName: "sess",
  conversationId: "conv-1",
  backend: "claude",
  status: "awaiting",
};

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

describe("buildNotepadFeedbackPayload", () => {
  it("dispatches only open comments", () => {
    const payload = buildNotepadFeedbackPayload(NOTEPAD, [
      thread("c-open", "open"),
      thread("c-done", "resolved"),
    ]);
    expect(payload?.items.map((i) => i.commentId)).toEqual(["c-open"]);
  });

  it("carries the notepad reference with its read command", () => {
    const payload = buildNotepadFeedbackPayload(NOTEPAD, [
      thread("c-1", "open"),
    ]);
    expect(payload?.notepadRefXml).toContain('notepad-id="np-1"');
    expect(payload?.notepadRefXml).toContain("cctl notepad get ");
  });

  it("marks a stale anchor rather than presenting it as a live location", () => {
    const payload = buildNotepadFeedbackPayload(NOTEPAD, [
      thread("c-1", "open", { state: "stale" }),
    ]);
    expect(payload?.items[0]!.location).toContain("§ Rollout · L12");
    expect(payload?.items[0]!.location).toContain("stale");
  });

  it("returns null when nothing is open to dispatch", () => {
    expect(buildNotepadFeedbackPayload(NOTEPAD, [])).toBeNull();
    expect(
      buildNotepadFeedbackPayload(NOTEPAD, [thread("c-done", "resolved")]),
    ).toBeNull();
  });
});

describe("deliverNotepadFeedback", () => {
  const payload = buildNotepadFeedbackPayload(NOTEPAD, [
    thread("c-1", "open"),
  ])!;

  it("sends to the prompt route with the derived prose when the target is not running", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse()) as DispatchFetch &
      ReturnType<typeof vi.fn>;
    const outcome = await deliverNotepadFeedback({
      payload,
      target: TARGET,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true });
    const [url, , options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "/api/projects/proj/sessions/sess/conversations/conv-1/prompt",
    );
    const body = JSON.parse(String(options.body)) as {
      prompt: string;
      notepadFeedback: { notepadId: string };
    };
    expect(body.notepadFeedback.notepadId).toBe("np-1");
    expect(body.prompt).toContain("deploys are frozen on Friday");
    expect(body.prompt).toContain(payload.notepadRefXml);
  });

  it("queues without hand-authored text when the target is running", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse()) as DispatchFetch &
      ReturnType<typeof vi.fn>;
    await deliverNotepadFeedback({
      payload,
      target: { ...TARGET, status: "running" },
      fetchImpl,
    });

    const [url, , options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "/api/projects/proj/sessions/sess/conversations/conv-1/queue",
    );
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    expect(body).toEqual({ notepadFeedback: payload });
  });

  it("falls back to the queue when the target turned busy between render and submit", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "CONVERSATION_BUSY" }), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(okResponse()) as DispatchFetch &
      ReturnType<typeof vi.fn>;

    const outcome = await deliverNotepadFeedback({
      payload,
      target: TARGET,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true });
    expect(fetchImpl.mock.calls[1]![0]).toContain("/queue");
  });

  it("reports the server's message when delivery fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "conversation archived" }), {
        status: 400,
      }),
    ) as DispatchFetch & ReturnType<typeof vi.fn>;

    expect(
      await deliverNotepadFeedback({ payload, target: TARGET, fetchImpl }),
    ).toEqual({ ok: false, message: "conversation archived" });
  });
});
