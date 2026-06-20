import type { AgentBackendId } from "@/lib/shared/schemas";
import { cn } from "@/lib/ui/cn";

interface AgentPillProps {
  backend: AgentBackendId;
  size?: "sm" | "md";
}

const agentColorClass: Record<AgentBackendId, string> = {
  claude: "bg-cyan-glow text-cyan border border-solid border-cyan-glow-strong",
  codex:
    "bg-violet-glow text-violet border border-solid border-violet-glow-strong",
};

const sizeClass: Record<"sm" | "md", string> = {
  md: "text-[0.68rem] px-[8px] py-[2px] gap-[5px]",
  sm: "text-[0.62rem] px-[6px] py-[1px] gap-[4px]",
};

const dotSizeClass: Record<"sm" | "md", string> = {
  md: "w-[6px] h-[6px]",
  sm: "w-[5px] h-[5px]",
};

// The pill is hidden on mobile (the agent picker in the prompt toolbar is the
// duplicate control); `agent-pill` stays as a semantic hook only.
export default function AgentPill({
  backend,
  size = "md",
}: AgentPillProps): React.JSX.Element {
  return (
    <span
      className={cn(
        "agent-pill inline-flex shrink-0 items-center rounded-full font-mono font-semibold tracking-[0.02em] whitespace-nowrap lowercase max-768:hidden",
        sizeClass[size],
        agentColorClass[backend],
      )}
      data-agent={backend}
    >
      <span
        className={cn(
          "rounded-full bg-current shadow-[0_0_6px_currentColor]",
          dotSizeClass[size],
        )}
      />
      {backend}
    </span>
  );
}
