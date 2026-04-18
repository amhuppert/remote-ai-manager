"use client";

type ContextOverrideFields = {
  implementer?: unknown;
  contextValidator?: unknown;
  mutability?: unknown;
  circuitBreaker?: unknown;
  iterationPolicy?: unknown;
};

interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  revision: number;
  workflowConfig?: Record<string, unknown>;
  executionContexts?: ContextOverrideFields[];
}

interface WorkflowDefinitionsSidebarProps {
  definitions: WorkflowDefinitionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  isLoading: boolean;
  footer?: React.ReactNode;
}

type DotState =
  | { variant: "default"; tooltip: string }
  | { variant: "workflow"; tooltip: string }
  | { variant: "context"; tooltip: string };

const OVERRIDE_KEYS: Array<keyof ContextOverrideFields> = [
  "implementer",
  "contextValidator",
  "mutability",
  "circuitBreaker",
  "iterationPolicy",
];

function countContextOverrides(context: ContextOverrideFields): number {
  let count = 0;
  for (const key of OVERRIDE_KEYS) {
    if (context[key] !== undefined) count += 1;
  }
  return count;
}

function computeDotState(def: WorkflowDefinitionSummary): DotState {
  const contexts = def.executionContexts ?? [];
  let contextsWithOverrides = 0;
  let totalContextOverrides = 0;
  for (const ctx of contexts) {
    const n = countContextOverrides(ctx);
    if (n > 0) {
      contextsWithOverrides += 1;
      totalContextOverrides += n;
    }
  }

  if (contextsWithOverrides > 0) {
    return {
      variant: "context",
      tooltip: `Custom per-context config (${contextsWithOverrides} contexts, ${totalContextOverrides} overrides total)`,
    };
  }

  const workflowKeyCount = def.workflowConfig
    ? Object.keys(def.workflowConfig).length
    : 0;
  if (workflowKeyCount > 0) {
    return {
      variant: "workflow",
      tooltip: `Custom workflow defaults (${workflowKeyCount} blocks overridden)`,
    };
  }

  return { variant: "default", tooltip: "All defaults" };
}

export default function WorkflowDefinitionsSidebar({
  definitions,
  selectedId,
  onSelect,
  onCreate,
  isLoading,
  footer,
}: WorkflowDefinitionsSidebarProps) {
  return (
    <aside className="wb-sidebar">
      <div className="wb-sidebar-header">
        <span className="wb-sidebar-title">Definitions</span>
        <button
          className="wb-btn wb-btn-xs wb-btn-default"
          onClick={onCreate}
          type="button"
          title="Create workflow"
        >
          +
        </button>
      </div>

      <div className="wb-sidebar-list">
        {isLoading ? (
          <div
            style={{
              padding: "var(--space-md)",
              color: "var(--text-tertiary)",
              fontSize: "0.72rem",
            }}
          >
            Loading...
          </div>
        ) : definitions.length === 0 ? (
          <div
            style={{
              padding: "var(--space-md)",
              color: "var(--text-tertiary)",
              fontSize: "0.72rem",
            }}
          >
            No workflows yet
          </div>
        ) : (
          definitions.map((def) => {
            const dot = computeDotState(def);
            return (
              <button
                key={def.id}
                className={`wb-def-item${def.id === selectedId ? " active" : ""}`}
                onClick={() => onSelect(def.id)}
                type="button"
              >
                <div className="wb-def-item-info">
                  <div className="wb-def-item-name">{def.name}</div>
                </div>
                <span className="wb-def-revision">r{def.revision}</span>
                <span
                  className={`wb-def-item-dot wb-def-item-dot--${dot.variant}`}
                  data-tooltip={dot.tooltip}
                  aria-label={dot.tooltip}
                  role="img"
                />
              </button>
            );
          })
        )}
      </div>
      {footer && <div className="wb-sidebar-footer">{footer}</div>}
    </aside>
  );
}
