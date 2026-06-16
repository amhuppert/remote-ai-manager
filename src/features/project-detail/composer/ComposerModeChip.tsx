import { cn } from "@/lib/ui/cn";
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

const chipBase =
  "inline-flex items-center gap-2xs shrink-0 h-6 px-sm rounded-full border border-solid font-mono text-[0.72rem] font-medium whitespace-nowrap transition-[color,border-color,background] duration-150 ease-[ease]";

type ChipTone = "cyan" | "violet" | "amber";

const toneClass: Record<ChipTone, string> = {
  cyan: "bg-cyan-glow border-cyan-glow text-cyan",
  violet: "bg-violet-glow border-violet-glow text-violet",
  amber: "bg-amber-glow border-amber-glow text-amber",
};

/**
 * Left-anchored mode indicator for the unified composer. It recolors itself by
 * routing mode and agent identity to a tone: chat → `› <agent>` (cyan Claude /
 * violet Codex), command → `/` (violet), filter → `⊟` (amber).
 */
export default function ComposerModeChip({
  mode,
  agent,
}: ComposerModeChipProps): React.JSX.Element {
  const { glyph, label, aria } = describe(mode, agent);
  return (
    <span
      className={cn(chipBase, toneClass[toneFor(mode, agent)])}
      aria-label={aria}
    >
      <span className="font-semibold" aria-hidden="true">
        {glyph}
      </span>
      {label && <span>{label}</span>}
    </span>
  );
}

function toneFor(mode: ComposerMode, agent: AgentBackendId): ChipTone {
  if (mode === "filter") return "amber";
  if (mode === "command") return "violet";
  return agent === "claude" ? "cyan" : "violet";
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
