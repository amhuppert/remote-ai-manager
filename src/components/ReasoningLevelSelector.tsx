"use client";

import type { EffortLevel } from "@/lib/agent-backends/schemas";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/Select";
import { cn } from "@/lib/ui/cn";

export interface EffortOption {
  id: EffortLevel;
  label: string;
  description: string;
}

export const EFFORT_OPTIONS: EffortOption[] = [
  { id: "minimal", label: "Minimal", description: "Least reasoning" },
  { id: "low", label: "Low", description: "Minimal" },
  { id: "medium", label: "Medium", description: "Moderate" },
  { id: "high", label: "High", description: "Default" },
  { id: "xhigh", label: "XHigh", description: "Extra high" },
  { id: "max", label: "Max", description: "Maximum" },
  { id: "ultra", label: "Ultra", description: "Max + parallel agents" },
];

interface ReasoningLevelSelectorProps {
  value: EffortLevel;
  /** Bivariant via method syntax — callers can pass narrower type callbacks */
  onChange(level: EffortLevel): void;
  disabled?: boolean;
  disabledTooltip?: string;
  /** When provided, only these levels are shown in the dropdown. */
  availableLevels?: EffortLevel[];
  /**
   * Reports the dropdown's open-state. The composer-focus hook uses it to hold
   * `composerFocused` true while this portaled popup (rendered outside the
   * composer region) steals focus from the editor.
   */
  onOpenChange?(open: boolean): void;
}

// Base trigger geometry/box, reused by the rainbow variant. The non-rainbow
// trigger uses the canonical `SelectTrigger` (whose recipe matches this box plus
// the cyan open-ring + focus outline).
const TRIGGER_BASE =
  "group flex items-center gap-1.5 h-9 px-3 border border-solid rounded-md font-mono text-[0.72rem] font-medium cursor-pointer whitespace-nowrap transition-all duration-150 ease-[ease] " +
  "bg-bg-surface text-text-secondary border-border-default " +
  "hover:bg-bg-hover hover:border-border-strong hover:text-text-primary " +
  "disabled:opacity-40 disabled:cursor-not-allowed " +
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]";

/**
 * Rainbow-border variant for the max/xhigh effort tiers — a non-canonical
 * "exceeds the scale" signal kept consumer-side (the Select primitive owns no
 * rainbow variant). Reproduces the legacy three-layer padding-box/border-box
 * gradient stack with the animated background shift. The open shadow keys off
 * Radix's `data-state=open` (the trigger is rendered via `SelectTrigger asChild`).
 *
 * The background MUST be expressed as `background-image`/`-size`/`-clip`/`-origin`
 * longhands rather than the `background` shorthand: Tailwind emits the shorthand
 * AFTER the longhands, so it would reset size to `auto` and clip to `border-box`,
 * breaking the 200% scroll animation and the per-layer clipping.
 */
const TRIGGER_RAINBOW = cn(
  "border border-transparent",
  "[background-image:var(--rainbow-tint),linear-gradient(var(--bg-surface),var(--bg-surface)),var(--rainbow-gradient)]",
  "[background-origin:padding-box,padding-box,border-box]",
  "[background-clip:padding-box,padding-box,border-box]",
  "[background-size:200%_auto,100%_100%,200%_auto]",
  "[animation:rainbow-border-shift_3s_linear_infinite]",
  "shadow-[0_0_8px_var(--rainbow-glow),0_0_20px_var(--rainbow-glow-blue)]",
  "hover:shadow-[0_0_12px_var(--rainbow-glow-strong),0_0_24px_var(--cc-rainbow-glow-blue-a15)]",
  "data-[state=open]:shadow-[0_0_0_3px_var(--rainbow-glow),0_0_14px_var(--cc-rainbow-glow-violet-a15)]",
);

// `background-image` longhand (not the `background` shorthand) so Tailwind cannot
// reset `background-clip: text` back to `border-box` — without the clip the
// transparent text fill renders the label invisible instead of rainbow-colored.
const RAINBOW_TEXT_CLIP =
  "[background-image:var(--rainbow-gradient)] [background-size:200%_auto] [-webkit-background-clip:text] [background-clip:text] [-webkit-text-fill-color:transparent] [animation:rainbow-shift_3s_linear_infinite]";

export default function ReasoningLevelSelector({
  value,
  onChange,
  disabled = false,
  disabledTooltip,
  availableLevels,
  onOpenChange,
}: ReasoningLevelSelectorProps): React.JSX.Element {
  const visibleOptions = availableLevels
    ? EFFORT_OPTIONS.filter((o) => availableLevels.includes(o.id))
    : EFFORT_OPTIONS;
  const effortSupported = visibleOptions.length > 0;

  const selected =
    visibleOptions.find((o) => o.id === value) ??
    visibleOptions[visibleOptions.length - 1];
  const effectiveDisabled = disabled || !effortSupported;
  const effectiveLabel = selected?.label ?? "Unavailable";
  const effectiveDescription =
    selected?.description ?? "This model does not support reasoning levels";
  const triggerLabel = effortSupported
    ? `Effort: ${effectiveLabel} — ${effectiveDescription}`
    : "Reasoning level unavailable";
  const triggerTitle =
    disabled && disabledTooltip ? disabledTooltip : triggerLabel;
  const isRainbow =
    selected?.id === "max" ||
    selected?.id === "xhigh" ||
    selected?.id === "ultra";

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        // Radix types the value as `string`; resolve it back to a typed
        // EffortLevel via the option table rather than an unchecked cast.
        const opt = EFFORT_OPTIONS.find((o) => o.id === next);
        if (opt) onChange(opt.id);
      }}
      disabled={effectiveDisabled}
      onOpenChange={onOpenChange}
    >
      {isRainbow ? (
        <SelectTrigger asChild>
          <button
            type="button"
            data-testid="effort-selector-trigger"
            title={triggerTitle}
            aria-label={triggerLabel}
            className={cn(TRIGGER_BASE, TRIGGER_RAINBOW)}
          >
            <span
              data-testid="effort-selector-label"
              className={cn("tracking-[0.02em]", RAINBOW_TEXT_CLIP)}
            >
              {effectiveLabel}
            </span>
            <span
              className={cn(
                "inline-flex text-[0.7rem] transition-transform duration-150 ease-[ease] group-data-[state=open]:rotate-180",
                RAINBOW_TEXT_CLIP,
              )}
              aria-hidden="true"
            >
              ▼
            </span>
          </button>
        </SelectTrigger>
      ) : (
        <SelectTrigger
          data-testid="effort-selector-trigger"
          title={triggerTitle}
          aria-label={triggerLabel}
        >
          <span
            data-testid="effort-selector-label"
            className="tracking-[0.02em]"
          >
            {effectiveLabel}
          </span>
        </SelectTrigger>
      )}
      <SelectContent side="top" align="end">
        {visibleOptions.map((option) => (
          <SelectItem
            key={option.id}
            value={option.id}
            description={option.description}
            data-testid="effort-selector-option"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
