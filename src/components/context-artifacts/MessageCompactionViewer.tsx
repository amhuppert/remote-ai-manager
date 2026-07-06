"use client";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useContextArtifact } from "@/lib/context-artifacts/queries";
import type { ContextArtifactListItem } from "@/lib/context-artifacts/queries";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import CompactionEnvelopeView from "./CompactionEnvelopeView";

export interface MessageCompactionViewerProps {
  target: ContextArtifactTarget;
  /** The message artifact's list row; the payload is fetched on demand. */
  artifact: ContextArtifactListItem;
  /** Force-regenerate this message's artifact (message artifacts are always-fresh; only force refreshes). */
  onRefresh: () => void;
  /** Visible pending state for the Refresh action (perceived-responsiveness floor). */
  refreshPending: boolean;
  onNavigateToMessage?: (messageIndex: number) => void;
}

/**
 * Collapsible inline panel mounted under a message row (design §12.1): hosts
 * the shared envelope renderer for a complete artifact, the failed-state error,
 * and the force-refresh affordance.
 */
export default function MessageCompactionViewer({
  target,
  artifact,
  onRefresh,
  refreshPending,
  onNavigateToMessage,
}: MessageCompactionViewerProps) {
  const detail = useContextArtifact(target, artifact.id, {
    enabled: artifact.status === "complete",
  });

  return (
    <section
      aria-label="Compacted message"
      className="mt-sm rounded-md border border-solid border-border-subtle bg-bg-surface p-md"
    >
      <header className="mb-sm flex items-center justify-between gap-sm">
        <span className="font-mono text-[0.7rem] font-bold tracking-[0.1em] text-text-tertiary uppercase">
          Compacted message
        </span>
        <Button
          variant="ghost"
          size="sm"
          loading={refreshPending}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </header>

      {artifact.status === "failed" && (
        <div className="rounded-sm border border-solid border-red-dim bg-red-glow px-sm py-xs font-mono text-[0.75rem] text-red">
          {artifact.error ?? "Compaction failed"}
        </div>
      )}

      {artifact.status === "complete" && (
        <>
          {detail.isPending && (
            <div className="flex items-center gap-sm py-sm font-mono text-[0.75rem] text-text-tertiary">
              <Spinner size="sm" tone="inherit" />
              Loading artifact…
            </div>
          )}
          {detail.isError && (
            <div className="rounded-sm border border-solid border-red-dim bg-red-glow px-sm py-xs font-mono text-[0.75rem] text-red">
              Failed to load the artifact
            </div>
          )}
          {detail.data &&
            (detail.data.payload ? (
              <CompactionEnvelopeView
                envelope={detail.data.payload}
                provenance={detail.data}
                onNavigateToMessage={onNavigateToMessage}
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
