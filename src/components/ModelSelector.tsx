"use client";

import type { AgentBackendId } from "@/lib/shared/schemas";
import { modelOptionsForCatalogEntry } from "@/lib/agent-backends/catalog";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import type { ProjectBackendModelOptions } from "@/lib/agent-backends/project-model-options-schema";
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
   * The project's effective options for this backend, when the surface has
   * project context (spec D10). Supplying them replaces the process-global
   * catalog AND changes the out-of-range behavior: a value the project does not
   * permit is reported as an invalid selection rather than displayed as one of
   * the permitted models, because the API will refuse it.
   *
   * Omit (or pass null) when the project's options are unknown — global
   * settings, workflow configuration, or a query that has not resolved.
   */
  projectOptions?: ProjectBackendModelOptions | null;
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
  projectOptions = null,
  onOpenChange,
  contentLayer,
}: ModelSelectorProps): React.JSX.Element {
  const { data: backends } = useBackendCatalogQuery();
  const entry = backends.find((b) => b.id === backend);
  if (!entry) {
    throw new Error(`Unknown agent backend: ${backend}`);
  }
  const options =
    projectOptions === null
      ? modelOptionsForCatalogEntry(entry, value)
      : projectOptions.models;
  const match = options.find((m) => m.id === value);

  // With project-scoped options an unmatched value is a real invalid selection
  // the operator has to resolve; without them it is usually a mid
  // backend-switch transient, where showing the most capable option is right.
  const invalidSelection = projectOptions !== null && match === undefined;
  const selected = match ?? (projectOptions === null ? options[0] : undefined);

  const title = invalidSelection
    ? options.length === 0
      ? `No ${entry.label} model is available: this project's configuration permits none. Model "${value}" cannot be used.`
      : `Model "${value}" is not available for this project — choose one of: ${options.map((o) => o.id).join(", ")}`
    : selected !== undefined
      ? `Model: ${selected.label} — ${selected.description}`
      : undefined;

  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled || options.length === 0}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        data-testid="model-selector-trigger"
        {...(invalidSelection
          ? { "data-invalid-selection": "true", "aria-invalid": true }
          : {})}
        {...(title !== undefined ? { title } : {})}
      >
        <span
          data-testid="model-selector-label"
          className={
            invalidSelection
              ? "tracking-[0.02em] text-[var(--red)]"
              : "tracking-[0.02em]"
          }
        >
          {selected?.label ??
            (options.length === 0 ? "No model available" : "Select a model")}
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
