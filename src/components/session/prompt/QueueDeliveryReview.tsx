"use client";

import { Button } from "@/components/ui/Button";
import {
  queuedMessageNeedsReview,
  type PendingQueuedMessage,
  type QueueReviewAction,
} from "@/lib/conversations/message-queue-schemas";

/** Retained input stays readable while the user decides whether to repeat it. */
export function QueueDeliveryReview({
  entries,
  disabled = false,
  pendingId,
  error,
  onResolve,
}: {
  entries: readonly PendingQueuedMessage[];
  disabled?: boolean;
  pendingId?: string;
  error?: string;
  onResolve(id: string, action: QueueReviewAction): void;
}) {
  const retained = entries.filter((entry) =>
    queuedMessageNeedsReview(entry.status),
  );
  if (retained.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Queued deliveries needing review"
      className="mb-sm flex flex-col gap-sm rounded-md border border-solid border-border-default bg-bg-surface p-sm font-mono text-[0.78rem] text-text-primary"
    >
      <p className="text-amber">Queue paused for delivery review</p>
      <p className="text-text-secondary">
        Review every retained message to resume delivery. Retry may repeat work
        if the agent already received it. Discard removes the queued copy; it
        does not undo work.
      </p>
      {retained.map((entry) => (
        <div
          key={entry.id}
          className="flex flex-col gap-xs"
          data-status={entry.status}
        >
          <p className="whitespace-pre-wrap break-words">
            {entry.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n") || "Queued attachment or feedback"}
          </p>
          {entry.content.some((block) => block.type === "image") ? (
            <p className="text-text-secondary">
              Images retained with this message
            </p>
          ) : null}
          <p className="text-text-secondary">
            {entry.status === "uncertain"
              ? "Delivery uncertain"
              : "Delivery failed"}
            {entry.error ? `: ${entry.error}` : ""}
          </p>
          <div className="flex flex-wrap gap-sm">
            <Button
              size="sm"
              touch
              disabled={disabled || pendingId !== undefined}
              loading={pendingId === entry.id}
              onClick={() => onResolve(entry.id, "retry")}
              aria-label="Retry delivery"
            >
              Retry
            </Button>
            <Button
              size="sm"
              touch
              variant="danger"
              disabled={disabled || pendingId !== undefined}
              onClick={() => onResolve(entry.id, "discard")}
              aria-label="Discard queued message"
            >
              Discard
            </Button>
          </div>
        </div>
      ))}
      {disabled ? (
        <p className="text-text-secondary">
          Delivery review is available after the active turn stops.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
