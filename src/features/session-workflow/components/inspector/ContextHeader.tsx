"use client";

import { Fragment } from "react";
import { IconButton } from "@/components/ui/IconButton";
import { StatusChip } from "@/components/ui/StatusChip";
import { ChevronLeftIcon } from "@/components/workflow-config-panel/icons";
import { contextNodeStatusTone } from "@/components/workflow-graph/node-presentation";
import { ControlFlowChip } from "./chrome";
import { LoopIcon } from "./icons";
import type { ContextHeaderView } from "./context-header-model";

/**
 * The selected context's header (design E1): back to Overview, the title, the
 * status pill, and the meta line — `ctx_id · lane <name> · <grade>[ paths] ·
 * iteration N · pass N of M`.
 *
 * Presentational: every word comes from `deriveContextHeader`, so what the
 * header says is pinned without a DOM and stays identical to the node's.
 */
export default function ContextHeader({
  view,
  onBack,
  trailing,
}: {
  view: ContextHeaderView;
  onBack: () => void;
  /** Context-scoped controls the host owns, e.g. Reset context. */
  trailing?: React.ReactNode;
}): React.JSX.Element {
  return (
    <header
      data-testid="context-header"
      className="flex shrink-0 flex-col gap-[6px] border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-[10px]"
    >
      <div className="flex items-center gap-sm">
        <IconButton
          variant="square"
          aria-label="Back to overview"
          title="Back to overview"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </IconButton>
        <span className="min-w-0 flex-1 overflow-hidden font-mono text-[0.82rem] font-semibold text-ellipsis whitespace-nowrap text-text-primary">
          {view.title}
        </span>
        <StatusChip tone={contextNodeStatusTone(view.status.key)}>
          {view.status.label}
        </StatusChip>
        {trailing}
      </div>
      <div
        data-testid="context-header-meta"
        className="flex flex-wrap items-center gap-[5px] font-mono text-[0.7rem] text-text-tertiary"
      >
        {view.metaParts.map((part, index) => (
          <Fragment key={part}>
            {index > 0 ? <span aria-hidden="true">·</span> : null}
            <span>{part}</span>
          </Fragment>
        ))}
        {view.loopLabel !== null ? (
          <>
            <span aria-hidden="true">·</span>
            <ControlFlowChip
              icon={<LoopIcon size={10} />}
              testId="context-header-loop"
            >
              {view.loopLabel}
            </ControlFlowChip>
          </>
        ) : null}
      </div>
    </header>
  );
}
