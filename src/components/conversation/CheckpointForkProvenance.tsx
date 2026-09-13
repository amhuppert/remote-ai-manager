"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { CheckpointForkOrigin } from "@/lib/conversation-checkpoints/fork-schemas";
import { useCheckpointOperation } from "@/lib/conversation-checkpoints/queries";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import CheckpointPanel from "./CheckpointPanel";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import type { ConversationCheckpointSurface } from "./use-conversation-checkpoint";
import { useConversationCheckpoint } from "./use-conversation-checkpoint";

export function sourceCheckpointSurface(
  surface: ConversationCheckpointSurface,
  receipt: CheckpointReceipt | null,
): ConversationCheckpointSurface {
  return {
    ...surface,
    recent: receipt
      ? [
          receipt,
          ...surface.recent.filter(
            (item) => item.operationId !== receipt.operationId,
          ),
        ].sort((a, b) => b.ordinal - a.ordinal)
      : surface.recent,
  };
}

function SourceCheckpoint({
  origin,
  onClose,
}: {
  origin: CheckpointForkOrigin;
  onClose(): void;
}) {
  const surface = useConversationCheckpoint(origin.source);
  const selected = useCheckpointOperation(
    origin.source,
    origin.sourceOperationId,
  );
  const receipt = selected.data?.receipt;
  return (
    <CheckpointPanel
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      initialOperationId={origin.sourceOperationId}
      surface={{
        ...sourceCheckpointSurface(surface, receipt ?? null),
        isLoading: selected.isPending,
        requestError: selected.error
          ? "Original checkpoint is unavailable. The fork retains its own saved handoff."
          : surface.requestError,
      }}
    />
  );
}

export default function CheckpointForkProvenance({
  origin,
}: {
  origin: CheckpointForkOrigin;
}) {
  const [open, setOpen] = useState(false);
  const delivery = useCheckpointOperation(
    { ...origin.source, conversationId: origin.operationId },
    origin.operationId,
  );
  const receipt = delivery.data?.receipt;
  const deliveryLabel =
    receipt?.phase === "needs_reconciliation"
      ? "Delivery needs review"
      : receipt?.acceptance
        ? "Accepted"
        : receipt?.phase === "ready"
          ? origin.submission
            ? "Waiting for first message acceptance"
            : "Ready for first message"
          : receipt?.phase === "delivering"
            ? "Sending first message"
            : delivery.isError
              ? "Delivery status unavailable"
              : "Reading delivery status…";
  const sourceHref =
    origin.source.scope === "session"
      ? conversationsPageHref({ conversationId: origin.source.conversationId })
      : `/projects/${encodeURIComponent(origin.source.projectName)}?focus=${encodeURIComponent(origin.source.conversationId)}`;
  const work = origin.relatedWork;
  const label =
    work.kind === "ticket"
      ? `${origin.source.projectName}#${work.ticketNumber}`
      : work.kind === "spec_task"
        ? "Spec task"
        : "Workflow assignment";
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-base px-lg py-sm font-mono text-[0.72rem] text-text-secondary"
      data-checkpoint-fork-provenance=""
    >
      <span>Forked from checkpoint #{origin.ordinal}</span>
      <a
        href={sourceHref}
        className="text-cyan underline decoration-cyan-dim underline-offset-2"
      >
        Source conversation
      </a>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Source checkpoint &amp; evidence
      </Button>
      <span role="status">{deliveryLabel}</span>
      {work.kind === "ticket" ? (
        <span>{label}</span>
      ) : (
        <details className="min-w-0">
          <summary>{label}</summary>
          <p className="break-all">
            {work.kind === "spec_task"
              ? `Spec ${work.specId} · task ${work.elementId} · revision ${work.revisionId}`
              : `Execution ${work.executionId} · ${work.owner.kind === "context" || work.owner.kind === "loop_template" ? work.owner.contextId : "workflow"} · ${work.useSite} · assignment ${work.assignmentId}`}
          </p>
        </details>
      )}
      {!origin.submission && !receipt?.acceptance && (
        <span className="text-amber">
          Draft · Agent editable until first message
        </span>
      )}
      {open && (
        <SourceCheckpoint origin={origin} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
