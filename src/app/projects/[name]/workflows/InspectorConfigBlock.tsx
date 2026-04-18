"use client";

import { useState } from "react";

export type InspectorConfigBlockSource =
  | "global"
  | "workflow"
  | "context-override"
  | "disabled";

export interface InspectorConfigBlockProps {
  label: string;
  summary: string;
  source: InspectorConfigBlockSource;
  defaultOpen?: boolean;
  onOverride?: () => void;
  onReset?: () => void;
  onToggleDisabled?: () => void;
  children?: React.ReactNode;
}

const BADGE_TEXT: Record<InspectorConfigBlockSource, string> = {
  global: "INHERITED · GLOBAL",
  workflow: "INHERITED · WORKFLOW",
  "context-override": "OVERRIDDEN",
  disabled: "DISABLED",
};

function isInherited(source: InspectorConfigBlockSource): boolean {
  return source === "global" || source === "workflow";
}

export default function InspectorConfigBlock({
  label,
  summary,
  source,
  defaultOpen,
  onOverride,
  onReset,
  onToggleDisabled,
  children,
}: InspectorConfigBlockProps): React.JSX.Element {
  const initialOpen =
    defaultOpen ?? (source === "context-override" || source === "disabled");
  const [open, setOpen] = useState<boolean>(initialOpen);

  const editable = source === "context-override";
  const bodyId = `wb-inspector-block__body--${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div
      className={`wb-inspector-block wb-inspector-block--source-${source}`}
      data-source={source}
    >
      <button
        type="button"
        className="wb-inspector-block__head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span
          className={`cc-section-chevron${open ? "" : " collapsed"}`}
          aria-hidden="true"
        >
          ▾
        </span>
        <span className="cc-section-label">{label}</span>
        <span className="wb-inspector-block__summary">{summary}</span>
        <span className="wb-inspector-block__badge">{BADGE_TEXT[source]}</span>
      </button>

      <div id={bodyId} className="wb-inspector-block__body" hidden={!open}>
        <div
          className={`wb-inspector-block__controls${editable ? "" : " wb-inspector-block__controls--readonly"}`}
          aria-disabled={editable ? undefined : true}
        >
          {children}
        </div>

        <div className="wb-inspector-block__foot">
          {isInherited(source) && onOverride ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onOverride}
            >
              Override
            </button>
          ) : null}
          {isInherited(source) && onToggleDisabled ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onToggleDisabled}
            >
              Disable for this context
            </button>
          ) : null}

          {source === "context-override" && onReset ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onReset}
            >
              Reset to inherit
            </button>
          ) : null}
          {source === "context-override" && onToggleDisabled ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onToggleDisabled}
            >
              Disable for this context
            </button>
          ) : null}

          {source === "disabled" && onToggleDisabled ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onToggleDisabled}
            >
              Re-enable (inherit)
            </button>
          ) : null}
          {source === "disabled" && onOverride ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onOverride}
            >
              Override with custom validator
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
