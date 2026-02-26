"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
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

  return (
    <div className="model-selector" ref={containerRef}>
      <button
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

      <div className={`model-selector-dropdown${open ? " open" : ""}`}>
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
    </div>
  );
}
