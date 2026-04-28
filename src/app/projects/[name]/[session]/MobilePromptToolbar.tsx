"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentBackendId, EffortLevel } from "@/lib/schemas";

interface ModelOption {
  id: string;
  label: string;
  description: string;
}

interface EffortOption {
  id: EffortLevel;
  label: string;
  description: string;
}

type SheetId = "more" | "settings" | null;

export interface MobilePromptToolbarProps {
  modelOptions: ModelOption[];
  effortOptions: EffortOption[];
  selectedModel: string;
  selectedEffort: EffortLevel;
  effortSupported: boolean;
  effortDisabledReason?: string;
  onSelectModel(id: string): void;
  onSelectEffort(id: EffortLevel): void;

  backend: AgentBackendId;
  backendLocked: boolean;
  onSelectBackend(b: AgentBackendId): void;

  onAttach(): void;
  attachDisabled?: boolean;

  debugActive: boolean;
  debugSupported: boolean;
  onToggleDebug(): void;
  debugDisabled?: boolean;

  /**
   * Optional MCP row rendered inside the More sheet. The trigger inside this
   * node is responsible for opening its own popover so positioning anchors
   * correctly to a visible DOM node.
   */
  mcpRow?: React.ReactNode;

  voiceButton: React.ReactNode;
  sendButton: React.ReactNode;

  isReadOnly?: boolean;
  isBusy?: boolean;
}

const BACKEND_LABELS: Record<AgentBackendId, string> = {
  claude: "Claude",
  codex: "Codex",
};

