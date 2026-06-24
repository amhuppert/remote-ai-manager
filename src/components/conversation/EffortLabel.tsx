import { cn } from "@/lib/ui/cn";

export interface EffortLabelProps {
  /** Reasoning effort level for the turn (e.g. "high", "xhigh", "max"). */
  effort: string;
  /** Layout-only utilities (margin / placement); appended after the tone class. */
  layoutClassName?: string;
}

// The reasoning-effort label shown in the conversation panel's message metadata
// row. The "max"/"xhigh" tiers exceed the normal scale and render as animated
// rainbow gradient text (the `cc-rainbow-text` treatment in conversation.css);
// every other tier renders as plain secondary text.
export function EffortLabel({
  effort,
  layoutClassName,
}: EffortLabelProps): React.JSX.Element {
  const isRainbow = effort === "max" || effort === "xhigh";
  return (
    <span
      className={cn(
        isRainbow ? "cc-rainbow-text" : "text-text-secondary",
        layoutClassName,
      )}
    >
      {effort}
    </span>
  );
}
