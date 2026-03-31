"use client";

interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  revision: number;
}

interface WorkflowDefinitionsSidebarProps {
  definitions: WorkflowDefinitionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  isLoading: boolean;
  footer?: React.ReactNode;
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
          definitions.map((def) => (
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
            </button>
          ))
        )}
      </div>
      {footer && <div className="wb-sidebar-footer">{footer}</div>}
    </aside>
  );
}
