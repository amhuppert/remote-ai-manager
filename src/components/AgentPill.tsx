import type { AgentBackendId } from "@/lib/shared/schemas";

interface AgentPillProps {
  backend: AgentBackendId;
  size?: "sm" | "md";
}

export default function AgentPill({
  backend,
  size = "md",
}: AgentPillProps): React.JSX.Element {
  const className = size === "sm" ? "agent-pill agent-pill--sm" : "agent-pill";
  return (
    <span className={className} data-agent={backend}>
      <span className="agent-pill-dot" />
      {backend}
    </span>
  );
}
