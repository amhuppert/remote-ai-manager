import { StatusChip } from "@/components/ui/StatusChip";
import type { McpServerCompatibilityView } from "@/lib/mcp/schemas";

import { backendLabel } from "@/lib/agent-backends/catalog";

export function McpTransportCompatibility({
  compatibility,
}: {
  compatibility?: McpServerCompatibilityView;
}): React.JSX.Element | null {
  if (!compatibility) return null;
  return (
    <div className="flex flex-wrap items-center gap-sm py-sm">
      <span className="font-mono text-[0.7rem] text-text-tertiary">
        Transport support
      </span>
      {compatibility.backends.map(({ backend, supported, reason }) => (
        <StatusChip
          key={backend}
          tone={supported ? "neutral" : "amber"}
          title={reason}
        >
          {backendLabel(backend)} · {supported ? "supported" : "unavailable"}
        </StatusChip>
      ))}
    </div>
  );
}
