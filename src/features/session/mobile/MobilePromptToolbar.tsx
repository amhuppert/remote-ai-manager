"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

/** Sheet-row layout shared by the interactive "More" rows (legacy `.mobile-prompt-row`).
 *  `group` lets a row's icon react to the row's `data-on` (toggle highlight). */
const MOBILE_PROMPT_ROW_BASE =
  "group flex items-center gap-sm w-full p-sm border-0 rounded-sm bg-transparent text-text-primary font-mono text-[0.85rem] text-left min-h-[56px] transition-[background] duration-100";
/** Pressable rows (attach / debug / MCP). Exported for the MCP row owned by the composer. */
export const MOBILE_PROMPT_ROW_CLASS = `${MOBILE_PROMPT_ROW_BASE} cursor-pointer hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed`;
/** Non-pressable informational row (legacy `.mobile-prompt-row--static`). */
const MOBILE_PROMPT_ROW_STATIC_CLASS = `${MOBILE_PROMPT_ROW_BASE} cursor-default`;
/** Row icon (legacy `.mobile-prompt-row__icon`): per-backend tint + toggle-on amber. */
const MOBILE_PROMPT_ROW_ICON_CLASS =
  "w-[28px] h-[28px] flex items-center justify-center text-text-secondary shrink-0 font-mono text-[0.85rem] data-[backend=claude]:text-cyan data-[backend=codex]:text-violet group-data-[on=true]:text-amber";
/** Settings sheet option row (legacy `.mobile-prompt-option`). Active beats hover
 *  via mutually-exclusive `data-active` gating (legacy relied on later-rule order). */
const MOBILE_PROMPT_OPTION_CLASS =
  "flex items-center gap-sm w-full p-sm border-0 rounded-sm bg-transparent text-text-primary cursor-pointer text-left min-h-[52px] transition-[background] duration-100 data-[active=false]:hover:bg-bg-hover data-[active=true]:bg-cyan-glow";
/** The xhigh/max reasoning option name renders as rainbow gradient text (legacy
 *  `.mobile-prompt-option.cc-rainbow .__name`); `rainbow-shift` keyframe is preserved. */
