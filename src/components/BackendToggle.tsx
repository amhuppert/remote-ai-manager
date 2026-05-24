"use client";

import type { AgentBackendId } from "@/lib/shared/schemas";
interface BackendToggleProps {
  value: AgentBackendId;
  onChange(backend: AgentBackendId): void;
  disabled?: boolean;
  readOnly?: boolean;
}

const BACKENDS: { id: AgentBackendId; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

export default function BackendToggle({
  value,
  onChange,
  disabled = false,
  readOnly = false,
}: BackendToggleProps): React.JSX.Element {
  if (readOnly) {
    return (
      <span className="backend-toggle-badge">
        {BACKENDS.find((b) => b.id === value)?.label ?? value}
      </span>
    );
  }

  return (
    <div className="backend-toggle">
      {BACKENDS.map((b) => (
        <button
          key={b.id}
          type="button"
          className={`backend-toggle-btn${b.id === value ? " active" : ""}`}
          data-backend={b.id}
          onClick={() => onChange(b.id)}
          disabled={disabled}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
