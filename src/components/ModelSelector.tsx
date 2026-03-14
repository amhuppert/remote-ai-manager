"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type ModelId = "opus" | "sonnet" | "haiku";

interface ModelOption {
  id: ModelId;
  label: string;
  description: string;
}

const MODEL_OPTIONS: ModelOption[] = [
  { id: "opus", label: "Opus", description: "Most capable" },
  { id: "sonnet", label: "Sonnet", description: "Balanced" },
  { id: "haiku", label: "Haiku", description: "Fastest" },
];

interface ModelSelectorProps {
  value: ModelId;
  onChange: (model: ModelId) => void;
  disabled?: boolean;
}

export default function ModelSelector({
  value,
  onChange,
  disabled = false,
}: ModelSelectorProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const selected =
    MODEL_OPTIONS.find((m) => m.id === value) ?? MODEL_OPTIONS[1]!;

  const toggle = useCallback(() => {
    if (!disabled) setOpen((prev) => !prev);
  }, [disabled]);

  const select = useCallback(
    (id: ModelId) => {
      onChange(id);
      setOpen(false);
    },
    [onChange],
  );

  // Position the dropdown above the trigger when open
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setDropdownStyle({
      position: "fixed",
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  // Close on outside click — check both container and dropdown
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

  // Close on Escape
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
      className={`model-selector-dropdown${open ? " open" : ""}`}
      style={dropdownStyle}
    >
      {MODEL_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`model-selector-option${option.id === value ? " active" : ""}`}
          onClick={() => select(option.id)}
        >
          <span className="model-option-name">{option.label}</span>
          <span className="model-option-desc">{option.description}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="model-selector" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`model-selector-trigger${open ? " open" : ""}`}
        onClick={toggle}
        disabled={disabled}
        title={`Model: ${selected.label} — ${selected.description}`}
      >
        <span className="model-selector-label">{selected.label}</span>
        <span className="model-selector-chevron">
          {open ? "\u25B2" : "\u25BC"}
        </span>
      </button>

      {typeof document !== "undefined"
        ? createPortal(dropdown, document.body)
        : null}
    </div>
  );
}
