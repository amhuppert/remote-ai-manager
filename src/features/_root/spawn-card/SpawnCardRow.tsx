import type { ProposedSession } from "@/lib/chat-spawning/schemas";
import { Badge } from "@/components/ui/Badge";

function agentLabel(agent: ProposedSession["agent"]): string {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  return "Claude + Codex";
}

// Uppercase, letter-spaced mode chip. The Badge primitive owns no
// text-transform/letter-spacing, so styling it as a Badge plus those utilities
// would put two styling systems on one element; it stays a single-owner utility
// chip instead.
const MODE_CHIP_CLASS =
  "ml-xs inline-flex items-center justify-center font-mono text-[0.7rem] font-semibold px-[8px] py-[2px] rounded-full whitespace-nowrap leading-[1.3] bg-bg-raised text-text-secondary uppercase tracking-[0.04em]";

/**
 * One proposed-session row: name, `branch → target`, agent badge, and mode.
 * Read-only — edits happen through SpawnCardEditForm.
 */
export default function SpawnCardRow({
  proposed,
}: {
  proposed: ProposedSession;
}): React.JSX.Element {
  const agentBadgeBackend = proposed.agent === "codex" ? "codex" : "claude";
  return (
    <div className="flex items-center gap-md px-md py-sm bg-bg-base border border-solid border-border-dim rounded-md">
      <span className="font-medium text-text-primary">{proposed.name}</span>
      <span className="inline-flex items-center gap-xs text-text-secondary text-[0.75rem]">
        <span>{proposed.branch}</span>
        <span className="text-text-tertiary" aria-hidden>
          →
        </span>
        <span>{proposed.target}</span>
      </span>
      <Badge backend={agentBadgeBackend} layoutClassName="ml-auto">
        {agentLabel(proposed.agent)}
      </Badge>
      <span className={MODE_CHIP_CLASS}>{proposed.mode}</span>
    </div>
  );
}
