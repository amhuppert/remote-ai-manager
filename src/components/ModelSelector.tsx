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
import { cn } from "@/lib/ui/cn";
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
      data-testid="model-selector-dropdown"
      data-open={open}
      className={cn(
        "fixed z-[150] min-w-[180px] rounded-md border border-border-default bg-bg-raised p-[4px] [box-shadow:var(--cc-shadow-dropdown-up)] transition-[opacity,transform] duration-[120ms] ease-[ease] max-768:min-w-[200px]",
        open
          ? "pointer-events-auto [transform:translateY(0px)_scale(1)] opacity-100"
          : "pointer-events-none [transform:translateY(4px)_scale(0.97)] opacity-0",
      )}
      style={dropdownStyle}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            data-testid="model-selector-option"
            className={cn(
              "flex w-full cursor-pointer items-center justify-between rounded-sm border-none px-[12px] py-[8px] text-left font-mono text-[0.75rem] font-medium transition-all duration-100 ease-[ease]",
              active
                ? "bg-cyan-glow text-cyan"
                : "bg-transparent text-text-primary hover:bg-bg-hover",
            )}
            onClick={() => select(option.id)}
          >
            <span className="font-semibold">{option.label}</span>
            <span
              className={cn(
                "text-[0.7rem] font-normal",
                active ? "text-cyan-dim" : "text-text-tertiary",
              )}
            >
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      className="relative shrink-0"
      ref={containerRef}
      data-testid="model-selector"
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="model-selector-trigger"
        className={cn(
          "group flex h-[36px] cursor-pointer items-center gap-[6px] rounded-md border px-[12px] font-mono text-[0.72rem] font-medium whitespace-nowrap transition-all duration-150 ease-[ease] disabled:cursor-not-allowed disabled:opacity-40 max-768:h-[44px]",
          open
            ? "border-cyan-dim text-text-primary shadow-[0_0_0_3px_var(--cyan-glow)]"
            : "border-border-default bg-bg-surface text-text-secondary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary",
        )}
        onClick={toggle}
        disabled={disabled}
        title={`Model: ${selected.label} — ${selected.description}`}
      >
        <span data-testid="model-selector-label" className="tracking-[0.02em]">
          {selected.label}
        </span>
        <span
          className={cn(
            "text-[0.7rem] transition-colors duration-150 ease-[ease]",
            open
              ? "text-text-secondary"
              : "text-text-tertiary group-hover:text-text-secondary",
          )}
        >
          {open ? "\u25B2" : "\u25BC"}
        </span>
      </button>

      {typeof document !== "undefined"
        ? createPortal(dropdown, document.body)
        : null}
    </div>
  );
}
