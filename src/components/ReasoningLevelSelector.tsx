"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import { useOverlayScope } from "@/hooks/useOverlayScope";
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

const TRIGGER_BASE =
  "flex items-center gap-1.5 h-9 px-3 border rounded-md font-mono text-[0.72rem] font-medium cursor-pointer whitespace-nowrap transition-all duration-150 ease-[ease] " +
  "bg-bg-surface text-text-secondary border-border-default " +
  "hover:bg-bg-hover hover:border-border-strong hover:text-text-primary " +
  "disabled:opacity-40 disabled:cursor-not-allowed";

const TRIGGER_OPEN =
  "border-cyan-dim text-text-primary shadow-[0_0_0_3px_var(--cyan-glow)]";

/**
 * Rainbow-border variant for the max/xhigh effort tiers. Reproduces the legacy
 * `.effort-selector-trigger.cc-rainbow-border` rule entirely as utilities: a
 * three-layer padding-box/border-box gradient stack (transparent border revealing
 * the rainbow gradient through `border-box`) with the animated background shift.
 * The hover/open box-shadows override the base ones unconditionally, matching the
 * legacy rule that applies them across the plain, `:hover`, and `.open` states.
 *
 * The background MUST be expressed as `background-image`/`-size`/`-clip`/`-origin`
 * longhands rather than the `background` shorthand: Tailwind emits the `background`
 * shorthand utility AFTER the `background-size`/`background-clip` longhand utilities,
 * so a shorthand here would reset size back to `auto` and clip back to `border-box`,
 * breaking the 200% scroll animation and the per-layer padding/border clipping.
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
);

const TRIGGER_RAINBOW_OPEN =
  "data-open:shadow-[0_0_0_3px_var(--rainbow-glow),0_0_14px_var(--cc-rainbow-glow-violet-a15)]";

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
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

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

  const isRainbow = selected?.id === "max" || selected?.id === "xhigh";

  const toggle = useCallback(() => {
    if (!effectiveDisabled) setOpen((prev) => !prev);
  }, [effectiveDisabled]);

  const select = useCallback(
    (id: EffortLevel) => {
      onChange(id);
      setOpen(false);
    },
    [onChange],
  );

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setDropdownStyle({
      position: "fixed",
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  useOverlayScope(open);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const dropdown = (
    <div
      ref={dropdownRef}
      data-testid="effort-selector-dropdown"
      data-open={open ? "" : undefined}
      className={cn(
        "fixed z-[150] min-w-[180px] rounded-md border border-border-default bg-bg-raised p-1",
        "[box-shadow:var(--cc-shadow-dropdown-up)]",
        "pointer-events-none translate-y-[4px] scale-[0.97] opacity-0",
        "transition-[opacity,transform] duration-[120ms] ease-[ease]",
        "data-open:pointer-events-auto data-open:translate-y-0 data-open:scale-100 data-open:opacity-100",
      )}
      style={dropdownStyle}
    >
      {visibleOptions.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            data-testid="effort-selector-option"
            data-active={active ? "" : undefined}
            className={cn(
              "group flex w-full cursor-pointer items-center justify-between rounded-sm border-none bg-transparent px-3 py-2 text-left font-mono text-[0.75rem] font-medium text-text-primary transition-all duration-100 ease-[ease]",
              "hover:bg-bg-hover",
              "data-active:bg-cyan-glow data-active:text-cyan",
            )}
            onClick={() => select(option.id)}
          >
            <span className="font-semibold">{option.label}</span>
            <span className="text-[0.7rem] font-normal text-text-tertiary group-data-active:text-cyan-dim">
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="relative shrink-0" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="effort-selector-trigger"
        data-rainbow={isRainbow ? "" : undefined}
        data-open={open ? "" : undefined}
        className={cn(
          "group",
          TRIGGER_BASE,
          open && !isRainbow && TRIGGER_OPEN,
          isRainbow && [TRIGGER_RAINBOW, TRIGGER_RAINBOW_OPEN],
        )}
        onClick={toggle}
        disabled={effectiveDisabled}
        aria-label={triggerLabel}
        title={disabled && disabledTooltip ? disabledTooltip : triggerLabel}
      >
        <span
          data-testid="effort-selector-label"
          className={cn("tracking-[0.02em]", isRainbow && RAINBOW_TEXT_CLIP)}
        >
          {effectiveLabel}
        </span>
        <span
          className={cn(
            "text-[0.7rem] text-text-tertiary transition-colors duration-150 ease-[ease]",
            "group-hover:text-text-secondary group-data-open:text-text-secondary",
            isRainbow && RAINBOW_TEXT_CLIP,
          )}
        >
          {open ? "▲" : "▼"}
        </span>
      </button>

      {typeof document !== "undefined"
        ? createPortal(dropdown, document.body)
        : null}
    </div>
  );
}
