"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { useOverlayScope } from "@/hooks/useOverlayScope";
interface ModelOption {
  id: string;
  label: string;
  description: string;
}

const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { id: "fable", label: "Fable", description: "Most capable" },
  { id: "opus", label: "Opus", description: "Highly capable" },
  { id: "sonnet", label: "Sonnet", description: "Balanced" },
  { id: "haiku", label: "Haiku", description: "Fastest" },
];

const CODEX_MODEL_OPTIONS: ModelOption[] = [
  { id: "gpt-5.5", label: "GPT-5.5", description: "Latest" },
  { id: "gpt-5.4", label: "GPT-5.4", description: "Most capable" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "Balanced" },
  { id: "gpt-5.4-nano", label: "GPT-5.4 Nano", description: "Fastest" },
];

/** Returns the model options for the given backend. */
export function getModelsForBackend(
  backend: AgentBackendId = "claude",
): ModelOption[] {
  return backend === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
}

interface ModelSelectorProps {
  value: string;
  /** Bivariant via method syntax — callers can pass `(model: ModelId) => void` */
  onChange(model: string): void;
  disabled?: boolean;
  backend?: AgentBackendId;
  /**
   * Reports the dropdown's open-state. The composer-focus hook uses it to hold
   * `composerFocused` true while this portaled popup (rendered outside the
   * composer region) steals focus from the editor.
   */
  onOpenChange?(open: boolean): void;
}

export default function ModelSelector({
  value,
  onChange,
  disabled = false,
  backend = "claude",
  onOpenChange,
}: ModelSelectorProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const options = useMemo(() => getModelsForBackend(backend), [backend]);

  const selected = options.find((m) => m.id === value) ?? options[1]!;

  const toggle = useCallback(() => {
    if (!disabled) setOpen((prev) => !prev);
  }, [disabled]);

  const select = useCallback(
    (id: string) => {
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

  useOverlayScope(open);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const dropdown = (
    <div
      ref={dropdownRef}
      className={`model-selector-dropdown${open ? " open" : ""}`}
      style={dropdownStyle}
    >
      {options.map((option) => (
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
