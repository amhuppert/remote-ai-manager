"use client";

import { createClientLogger } from "@/lib/logging/client-logger";
import { buildNotepadRefXml } from "@/lib/notepads/references";
import { formatNotepadFeedbackPrompt } from "@/lib/notepads/format-feedback";
import type { NotepadFeedbackPayload } from "@/lib/conversations/message-content-schemas";
import type {
  NotepadScope,
  ResolvedNotepadCommentThread,
} from "@/lib/notepads/schemas";
// The conversation routing identity the target picker produces — project,
// project path, session, conversation, backend, status. Reused rather than
// duplicated: it addresses a conversation, and nothing about it is document
// specific (D18 reuses the document-feedback delivery shape).
import type { DocumentFeedbackTarget } from "@/lib/document-comments/schemas";

const logger = createClientLogger("notepad-comment-dispatch");

/** Identity of the notepad being dispatched, as the open panel already knows it. */
export interface DispatchNotepadRef {
  notepadId: string;
  name: string;
  scope: NotepadScope;
  /** The owning project's display name; null for a global notepad. */
  projectName: string | null;
}

/**
 * Build the dispatch payload from a notepad's threads. Only OPEN comments are
 * dispatched — a resolved comment has already been dealt with, and re-sending
 * it would ask the agent to redo settled work. Returns null when there is
 * nothing open to send, so the caller has one answer for "can this dispatch".
 *
 * A comment whose passage no longer resolves is still dispatched, with its
 * location marked stale: what the user said still stands, but the agent must
 * not be told to find text that has since moved on.
 */
export function buildNotepadFeedbackPayload(
  notepad: DispatchNotepadRef,
  threads: readonly ResolvedNotepadCommentThread[],
): NotepadFeedbackPayload | null {
  const items = threads
    .filter(({ comment }) => comment.status === "open")
    .map(({ comment, passage }) => ({
      commentId: comment.id,
      location:
        passage.state === "stale"
          ? `${passage.location} (anchor stale — the notepad changed since)`
          : passage.location,
      quote: passage.quote,
      body: comment.body,
    }));
  if (items.length === 0) return null;

  return {
    notepadId: notepad.notepadId,
    notepadName: notepad.name,
    notepadRefXml: buildNotepadRefXml({
      notepadId: notepad.notepadId,
      name: notepad.name,
      scope: notepad.scope,
      projectName: notepad.projectName,
    }),
    items,
  };
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function conversationPromptUrl(target: DocumentFeedbackTarget): string {
  return `/api/projects/${enc(target.projectName)}/sessions/${enc(target.sessionName)}/conversations/${enc(target.conversationId)}/prompt`;
}

function conversationQueueUrl(target: DocumentFeedbackTarget): string {
  return `/api/projects/${enc(target.projectName)}/sessions/${enc(target.sessionName)}/conversations/${enc(target.conversationId)}/queue`;
}

type PostResult =
  | { ok: true }
  | { ok: false; status: number; code?: string; message: string };

export interface DispatchFetch {
  (url: string, action: string, options: RequestInit): Promise<Response>;
}

/**
 * POST a dispatch body and resolve once the request is accepted. The prompt
 * endpoint streams the turn as SSE; the stream is released rather than consumed
 * — the target conversation reconciles through its own SSE/query invalidation.
 */
async function postDispatch(
  url: string,
  body: unknown,
  action: string,
  fetchImpl: DispatchFetch,
): Promise<PostResult> {
  const res = await fetchImpl(url, action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    void res.body?.cancel().catch(() => {});
    return { ok: true };
  }
  const parsed = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  return {
    ok: false,
    status: res.status,
    code: parsed.code,
    message: parsed.error ?? `Request failed (${res.status})`,
  };
}

export interface DeliverNotepadFeedbackArgs {
  payload: NotepadFeedbackPayload;
  target: DocumentFeedbackTarget;
  fetchImpl: DispatchFetch;
}

export type DeliverNotepadFeedbackOutcome =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Route a dispatch to the chosen conversation's own endpoints: queue while it
 * is running, otherwise send immediately with the same immediate→queue race
 * fallback the document loop uses (the target can turn running between picker
 * render and submit). A notepad has no owning session, so unlike document
 * feedback there is no start-a-new-conversation fallback — the caller must
 * supply a target.
 *
 * The prompt body carries the derived prose as its text; the queue body carries
 * only the payload, because the durable row records the typed block and the
 * delivery re-derives the prose from it.
 */
export async function deliverNotepadFeedback({
  payload,
  target,
  fetchImpl,
}: DeliverNotepadFeedbackArgs): Promise<DeliverNotepadFeedbackOutcome> {
  const queueBody = { notepadFeedback: payload };
  const promptBody = {
    prompt: formatNotepadFeedbackPrompt(payload),
    notepadFeedback: payload,
  };

  if (target.status === "running") {
    const queued = await postDispatch(
      conversationQueueUrl(target),
      queueBody,
      "queue-notepad-feedback",
      fetchImpl,
    );
    return queued.ok ? { ok: true } : { ok: false, message: queued.message };
  }

  const immediate = await postDispatch(
    conversationPromptUrl(target),
    promptBody,
    "send-notepad-feedback",
    fetchImpl,
  );
  if (immediate.ok) return { ok: true };

  if (immediate.status === 409 && immediate.code === "CONVERSATION_BUSY") {
    logger.info("notepad-dispatch.race_fallback_to_queue", {
      conversationId: target.conversationId,
      notepadId: payload.notepadId,
    });
    const queued = await postDispatch(
      conversationQueueUrl(target),
      queueBody,
      "queue-notepad-feedback",
      fetchImpl,
    );
    return queued.ok ? { ok: true } : { ok: false, message: queued.message };
  }

  return { ok: false, message: immediate.message };
}
