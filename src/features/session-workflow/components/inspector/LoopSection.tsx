"use client";

import { StatusChip } from "@/components/ui/StatusChip";
import type { ContextLoopDisplay } from "@/components/workflow-graph/derive-graph";
import { ControlFlowChip, GroupHeader, inspectorSectionClass } from "./chrome";
import { LoopIcon } from "./icons";

/**
 * Tasks tab → Loop (§11): this context's own place in its loop group. The full
 * ledger across every looped context lives in Overview → Loop ledger.
 */
export default function LoopSection({
  loop,
}: {
  loop: ContextLoopDisplay | null;
}): React.JSX.Element | null {
  if (!loop) return null;
  return (
    <section className={inspectorSectionClass} data-testid="context-loop">
      <GroupHeader label="Loop" meta={loop.loopGroupId} />
      <div className="flex flex-wrap items-center gap-[6px] text-[0.72rem] text-text-secondary">
        <ControlFlowChip icon={<LoopIcon size={10} />}>
          Pass {loop.pass} of {loop.maxPasses}
        </ControlFlowChip>
        <StatusChip tone={loop.activation === "running" ? "cyan" : "neutral"}>
          {loop.activation}
        </StatusChip>
        {loop.templateVersion !== null && (
          <StatusChip tone="neutral">
            template v{loop.templateVersion}
          </StatusChip>
        )}
      </div>
      <div className="mt-1 font-mono text-[0.7rem] text-text-tertiary">
        cloned from {loop.authoredContextId}
      </div>
    </section>
  );
}
