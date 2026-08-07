"use client";

import { useMemo } from "react";
import { SectionLabel } from "@/components/ui/SectionHeader";
import { deriveLoopLedger } from "@/lib/workflow-graph/loop-ledger";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  orderGraphWorkflowEventPages,
  useGraphWorkflowEventPagesQuery,
} from "@/lib/workflows/queries";

const rowClass = "py-2 border-b border-border-dim last:border-b-0";
const headerClass = "flex items-center gap-[8px] text-[0.72rem]";
const detailClass = "text-[0.7rem] text-text-tertiary mt-1 leading-[1.4]";
const metaClass = "text-[0.7rem] text-text-tertiary";
const supersededClass =
  "text-[0.65rem] uppercase tracking-[0.06em] text-text-tertiary border border-border-dim rounded-sm px-[6px] py-[1px]";
const loadMoreClass =
  "mt-2 inline-flex items-center justify-center text-[0.7rem] py-[3px] px-[8px] h-[22px] rounded-sm cursor-pointer border border-border-default bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:text-text-primary";

export interface LoopLedgerPanelProps {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
}

/**
 * The inspector's loop ledger (D4 R16.2).
 *
 * Current state comes from the execution blob's loop markers; the decision
 * HISTORY comes from the shared cursor-paginated event reader, because a pass
 * re-decided under an amended control revision overwrites its marker and
 * survives only in the log. Both halves go through `deriveLoopLedger`, the same
 * projection the CLI ledger renders, so the two surfaces cannot disagree.
 *
 * Renders nothing at all for a loop-free execution — which is every pre-D4 run —
 * and does not fetch for one either.
 */
export default function LoopLedgerPanel({
  projectName,
  sessionName,
  execution,
}: LoopLedgerPanelProps) {
  const loopGroups = useMemo(
    () => execution.workingDefinition.loopGroups ?? [],
    [execution.workingDefinition.loopGroups],
  );
  const hasLoops = loopGroups.length > 0;

  const pagesQuery = useGraphWorkflowEventPagesQuery(
    projectName,
    sessionName,
    execution.id,
    { enabled: hasLoops },
  );

  const entries = useMemo(
    () =>
      deriveLoopLedger({
        loopStates: execution.loopStates,
        events: orderGraphWorkflowEventPages(pagesQuery.data?.pages),
        loopGroups,
      }),
    [execution.loopStates, loopGroups, pagesQuery.data?.pages],
  );

  if (!hasLoops || entries.length === 0) return null;

  return (
    <section data-testid="loop-ledger">
      <SectionLabel>Loop ledger</SectionLabel>
      {entries.map((entry) => (
        <div key={entry.loopGroupId} className="mb-lg">
          <div className={headerClass}>
            <span className="font-semibold text-text-primary">
              {entry.loopGroupId}
            </span>
            <span className={metaClass}>
              {entry.activation} · pass {entry.passCount}
              {entry.maxPasses === null ? "" : ` of ${entry.maxPasses}`} ·
              control revision {entry.loopControlRevision}
            </span>
          </div>
          {entry.decisions.length === 0 ? (
            <p className={detailClass}>No pass has been decided yet.</p>
          ) : (
            entry.decisions.map((decision, index) => (
              <div
                key={`${decision.pass}-${decision.loopControlRevision}-${index}`}
                className={rowClass}
                data-testid="loop-ledger-decision"
              >
                <div className={headerClass}>
                  <span className="min-w-0 flex-1 text-text-secondary">
                    {`Pass ${decision.pass} · ${decision.verdict} → ${decision.outcome}`}
                  </span>
                  {decision.latest ? null : (
                    <span className={supersededClass}>superseded</span>
                  )}
                </div>
                <div className={detailClass}>
                  {`${decision.exitContextId} · control revision ${decision.loopControlRevision}, template v${decision.templateVersion}`}
                  {decision.markerOnly ? " · from current state" : ""}
                </div>
              </div>
            ))
          )}
        </div>
      ))}
      {pagesQuery.hasNextPage ? (
        <button
          type="button"
          className={loadMoreClass}
          onClick={() => void pagesQuery.fetchNextPage()}
          disabled={pagesQuery.isFetchingNextPage}
        >
          {pagesQuery.isFetchingNextPage ? "Loading…" : "Load older decisions"}
        </button>
      ) : null}
    </section>
  );
}
