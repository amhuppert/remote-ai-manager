"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type EffortLevel = "low" | "medium" | "high";

interface EffortOption {
  id: EffortLevel;
  label: string;
  description: string;
}

const EFFORT_OPTIONS: EffortOption[] = [
  { id: "low", label: "Low", description: "Minimal" },
  { id: "medium", label: "Medium", description: "Moderate" },
  { id: "high", label: "High", description: "Default" },
];

interface ReasoningLevelSelectorProps {
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  disabled?: boolean;
  disabledTooltip?: string;
}

export default function ReasoningLevelSelector({
  value,
  onChange,
  disabled = false,
  disabledTooltip,
}: ReasoningLevelSelectorProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const selected =
    EFFORT_OPTIONS.find((o) => o.id === value) ?? EFFORT_OPTIONS[2]!;

  const toggle = useCallback(() => {
    if (!disabled) setOpen((prev) => !prev);
  }, [disabled]);

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
      {EFFORT_OPTIONS.map((option) => (
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
        className={`effort-selector-trigger${open ? " open" : ""}${value === "high" ? " rainbow-border" : ""}`}
        onClick={toggle}
        disabled={disabled}
        title={
          disabled && disabledTooltip
            ? disabledTooltip
            : `Effort: ${selected.label} — ${selected.description}`
        }
      >
        <span className="effort-selector-label">{selected.label}</span>
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
