import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

/** Stable provider-neutral parameter summary for compact read-only surfaces. */
export function modelSelectionParametersLabel(
  selection: BackendModelSelection,
): string {
  return Object.entries(selection.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([parameter, value]) => `${parameter}=${value}`)
    .join(", ");
}
