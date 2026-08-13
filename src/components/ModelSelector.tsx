"use client";

import type { AgentBackendId } from "@/lib/shared/schemas";
import { modelOptionsForCatalogEntry } from "@/lib/agent-backends/catalog";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  type SelectContentLayer,
} from "@/components/ui/Select";

interface ModelSelectorProps {
  value: string;
  /** Bivariant via method syntax — callers can pass `(model: ModelId) => void` */
  onChange(model: string): void;
  disabled?: boolean;
  backend: AgentBackendId;
  /**
   * Reports the dropdown's open-state. The composer-focus hook uses it to hold
   * `composerFocused` true while this portaled popup (rendered outside the
   * composer region) steals focus from the editor.
   */
  onOpenChange?(open: boolean): void;
  /** Elevates the portaled listbox when the selector sits inside a popover. */
  contentLayer?: SelectContentLayer;
}

export default function ModelSelector({
  value,
  onChange,
  disabled = false,
  backend,
  onOpenChange,
  contentLayer,
}: ModelSelectorProps): React.JSX.Element {
  const { data: backends } = useBackendCatalogQuery();
  const entry = backends.find((b) => b.id === backend);
  if (!entry) {
    throw new Error(`Unknown agent backend: ${backend}`);
  }
  const options = modelOptionsForCatalogEntry(entry, value);
  // Fall back to the first option (the most capable of the set) when `value`
  // does not match the current backend's set — e.g. mid backend-switch.
  const selected = options.find((m) => m.id === value) ?? options[0]!;

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
      <SelectContent side="top" align="end" contentLayer={contentLayer}>
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