export default function MobilePromptToolbar({
  modelOptions,
  effortOptions,
  selectedModel,
  selectedEffort,
  effortSupported,
  effortDisabledReason,
  onSelectModel,
  onSelectEffort,
  backend,
  backendLocked,
  onSelectBackend,
  onAttach,
  attachDisabled,
  debugActive,
  debugSupported,
  onToggleDebug,
  debugDisabled,
  mcpRow,
  voiceButton,
  sendButton,
  isReadOnly,
  isBusy,
}: MobilePromptToolbarProps): React.JSX.Element {
  const [sheet, setSheet] = useState<SheetId>(null);

  const closeSheet = useCallback(() => setSheet(null), []);

  useEffect(() => {
    if (!sheet) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheet(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [sheet]);

  const selectedModelOpt = modelOptions.find((m) => m.id === selectedModel);
  const selectedEffortOpt = effortOptions.find((e) => e.id === selectedEffort);
  const chipModelLabel = selectedModelOpt?.label ?? selectedModel;
  const chipEffortLabel = selectedEffortOpt?.label;
  const effortIsRainbow =
    effortSupported && (selectedEffort === "xhigh" || selectedEffort === "max");

  return (
    <>
      <div className="mobile-prompt-toolbar">
        <button
          type="button"
          className="mobile-prompt-add-btn"
          onClick={() => setSheet("more")}
          disabled={isReadOnly}
          aria-label="More options"
          aria-haspopup="dialog"
        >
          {"\u002B"}
        </button>

        <button
          type="button"
          className={`mobile-prompt-model-chip${effortIsRainbow ? " rainbow-border" : ""}`}
          onClick={() => setSheet("settings")}
          disabled={isReadOnly || isBusy}
          aria-haspopup="dialog"
          aria-label={
            effortSupported && chipEffortLabel
              ? `Model ${chipModelLabel}, reasoning ${chipEffortLabel}`
              : `Model ${chipModelLabel}`
          }
        >
          <span className="mobile-prompt-model-chip__model">
            {chipModelLabel}
          </span>
          {effortSupported && chipEffortLabel && (
            <>
              <span className="mobile-prompt-model-chip__sep">·</span>
              <span className="mobile-prompt-model-chip__effort">
                {chipEffortLabel}
              </span>
            </>
          )}
          <span className="mobile-prompt-model-chip__chevron" aria-hidden>
            {"\u25BE"}
          </span>
        </button>

        <div className="mobile-prompt-toolbar-end">
          {voiceButton}
          {sendButton}
        </div>
      </div>

      <div
        className={`mobile-action-backdrop${sheet ? " visible" : ""}`}
        onClick={closeSheet}
      />

      <div
        className={`mobile-action-sheet${sheet === "more" ? " visible" : ""}`}
        role="dialog"
        aria-label="More options"
        aria-hidden={sheet !== "more"}
      >
        <div className="mobile-action-sheet-header">
          <div className="mobile-action-sheet-handle" />
          <button
            className="mobile-action-sheet-close"
            onClick={closeSheet}
            aria-label="Close menu"
            type="button"
          >
            {"\u2715"}
          </button>
        </div>

        <div className="mobile-action-sheet-section">
          <button
            type="button"
            className="mobile-prompt-row"
            onClick={() => {
              closeSheet();
              onAttach();
            }}
            disabled={attachDisabled || isReadOnly}
          >
            <span className="mobile-prompt-row__icon" aria-hidden>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </span>
            <span className="mobile-prompt-row__content">
              <span className="mobile-prompt-row__label">Attach images</span>
              <span className="mobile-prompt-row__meta">
                JPEG, PNG, GIF, or WebP
              </span>
            </span>
            <span className="mobile-prompt-row__chevron" aria-hidden>
              {"\u203A"}
            </span>
          </button>

          <div className="mobile-prompt-row mobile-prompt-row--static">
            <span className="mobile-prompt-row__icon" aria-hidden>
              {backend === "codex" ? "$" : "/"}
            </span>
            <span className="mobile-prompt-row__content">
              <span className="mobile-prompt-row__label">Backend</span>
              <span className="mobile-prompt-row__meta">
                {backendLocked
                  ? "Locked after first message"
                  : "Pick the agent runtime"}
              </span>
            </span>
            <span className="mobile-prompt-row__trailing">
              {backendLocked ? (
                <span className="mobile-prompt-badge">
                  {BACKEND_LABELS[backend]}
                </span>
              ) : (
                <div
                  className="mobile-prompt-segment"
                  role="radiogroup"
                  aria-label="Backend"
                >
                  {(["claude", "codex"] as AgentBackendId[]).map((b) => (
                    <button
                      key={b}
                      type="button"
                      role="radio"
                      aria-checked={backend === b}
                      className={`mobile-prompt-segment__btn${backend === b ? " active" : ""}`}
                      onClick={() => onSelectBackend(b)}
                      disabled={isBusy || isReadOnly}
                    >
                      {BACKEND_LABELS[b]}
                    </button>
                  ))}
                </div>
              )}
            </span>
          </div>

          {debugSupported && (
            <button
              type="button"
              className={`mobile-prompt-row${debugActive ? " is-on" : ""}`}
              onClick={onToggleDebug}
              disabled={debugDisabled || isReadOnly}
              aria-pressed={debugActive}
            >
              <span className="mobile-prompt-row__icon" aria-hidden>
                <span
                  className={`debug-toggle__dot${debugActive ? " is-on" : ""}`}
                />
              </span>
              <span className="mobile-prompt-row__content">
                <span className="mobile-prompt-row__label">Debug mode</span>
                <span className="mobile-prompt-row__meta">
                  {debugActive
                    ? "Enabled — extra diagnostics"
                    : "Capture extra diagnostics"}
                </span>
              </span>
              <span className="mobile-prompt-row__trailing">
                <span
                  className={`mobile-prompt-switch${debugActive ? " on" : ""}`}
                  aria-hidden
                />
              </span>
            </button>
          )}

          {mcpRow}
        </div>
      </div>

      <div
        className={`mobile-action-sheet${sheet === "settings" ? " visible" : ""}`}
        role="dialog"
        aria-label="Model and reasoning"
        aria-hidden={sheet !== "settings"}
      >
        <div className="mobile-action-sheet-header">
          <div className="mobile-action-sheet-handle" />
          <button
            className="mobile-action-sheet-close"
            onClick={closeSheet}
            aria-label="Close menu"
            type="button"
          >
            {"\u2715"}
          </button>
        </div>

        <div className="mobile-action-sheet-section">
          <div className="mobile-action-sheet-label">Model</div>
          {modelOptions.map((option) => {
            const active = option.id === selectedModel;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`mobile-prompt-option${active ? " active" : ""}`}
                onClick={() => {
                  onSelectModel(option.id);
                }}
              >
                <span className="mobile-prompt-option__text">
                  <span className="mobile-prompt-option__name">
                    {option.label}
                  </span>
                  <span className="mobile-prompt-option__desc">
                    {option.description}
                  </span>
                </span>
                {active && (
                  <span className="mobile-prompt-option__check" aria-hidden>
                    {"\u2713"}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mobile-action-sheet-divider" />

        <div className="mobile-action-sheet-section">
          <div className="mobile-action-sheet-label">Reasoning</div>
          {!effortSupported ? (
            <div className="mobile-prompt-empty">
              {effortDisabledReason ??
                "Reasoning level is not available for this model."}
            </div>
          ) : (
            effortOptions.map((option) => {
              const active = option.id === selectedEffort;
              const isRainbow = option.id === "xhigh" || option.id === "max";
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`mobile-prompt-option${active ? " active" : ""}${isRainbow ? " rainbow" : ""}`}
                  onClick={() => {
                    onSelectEffort(option.id);
                  }}
                >
                  <span className="mobile-prompt-option__text">
                    <span className="mobile-prompt-option__name">
                      {option.label}
                    </span>
                    <span className="mobile-prompt-option__desc">
                      {option.description}
                    </span>
                  </span>
                  {active && (
                    <span className="mobile-prompt-option__check" aria-hidden>
                      {"\u2713"}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
