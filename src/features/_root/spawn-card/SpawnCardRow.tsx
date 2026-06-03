import type { ProposedSession } from "@/lib/chat-spawning/schemas";

function agentLabel(agent: ProposedSession["agent"]): string {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  return "Claude + Codex";
}

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
    <div className="spawn-card-row">
      <span className="spawn-card-row__name">{proposed.name}</span>
      <span className="spawn-card-row__branch">
        <span className="spawn-card-row__branch-name">{proposed.branch}</span>
        <span className="spawn-card-row__arrow" aria-hidden>
          →
        </span>
        <span className="spawn-card-row__target">{proposed.target}</span>
      </span>
      <span
        className="cc-badge cc-badge--type spawn-card-row__agent"
        data-backend={agentBadgeBackend}
      >
        {agentLabel(proposed.agent)}
      </span>
      <span className="cc-badge cc-badge--count spawn-card-row__mode">
        {proposed.mode}
      </span>
    </div>
  );
}
