"use client";

import { useRef, useState } from "react";

interface WorkflowToolbarProps {
  workflowName: string;
  revision: number | null;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddContext: () => void;
  onSave: () => void;
  onReset: () => void;
  onRelayout: () => void;
  onOpenWorkflowSettings?: () => void;
  dirty: boolean;
  saving: boolean;
  hasValidationErrors: boolean;
  isMobile?: boolean;
}

export default function WorkflowToolbar({
  workflowName,
  revision,
  onRename,
  onDelete,
  onAddContext,
  onSave,
  onReset,
  onRelayout,
  onOpenWorkflowSettings,
  dirty,
  saving,
  hasValidationErrors,
  isMobile,
}: WorkflowToolbarProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(workflowName);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleNameClick() {
    setNameValue(workflowName);
    setEditingName(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function commitRename() {
    const trimmed = nameValue.trim();
    if (trimmed.length > 0 && trimmed !== workflowName) {
      onRename(trimmed);
    } else {
      setNameValue(workflowName);
    }
    setEditingName(false);
  }

  function cancelRename() {
    setNameValue(workflowName);
    setEditingName(false);
  }

  const nameElement = editingName ? (
    <input
      ref={inputRef}
      className="wb-header-name"
      value={nameValue}
      onChange={(e) => setNameValue(e.target.value)}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitRename();
        if (e.key === "Escape") cancelRename();
      }}
      type="text"
    />
  ) : (
    <button
      className="wb-header-name"
      onClick={handleNameClick}
      type="button"
      title="Click to rename"
      style={{ cursor: "text" }}
    >
      {workflowName}
    </button>
  );

  const statusElement = (
    <div className="wb-header-status">
      {hasValidationErrors ? (
        <span style={{ color: "var(--red)" }}>Validation errors</span>
      ) : dirty ? (
        <>
          <span className="dot unsaved" />
          <span style={{ color: "var(--text-secondary)" }}>
            Unsaved changes
          </span>
        </>
      ) : (
        <>
          <span className="dot saved" />
          <span style={{ color: "var(--text-secondary)" }}>
            All changes saved
          </span>
        </>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div className="wb-header wb-mobile-toolbar">
        <div className="wb-mobile-toolbar-main">
          <div className="wb-header-identity">
            {nameElement}
            {revision != null && (
              <span className="wb-header-revision">r{revision}</span>
            )}
          </div>
          {statusElement}
        </div>
        <div className="wb-mobile-toolbar-actions">
          <button
            className="wb-btn wb-btn-sm wb-btn-default"
            onClick={onAddContext}
            type="button"
          >
            + Add Context
          </button>
          <button
            className="wb-btn wb-btn-sm wb-btn-primary"
            onClick={onSave}
            disabled={!dirty || saving}
            type="button"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <div className="wb-mobile-toolbar-overflow">
            <button
              className="wb-btn wb-btn-sm wb-btn-default"
              onClick={() => setOverflowOpen((v) => !v)}
              type="button"
              aria-label="More workflow actions"
            >
              •••
            </button>
            {overflowOpen && (
              <div className="wb-mobile-toolbar-menu">
                <button
                  className="wb-mobile-toolbar-menu-item"
                  onClick={() => {
                    onReset();
                    setOverflowOpen(false);
                  }}
                  disabled={!dirty}
                  type="button"
                >
                  Reset
                </button>
                <button
                  className="wb-mobile-toolbar-menu-item"
                  onClick={() => {
                    onRelayout();
                    setOverflowOpen(false);
                  }}
                  type="button"
                >
                  Re-layout
                </button>
                {onOpenWorkflowSettings && (
                  <button
                    className="wb-mobile-toolbar-menu-item"
                    onClick={() => {
                      onOpenWorkflowSettings();
                      setOverflowOpen(false);
                    }}
                    type="button"
                    aria-label="Workflow settings"
                  >
                    <span aria-hidden="true">⚙</span> Workflow settings
                  </button>
                )}
                <button
                  className="wb-mobile-toolbar-menu-item wb-mobile-toolbar-menu-danger"
                  onClick={() => {
                    onDelete();
                    setOverflowOpen(false);
                  }}
                  type="button"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wb-header">
      <div className="wb-header-identity">
        {nameElement}
        {revision != null && (
          <span className="wb-header-revision">r{revision}</span>
        )}
      </div>

      <div className="wb-header-sep" />

      <div className="wb-header-actions">
        <button
          className="wb-btn wb-btn-sm wb-btn-default"
          onClick={onAddContext}
          type="button"
        >
          + Add Context
        </button>
        <button
          className="wb-btn wb-btn-sm wb-btn-primary"
          onClick={onSave}
          disabled={!dirty || saving}
          type="button"
        >
          {saving ? "Saving..." : "Save Draft"}
        </button>
        <button
          className="wb-btn wb-btn-sm wb-btn-default"
          onClick={onReset}
          disabled={!dirty}
          type="button"
        >
          Reset
        </button>
        <button
          className="wb-btn wb-btn-sm wb-btn-default"
          onClick={onRelayout}
          type="button"
        >
          Re-layout
        </button>
        {onOpenWorkflowSettings && (
          <button
            className="wb-btn wb-btn-sm wb-btn-default"
            onClick={onOpenWorkflowSettings}
            type="button"
            aria-label="Workflow settings"
            title="Workflow settings"
          >
            <span aria-hidden="true">⚙</span> Workflow settings
          </button>
        )}
      </div>

      {statusElement}

      <div className="wb-header-sep" />

      <button
        className="wb-btn wb-btn-sm wb-btn-danger"
        onClick={onDelete}
        type="button"
      >
        Delete
      </button>
    </div>
  );
}
