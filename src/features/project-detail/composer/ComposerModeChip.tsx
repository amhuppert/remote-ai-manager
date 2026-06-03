import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ComposerMode } from "./detect-composer-mode";

export interface ComposerModeChipProps {
  mode: ComposerMode;
  /** Selected agent — drives the chat-mode label and color (cyan/violet). */
  agent: AgentBackendId;
}

const AGENT_LABEL: Record<AgentBackendId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Left-anchored mode indicator for the unified composer. It recolors the field
 * by routing mode and agent identity via `data-mode` / `data-agent` (the CSS
 * owns the color): chat → `› <agent>` (cyan Claude / violet Codex), command →
 * `/` (violet), filter → `⊟` (amber).
 */
export default function ComposerModeChip({
  mode,
  agent,
}: ComposerModeChipProps): React.JSX.Element {
  const { glyph, label, aria } = describe(mode, agent);
  return (
    <span
      className="plc-mode-chip"
      data-mode={mode}
      data-agent={agent}
      aria-label={aria}
    >
      <span className="plc-mode-chip-glyph" aria-hidden="true">
        {glyph}
      </span>
      {label && <span className="plc-mode-chip-label">{label}</span>}
    </span>
  );
}

function describe(
  mode: ComposerMode,
  agent: AgentBackendId,
): { glyph: string; label: string | null; aria: string } {
  if (mode === "command") {
    return { glyph: "/", label: null, aria: "Command mode" };
  }
  if (mode === "filter") {
    return { glyph: "⊟", label: null, aria: "Filter mode" };
  }
  const name = AGENT_LABEL[agent];
  return { glyph: "›", label: name, aria: `Chat mode — ${name}` };
}
