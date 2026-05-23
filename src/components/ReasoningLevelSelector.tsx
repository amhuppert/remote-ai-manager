"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { EffortLevel } from "@/lib/schemas";

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
}

export default function ReasoningLevelSelector({
  value,
  onChange,
  disabled = false,
  disabledTooltip,
  availableLevels,
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

  const dropdown = (
    <div
      ref={dropdownRef}
      className={`effort-selector-dropdown${open ? " open" : ""}`}
      style={dropdownStyle}
    >
      {visibleOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`effort-selector-option${option.id === value ? " active" : ""}`}
          onClick={() => select(option.id)}
        >
          <span className="effort-option-name">{option.label}</span>
          <span className="effort-option-desc">{option.description}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="effort-selector" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`effort-selector-trigger${open ? " open" : ""}${selected?.id === "max" || selected?.id === "xhigh" ? " cc-rainbow-border" : ""}`}
        onClick={toggle}
        disabled={effectiveDisabled}
        aria-label={triggerLabel}
        title={disabled && disabledTooltip ? disabledTooltip : triggerLabel}
      >
        <span className="effort-selector-label">{effectiveLabel}</span>
        <span className="effort-selector-chevron">
          {open ? "\u25B2" : "\u25BC"}
        </span>
      </button>

      {typeof document !== "undefined"
        ? createPortal(dropdown, document.body)
        : null}
    </div>
  );
}
