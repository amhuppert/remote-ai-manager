"use client";

import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/Select";

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
  const options = getModelsForBackend(backend);
  // Fall back to the second option (the established default) when `value` does
  // not match the current backend's set — e.g. mid backend-switch.
  const selected = options.find((m) => m.id === value) ?? options[1]!;

  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        data-testid="model-selector-trigger"
        title={`Model: ${selected.label} — ${selected.description}`}
      >
        <span data-testid="model-selector-label" className="tracking-[0.02em]">
          {selected.label}
        </span>
      </SelectTrigger>
      <SelectContent side="top" align="end">
        {options.map((option) => (
          <SelectItem
            key={option.id}
            value={option.id}
            description={option.description}
            data-testid="model-selector-option"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
