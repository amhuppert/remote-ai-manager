"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createClientLogger } from "@/lib/logging/client-logger";
import { tracedFetch } from "@/lib/shared/traced-fetch";
import { formatDocumentFeedbackPrompt } from "@/lib/document-comments/format-feedback";
import { ApiCallError } from "@/lib/api/errors";
import { mutationFetch } from "@/lib/api/fetcher";
import { documentCommentKeys } from "@/lib/document-comments/query-keys";
import { documentCommentSchema } from "@/lib/document-comments/schemas";
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
   * comment is deleted when possible and otherwise marked sent. Returns whether
   * delivery was accepted, independently of cleanup. A delivery failure leaves
   * comments pending; cleanup errors report that feedback was already sent.
   */
  sendFeedback: (comments: readonly DocumentComment[]) => Promise<boolean>;
  isSending: boolean;
  error: string | null;
  clearError: () => void;
}

/** Once delivery is accepted, a cleanup failure must never roll it back to pending. */
async function retireDeliveredComments(
  docRef: DocumentRef,
  comments: readonly DocumentComment[],
  queryClient: QueryClient,
): Promise<boolean> {
  const listKey = documentCommentKeys.list(
    docRef.projectName,
    docRef.sessionName,
    docRef.docPath,
  );
  await queryClient.cancelQueries({ queryKey: listKey });
  const ids = new Set(comments.map(({ id }) => id));
  const sentAt = new Date().toISOString();
  queryClient.setQueryData<DocumentComment[]>(listKey, (old) =>
    old?.map((comment) =>
      ids.has(comment.id)
        ? { ...comment, status: "sent", sentAt: comment.sentAt ?? sentAt }
        : comment,
    ),
  );

  const results = await Promise.allSettled(
    comments.map(async (comment) => {
      const url = `/api/projects/${enc(docRef.projectName)}/sessions/${enc(docRef.sessionName)}/document-comments/${enc(comment.id)}`;
      try {
        await mutationFetch(url, "delete-document-comment", {
          method: "DELETE",
        });
      } catch (error) {
        if (!(error instanceof ApiCallError && error.status === 404)) {
          // Preserve the accepted state durably when removal is unavailable.
          await mutationFetch(
            url,
            "update-document-comment",
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "sent" }),
            },
            documentCommentSchema,
          );
          return;
        }
      }
      queryClient.setQueryData<DocumentComment[]>(listKey, (old) =>
        old?.filter(({ id }) => id !== comment.id),
      );
    }),
  );
  const persisted = results.every(({ status }) => status === "fulfilled");
  if (persisted) void queryClient.invalidateQueries({ queryKey: listKey });
  return persisted;
}

function feedbackVersion(comment: DocumentComment): string {
  return JSON.stringify([comment.note, comment.anchor]);
}

export function useSendDocumentFeedback({
  docRef,
  target,
}: UseSendDocumentFeedbackArgs): UseSendDocumentFeedbackResult {
  const queryClient = useQueryClient();
  const sendingRef = useRef(false);
  const acceptedVersions = useRef(new Map<string, string>());
  const [isSending, setIsSending] = useState(false);
  const errorScope = JSON.stringify([
    docRef?.projectName,
    docRef?.sessionName,
    docRef?.docPath,
    target?.projectName,
    target?.sessionName,
    target?.conversationId,
  ]);
  const [failure, setFailure] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const error = failure?.scope === errorScope ? failure.message : null;
  const setError = useCallback(
    (message: string | null) => {
      setFailure(message === null ? null : { scope: errorScope, message });
    },
    [errorScope],
  );

  const sendFeedback = useCallback(
    async (comments: readonly DocumentComment[]): Promise<boolean> => {
      if (
        !docRef ||
        comments.length === 0 ||
        sendingRef.current ||
        comments.some(({ id }) => id.startsWith("optimistic-"))
      )
        return false;

      sendingRef.current = true;
      setIsSending(true);
      setError(null);
      let accepted = false;
      try {
        const unsent = comments.filter(
          (comment) =>
            comment.status === "pending" &&
            acceptedVersions.current.get(comment.id) !==
              feedbackVersion(comment),
        );
        if (unsent.length > 0) {
          const items = buildFeedbackItems(unsent);
          const outcome = await deliverFeedback({
            docRef,
            target,
            text: formatDocumentFeedbackPrompt(items),
            payload: { items },
            fetchImpl: tracedFetch,
          });
          if (!outcome.ok) {
            logger.warn("document-feedback.send_failed", {
              docPath: docRef.docPath,
              conversationId: target?.conversationId ?? null,
              count: unsent.length,
              error: outcome.message,
            });
            setError(outcome.message);
            return false;
          }
          for (const comment of unsent) {
            acceptedVersions.current.set(comment.id, feedbackVersion(comment));
          }
          logger.info("document-feedback.sent", {
            docPath: docRef.docPath,
            conversationId: target?.conversationId ?? null,
            count: unsent.length,
            queued: target?.status === "running",
            newConversation: target === null,
          });
        }
        accepted = true;

        const persisted = await retireDeliveredComments(
          docRef,
          comments,
          queryClient,
        );
        if (!persisted) {
          logger.warn("document-feedback.cleanup_failed", {
            docPath: docRef.docPath,
            count: comments.length,
          });
          setError(
            "Feedback sent, but comments could not be cleared. Do not resend them after reloading.",
          );
        }
        return true;
      } catch (error) {
        setError(
          accepted
            ? "Feedback sent, but comments could not be cleared. Do not resend them after reloading."
            : error instanceof Error
              ? error.message
              : "Failed to send feedback",
        );
        return accepted;
      } finally {
        sendingRef.current = false;
        setIsSending(false);
      }
    },
    [docRef, target, queryClient, setError],
  );

  const clearError = useCallback(() => setFailure(null), []);

  return { sendFeedback, isSending, error, clearError };
}
