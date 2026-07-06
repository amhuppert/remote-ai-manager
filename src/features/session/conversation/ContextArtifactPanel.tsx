"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
import CompactionEnvelopeView from "@/components/context-artifacts/CompactionEnvelopeView";
import {
  useContextArtifact,
  useContextArtifacts,
} from "@/lib/context-artifacts/queries";
import {
  useCompactMutation,
  useDeleteArtifactMutation,
} from "@/lib/context-artifacts/mutations";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import { useRequestMessageNav } from "@/stores/session-detail.store";

export interface ContextArtifactPanelProps {
  target: ContextArtifactTarget;
  /** Shown as the conversation identity in the header; id when absent. */
  conversationName?: string | null;
  /** Archived conversations stay compactable; the badge flags them (§11.4). */
  archived?: boolean;
}

const surfaceClass =
  "flex min-h-0 flex-1 flex-col gap-[20px] overflow-y-auto rounded-b-lg border border-solid border-border-subtle bg-bg-surface px-[28px] py-xl max-768:px-md max-768:py-md";

const headerLabelClass =
  "font-mono text-[10px] font-bold tracking-[0.16em] text-text-tertiary uppercase";

const errorBoxClass =
  "rounded-sm border border-solid border-red-dim bg-red-glow px-sm py-xs font-mono text-[0.75rem] text-red";

function PendingSkeleton(): React.JSX.Element {
  return (
    <div role="status" className="flex flex-col gap-sm">
      <div className="flex items-center gap-sm font-mono text-[0.75rem] text-text-tertiary">
        <Spinner size="sm" tone="inherit" />
        Compacting…
      </div>
      <div className="h-[10px] w-[75%] rounded-sm bg-bg-raised" />
      <div className="h-[10px] w-[60%] rounded-sm bg-bg-raised" />
      <div className="h-[10px] w-[45%] rounded-sm bg-bg-raised" />
    </div>
  );
}

/**
 * Dense per-conversation artifact browser (design §12.2), mounted as the
 * right-pane "Artifact" tab. Renders the canonical envelope through the shared
 * CompactionEnvelopeView; every anchored item drills through to the transcript
 * via a store-level message-nav request the conversation panel consumes.
 */
export default function ContextArtifactPanel({
  target,
  conversationName,
  archived = false,
}: ContextArtifactPanelProps): React.JSX.Element {
  const listQuery = useContextArtifacts(target);
  const artifact = listQuery.data?.find(
    (row) => row.kind === "conversation_compaction",
  );
  const compact = useCompactMutation(target);
  const deleteArtifact = useDeleteArtifactMutation(target);
  const requestMessageNav = useRequestMessageNav();

  const detail = useContextArtifact(target, artifact?.id ?? "", {
    enabled: artifact?.status === "complete",
  });

  const handleCompact = useCallback(() => {
    compact.mutate({ kind: "conversation_compaction" });
  }, [compact]);

  const outdated = artifact?.outdated === true;
  const handleRefresh = useCallback(() => {
    compact.mutate({
      kind: "conversation_compaction",
      force: outdated || undefined,
    });
  }, [compact, outdated]);

  const artifactId = artifact?.id;
  const handleDelete = useCallback(() => {
    if (artifactId !== undefined) deleteArtifact.mutate(artifactId);
  }, [deleteArtifact, artifactId]);

  const handleNavigateToMessage = useCallback(
    (messageIndex: number) => {
      requestMessageNav(target.conversationId, messageIndex);
    },
    [requestMessageNav, target.conversationId],
  );

  return (
    <section aria-label="Context artifact" className={surfaceClass}>
      <header className="flex shrink-0 items-start justify-between gap-lg">
        <div className="flex min-w-0 flex-col gap-[6px]">
          <span className={headerLabelClass}>Context artifact</span>
          <span className="flex min-w-0 items-center gap-sm">
            <span className="truncate font-display text-[20px] font-semibold tracking-[0.01em] text-text-primary">
              {conversationName ?? target.conversationId}
            </span>
            {archived && (
              <span className="inline-flex shrink-0 items-center rounded-full bg-bg-raised px-[6px] py-px font-mono text-[0.66rem] tracking-[0.05em] text-text-tertiary uppercase">
                archived
              </span>
            )}
          </span>
        </div>
        {artifact?.status === "complete" && (
          <div className="flex shrink-0 items-center gap-xs">
            <Button
              variant="ghost"
              size="sm"
              loading={compact.isPending}
              onClick={handleRefresh}
            >
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={deleteArtifact.isPending}
              onClick={handleDelete}
            >
              Delete
            </Button>
          </div>
        )}
      </header>

      {listQuery.isPending ? (
        <div className="flex items-center gap-sm py-sm font-mono text-[0.75rem] text-text-tertiary">
          <Spinner size="sm" tone="inherit" />
          Loading artifacts…
        </div>
      ) : listQuery.isError ? (
        <div className={errorBoxClass}>Failed to load context artifacts</div>
      ) : !artifact ? (
        <EmptyState layoutClassName="grow">
          <EmptyStateTitle>No context artifact</EmptyStateTitle>
          <EmptyStateDesc>
            Compact this conversation into a source-anchored envelope other
            agents can pull.
          </EmptyStateDesc>
          <Button size="sm" loading={compact.isPending} onClick={handleCompact}>
            Compact conversation
          </Button>
        </EmptyState>
      ) : artifact.status === "pending" ? (
        <PendingSkeleton />
      ) : artifact.status === "failed" ? (
        <div className="flex flex-col items-start gap-sm">
          <div className={errorBoxClass}>
            {artifact.error ?? "Compaction failed"}
          </div>
          <Button size="sm" loading={compact.isPending} onClick={handleCompact}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          {(artifact.stale || artifact.outdated) && (
            <div className="flex items-center gap-[10px] rounded-md border border-solid border-amber-dim bg-amber-glow px-md py-sm">
              <span className="font-mono text-[11.5px] text-amber">
                {artifact.outdated
                  ? "Outdated — the artifact format changed; Refresh regenerates in full."
                  : `Stale — behind ${artifact.staleBehindMessages} messages.`}
              </span>
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                loading={compact.isPending}
                onClick={handleRefresh}
              >
                Refresh
              </Button>
            </div>
          )}
          {detail.isPending && (
            <div className="flex items-center gap-sm py-sm font-mono text-[0.75rem] text-text-tertiary">
              <Spinner size="sm" tone="inherit" />
              Loading artifact…
            </div>
          )}
          {detail.isError && (
            <div className={errorBoxClass}>Failed to load the artifact</div>
          )}
          {detail.data &&
            (detail.data.payload ? (
              <CompactionEnvelopeView
                envelope={detail.data.payload}
                provenance={detail.data}
                onNavigateToMessage={handleNavigateToMessage}
              />
            ) : (
              <div className="py-xs font-mono text-[0.75rem] text-text-tertiary">
                The artifact&apos;s payload is unavailable — refresh to
                regenerate it.
              </div>
            ))}
        </>
      )}
    </section>
  );
}
