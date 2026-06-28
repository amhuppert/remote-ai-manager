"use client";

import { useCallback, useState } from "react";
import { createClientLogger } from "@/lib/logging/client-logger";
import { tracedFetch } from "@/lib/shared/traced-fetch";
import { formatDocumentFeedbackPrompt } from "@/lib/document-comments/format-feedback";
import { useDeleteDocumentCommentMutation } from "@/lib/document-comments/mutations";
import type {
  DocumentComment,
  DocumentFeedbackItem,
  DocumentFeedbackPayload,
  DocumentFeedbackTarget,
  DocumentRef,
} from "@/lib/document-comments/schemas";

const logger = createClientLogger("document-feedback-send");

/**
 * Map comments to the feedback items delivered to the agent. Each item carries
 * the exact quote and its source reference — path, heading label, and line —
 * plus the user's note (Requirement 8.1). `path` is the human-facing path
 * embedded in the prompt text; `docPath` is the identity used to open the doc.
 */
export function buildFeedbackItems(
  comments: readonly DocumentComment[],
): DocumentFeedbackItem[] {
  return comments.map((c) => ({
    docPath: c.docPath,
    path: c.docPath,
    headingLabel: c.anchor.headingLabel,
    line: c.anchor.line,
    quote: c.anchor.quote,
    note: c.note,
  }));
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

function sessionPromptUrl(projectName: string, sessionName: string): string {
  return `/api/projects/${enc(projectName)}/sessions/${enc(sessionName)}/prompt`;
}

type PostResult =
  | { ok: true }
  | { ok: false; status: number; code?: string; message: string };

export interface FeedbackFetch {
  (url: string, action: string, options: RequestInit): Promise<Response>;
}

/**
 * POST a feedback body and resolve once the request is accepted. The prompt
 * endpoints stream the agent turn as SSE; we do NOT consume that stream — the
 * target conversation reconciles through its own SSE/query invalidation, and the
 * server continues the turn in the background after we release the connection.
 * Acceptance (`res.ok`) is the send/queue success boundary; failures carry the
 * status + error code so the caller can apply the immediate→queue race fallback.
 */
async function postFeedback(
  url: string,
  body: unknown,
  action: string,
  fetchImpl: FeedbackFetch,
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

export interface DeliverFeedbackArgs {
  docRef: DocumentRef;
  target: DocumentFeedbackTarget | null;
  text: string;
  payload: DocumentFeedbackPayload;
  fetchImpl: FeedbackFetch;
}

export type DeliverFeedbackOutcome =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Route a feedback submission to the chosen target's own endpoints. This is
 * deliberately NOT `useSendPrompt` — that hook mutates the mounted conversation's
 * optimistic store and gates its queue on the mounted `sending` flag, both of
 * which would misroute a cross-target send. Routing:
 * - no target (9.5): start a new conversation in the document's own session;
 * - running target (8.4): queue;
 * - otherwise: send immediately, with an immediate→queue race fallback when the
 *   target turned running between picker render and submit (409 CONVERSATION_BUSY).
 */
export async function deliverFeedback({
  docRef,
  target,
  text,
  payload,
  fetchImpl,
}: DeliverFeedbackArgs): Promise<DeliverFeedbackOutcome> {
  // `documentFeedback` is threaded for the structured transcript-card path
  // (group 7 extends the prompt/queue schemas to consume it); until then it is
  // harmlessly stripped at the boundary while `prompt`/`text` carry the full
  // human-readable feedback (8.1).
  const promptBody = { prompt: text, documentFeedback: payload };
  const queueBody = { text, documentFeedback: payload };

  if (!target) {
    const result = await postFeedback(
      sessionPromptUrl(docRef.projectName, docRef.sessionName),
      promptBody,
      "send-document-feedback",
      fetchImpl,
    );
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  if (target.status === "running") {
    const result = await postFeedback(
      conversationQueueUrl(target),
      queueBody,
      "queue-document-feedback",
      fetchImpl,
    );
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  const immediate = await postFeedback(
    conversationPromptUrl(target),
    promptBody,
    "send-document-feedback",
    fetchImpl,
  );
  if (immediate.ok) return { ok: true };

  if (immediate.status === 409 && immediate.code === "CONVERSATION_BUSY") {
    logger.info("document-feedback.race_fallback_to_queue", {
      conversationId: target.conversationId,
    });
    const queued = await postFeedback(
      conversationQueueUrl(target),
      queueBody,
      "queue-document-feedback",
      fetchImpl,
    );
    return queued.ok ? { ok: true } : { ok: false, message: queued.message };
  }

  return { ok: false, message: immediate.message };
}

export interface UseSendDocumentFeedbackArgs {
  docRef: DocumentRef | null;
  target: DocumentFeedbackTarget | null;
}

export interface UseSendDocumentFeedbackResult {
  /**
   * Deliver the given comments as ONE feedback submission to the chosen target
   * (or a new conversation when none) and remove them on success — once sent, a
   * comment's in-document indicator and highlight are no longer useful, so the
   * comment is deleted rather than kept as a "sent" marker. Returns whether
   * delivery succeeded; on failure the comments stay pending and the error is
   * surfaced via `error` (8.5).
   */
  sendFeedback: (comments: readonly DocumentComment[]) => Promise<boolean>;
  isSending: boolean;
  error: string | null;
  clearError: () => void;
}

export function useSendDocumentFeedback({
  docRef,
  target,
}: UseSendDocumentFeedbackArgs): UseSendDocumentFeedbackResult {
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Comments are document-scoped, so removing them after a send uses the
  // DOCUMENT's own project/session/docPath (not the target conversation's scope).
  const deleteComment = useDeleteDocumentCommentMutation(
    docRef?.projectName ?? "",
    docRef?.sessionName ?? "",
    docRef?.docPath ?? "",
  );

  const sendFeedback = useCallback(
    async (comments: readonly DocumentComment[]): Promise<boolean> => {
      if (!docRef || comments.length === 0) return false;

      const items = buildFeedbackItems(comments);
      const payload: DocumentFeedbackPayload = { items };
      const text = formatDocumentFeedbackPrompt(items);

      setIsSending(true);
      setError(null);
      try {
        const outcome = await deliverFeedback({
          docRef,
          target,
          text,
          payload,
          fetchImpl: tracedFetch,
        });
        if (!outcome.ok) {
          logger.warn("document-feedback.send_failed", {
            docPath: docRef.docPath,
            conversationId: target?.conversationId ?? null,
            count: comments.length,
            error: outcome.message,
          });
          setError(outcome.message);
          return false;
        }

        await Promise.all(comments.map((c) => deleteComment.mutateAsync(c.id)));
        logger.info("document-feedback.sent", {
          docPath: docRef.docPath,
          conversationId: target?.conversationId ?? null,
          count: comments.length,
          queued: target?.status === "running",
          newConversation: target === null,
        });
        return true;
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Failed to send feedback";
        setError(message);
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [docRef, target, deleteComment],
  );

  const clearError = useCallback(() => setError(null), []);

  return { sendFeedback, isSending, error, clearError };
}