const MOBILE_PROMPT_OPTION_NAME_RAINBOW =
  "bg-rainbow bg-[length:200%_auto] [-webkit-background-clip:text] [background-clip:text] [-webkit-text-fill-color:transparent] animate-[rainbow-shift_3s_linear_infinite] font-bold";
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

  useOverlayScope(sheet !== null);

  const selectedModelOpt = modelOptions.find((m) => m.id === selectedModel);
  const selectedEffortOpt = effortOptions.find((e) => e.id === selectedEffort);
  const chipModelLabel = selectedModelOpt?.label ?? selectedModel;
  const chipEffortLabel = selectedEffortOpt?.label;
  const effortIsRainbow =
    effortSupported && (selectedEffort === "xhigh" || selectedEffort === "max");

  return (
    <>
      <div className="hidden items-center gap-xs max-768:flex">
        <button
          type="button"
          className="flex h-[44px] w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-sm border border-border-subtle bg-transparent p-0 text-[1.4rem] leading-none text-text-secondary transition-[border-color,color,background] duration-150 hover:border-border-default hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => setSheet("more")}
          disabled={isReadOnly}
          aria-label="More options"
          aria-haspopup="dialog"
        >
          {"\u002B"}
        </button>

        <button
          type="button"
          className={cn(
            "mobile-prompt-model-chip inline-flex h-[44px] min-w-0 cursor-pointer items-center gap-xs rounded-sm border border-border-default bg-bg-surface px-[12px] font-mono text-[0.78rem] whitespace-nowrap text-text-primary transition-[border-color,background] duration-150 hover:border-cyan-dim disabled:cursor-not-allowed disabled:opacity-50",
            effortIsRainbow && "cc-rainbow-border",
          )}
          onClick={() => setSheet("settings")}
          disabled={isReadOnly || isBusy}
          aria-haspopup="dialog"
          aria-label={
            effortSupported && chipEffortLabel
              ? `Model ${chipModelLabel}, reasoning ${chipEffortLabel}`
              : `Model ${chipModelLabel}`
          }
        >
          <span className="font-semibold">{chipModelLabel}</span>
          {effortSupported && chipEffortLabel && (
            <>
              <span className="px-2xs text-text-tertiary">·</span>
              <span className="mobile-prompt-model-chip__effort text-text-secondary">
                {chipEffortLabel}
              </span>
            </>
          )}
          <span className="ml-xs text-[0.7rem] text-text-tertiary" aria-hidden>
            {"\u25BE"}
          </span>
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-xs">
          {voiceButton}
          {sendButton}
        </div>
      </div>

      <div
        className={cn("mobile-action-backdrop", sheet && "visible")}
        onClick={closeSheet}
      />

      <div
        className={cn("mobile-action-sheet", sheet === "more" && "visible")}
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
            className={MOBILE_PROMPT_ROW_CLASS}
            onClick={() => {
              closeSheet();
              onAttach();
            }}
            disabled={attachDisabled || isReadOnly}
          >
            <span className={MOBILE_PROMPT_ROW_ICON_CLASS} aria-hidden>
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
            <span className="flex min-w-0 flex-1 flex-col gap-2xs">
              <span className="font-medium text-text-primary">
                Attach images
              </span>
              <span className="text-[0.7rem] text-text-tertiary">
                JPEG, PNG, GIF, or WebP
              </span>
            </span>
            <span
              className="shrink-0 text-[1rem] text-text-tertiary"
              aria-hidden
            >
              {"\u203A"}
            </span>
          </button>

          <div className={MOBILE_PROMPT_ROW_STATIC_CLASS}>
            <span
              className={MOBILE_PROMPT_ROW_ICON_CLASS}
              data-backend={backend}
              aria-hidden
            >
              {backend === "codex" ? "$" : "/"}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-2xs">
              <span className="font-medium text-text-primary">Backend</span>
              <span className="text-[0.7rem] text-text-tertiary">
                {backendLocked
                  ? "Locked after first message"
                  : "Pick the agent runtime"}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-xs">
              {backendLocked ? (
                <span className="inline-flex items-center rounded-sm bg-bg-raised px-sm py-2xs font-mono text-[0.7rem] font-medium text-text-secondary">
                  {BACKEND_LABELS[backend]}
                </span>
              ) : (
                <div
                  className="inline-flex overflow-hidden rounded-sm border border-border-default"
                  role="radiogroup"
                  aria-label="Backend"
                >
                  {(["claude", "codex"] as AgentBackendId[]).map((b) => (
                    <button
                      key={b}
                      type="button"
                      role="radio"
                      aria-checked={backend === b}
                      className="cursor-pointer border-0 bg-transparent px-[10px] py-[6px] font-mono text-[0.72rem] text-text-secondary transition-[background,color] duration-150 disabled:cursor-not-allowed disabled:opacity-50 data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary data-[active=true]:data-[backend=claude]:bg-cyan-dim data-[active=true]:data-[backend=claude]:text-text-inverse data-[active=true]:data-[backend=codex]:bg-violet-dim data-[active=true]:data-[backend=codex]:text-text-inverse"
                      data-active={backend === b}
                      data-backend={b}
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
              className={MOBILE_PROMPT_ROW_CLASS}
              data-on={debugActive}
              onClick={onToggleDebug}
              disabled={debugDisabled || isReadOnly}
              aria-pressed={debugActive}
            >
              <span className={MOBILE_PROMPT_ROW_ICON_CLASS} aria-hidden>
                <span className="size-[6px] shrink-0 rounded-full bg-text-tertiary transition-all duration-200 ease-[ease]" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-2xs">
                <span className="font-medium text-text-primary">
                  Debug mode
                </span>
                <span className="text-[0.7rem] text-text-tertiary">
                  {debugActive
                    ? "Enabled — extra diagnostics"
                    : "Capture extra diagnostics"}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-xs">
                <span
                  className="relative h-[20px] w-[36px] shrink-0 rounded-[10px] bg-border-default transition-[background] duration-150 after:absolute after:top-2xs after:left-2xs after:h-[16px] after:w-[16px] after:rounded-full after:bg-text-secondary after:transition-[transform,background] after:duration-150 after:content-[''] data-[on=true]:bg-[var(--cc-amber-a35)] data-[on=true]:after:translate-x-[16px] data-[on=true]:after:bg-amber"
                  data-on={debugActive}
                  aria-hidden
                />
              </span>
            </button>
          )}

          {mcpRow}
        </div>
      </div>

      <div
        className={cn("mobile-action-sheet", sheet === "settings" && "visible")}
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
                className={MOBILE_PROMPT_OPTION_CLASS}
                data-active={active}
                onClick={() => {
                  onSelectModel(option.id);
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-2xs">
                  <span className="font-mono text-[0.85rem] font-medium text-text-primary">
                    {option.label}
                  </span>
                  <span className="font-mono text-[0.72rem] text-text-tertiary">
                    {option.description}
                  </span>
                </span>
                {active && (
                  <span
                    className="ml-auto shrink-0 text-[1rem] text-cyan"
                    aria-hidden
                  >
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
            <div className="p-sm font-mono text-[0.78rem] text-text-tertiary">
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
                  className={MOBILE_PROMPT_OPTION_CLASS}
                  data-active={active}
                  onClick={() => {
                    onSelectEffort(option.id);
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-2xs">
                    <span
                      className={cn(
                        "font-mono text-[0.85rem]",
                        isRainbow
                          ? MOBILE_PROMPT_OPTION_NAME_RAINBOW
                          : "font-medium text-text-primary",
                      )}
                    >
                      {option.label}
                    </span>
                    <span className="font-mono text-[0.72rem] text-text-tertiary">
                      {option.description}
                    </span>
                  </span>
                  {active && (
                    <span
                      className="ml-auto shrink-0 text-[1rem] text-cyan"
                      aria-hidden
                    >
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
