"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { ModelOptionsEditor } from "@/components/session/prompt/ModelSelectionControls";
import {
  backendLabel,
  backendToneToken,
  skillTriggerPrefixForBackend,
} from "@/lib/agent-backends/catalog";
import {
  defaultSelectionForModel,
  validateModelSelection,
} from "@/lib/agent-backends/model-selection";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import type {
  BackendModelCatalog,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
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
  "w-[28px] h-[28px] flex items-center justify-center text-text-secondary shrink-0 font-mono text-[0.85rem] data-[tone=cyan]:text-cyan data-[tone=violet]:text-violet group-data-[on=true]:text-amber";
/** Settings sheet option row. Active beats hover via mutually-exclusive state. */
const MOBILE_PROMPT_OPTION_CLASS =
  "flex items-center gap-sm w-full p-sm border-0 rounded-sm bg-transparent text-text-primary cursor-pointer text-left min-h-[52px] transition-[background] duration-100 data-[active=false]:hover:bg-bg-hover data-[active=true]:bg-cyan-glow";
// The bottom-sheet scrim + card recipe, ported from the legacy
// `.mobile-action-backdrop` / `.mobile-action-sheet` globals to utilities so the
// sheet composes the `ui/Dialog` unstyled/edge-anchored variant (which owns the
// focus trap, focus return, Escape, and outside-press dismissal Radix provides)
// instead of a hand-rolled `role="dialog"` div toggled by CSS visibility.
// The scrim must stay at `z-dropdown` — the tier of the Dialog's `overlayStretch`
// positioning layer that hosts the card. The card lives inside that layer's
// stacking context, so a higher-tier scrim paints over the card no matter what
// z-index the card itself carries (see `overlayStretch` in dialog-recipe.ts).
const MOBILE_SHEET_SCRIM =
  "fixed inset-0 z-dropdown motion-safe:animate-[fadeIn_0.15s_ease] bg-[var(--cc-bg-void-a70)] [backdrop-filter:blur(4px)]";
const MOBILE_SHEET_CARD =
  "fixed inset-x-0 bottom-0 flex max-h-[70vh] motion-safe:animate-[slideUpSheet_0.25s_ease] flex-col gap-sm overflow-y-auto rounded-t-lg border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-surface px-md pt-md pb-[calc(var(--spacing-lg)+env(safe-area-inset-bottom,0px))]";
type SheetId = "more" | "settings" | null;

export interface MobilePromptToolbarProps {
  modelCatalog: BackendModelCatalog | null;
  modelSelection: BackendModelSelection;
  modelSelectionBlockedReason: string | null;
  onModelSelectionChange(selection: BackendModelSelection): void;

  backend: AgentBackendId;
  backendLocked: boolean;
  onSelectBackend(b: AgentBackendId): void;

  onAttach(): void;
  attachDisabled?: boolean;

  /**
   * Reports whether either bottom sheet is open. The sheets render in a Radix
   * portal outside the composer's DOM region, so the composer's focus tracking
   * cannot see them — without this report, focus moving onto a non-focusable
   * sheet area (or a disabled row) lands on `body`, the composer counts as
   * blurred and collapses, and the sheet unmounts mid-interaction. Wire to
   * `setControlActive` like the other portaled composer controls.
   */
  onSheetOpenChange?(open: boolean): void;

  debugActive: boolean;
  debugSupported: boolean;
  onToggleDebug(): void;
  debugDisabled?: boolean;
  /** Debug toggle mutation in flight — the row shows a visible pending state. */
  debugPending?: boolean;

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

export default function MobilePromptToolbar({
  modelCatalog,
  modelSelection,
  modelSelectionBlockedReason,
  onModelSelectionChange,
  backend,
  backendLocked,
  onSelectBackend,
  onAttach,
  attachDisabled,
  onSheetOpenChange,
  debugActive,
  debugSupported,
  onToggleDebug,
  debugDisabled,
  debugPending = false,
  mcpRow,
  voiceButton,
  sendButton,
  isReadOnly,
  isBusy,
}: MobilePromptToolbarProps): React.JSX.Element {
  const { data: catalogBackends } = useBackendCatalogQuery();
  const [sheet, setSheet] = useState<SheetId>(null);

  const closeSheet = useCallback(() => setSheet(null), []);

  // The cleanup also releases the control when the toolbar unmounts while a
  // sheet is open, so the composer's focus hook is not left held forever.
  useEffect(() => {
    onSheetOpenChange?.(sheet !== null);
    return () => onSheetOpenChange?.(false);
  }, [sheet, onSheetOpenChange]);

  const validation =
    modelCatalog === null
      ? null
      : validateModelSelection(modelCatalog, modelSelection);
  const availableModels = modelCatalog?.models ?? [];
  const selectedModel = availableModels.find(
    (model) =>
      model.id === modelSelection.modelId ||
      model.aliases.includes(modelSelection.modelId),
  );
  const primaryParameter = selectedModel?.parameters.find(
    (parameter) =>
      parameter.prominence === "primary" && parameter.values.length > 1,
  );
  const primaryValue = primaryParameter?.values.find(
    ({ value }) => value === modelSelection.parameters[primaryParameter.id],
  );
  const invalidModelSelection = validation?.valid !== true;
  const invalidModelReason =
    modelSelectionBlockedReason ??
    (validation !== null && !validation.valid
      ? validation.issues.map(({ message }) => message).join(" ")
      : null);
  const chipModelLabel = selectedModel?.label ?? modelSelection.modelId;
  const chipSettingsLabel = [
    invalidModelReason ?? `Model ${chipModelLabel}`,
    primaryParameter && primaryValue
      ? `${primaryParameter.label.toLowerCase()} ${primaryValue.label}`
      : undefined,
  ]
    .filter((label): label is string => Boolean(label))
    .join(", ");
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
          className="mobile-prompt-model-chip inline-flex h-[44px] min-w-0 cursor-pointer items-center gap-xs rounded-sm border border-border-default bg-bg-surface px-[12px] font-mono text-[0.78rem] whitespace-nowrap text-text-primary transition-[border-color,background] duration-150 hover:border-cyan-dim disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setSheet("settings")}
          disabled={isReadOnly || isBusy}
          aria-haspopup="dialog"
          aria-label={chipSettingsLabel}
          data-testid="mobile-prompt-model-chip"
          {...(invalidModelSelection
            ? { "data-invalid-selection": "true", "aria-invalid": true }
            : {})}
        >
          <span
            className={cn(
              "font-semibold",
              invalidModelSelection && "text-[var(--red)]",
            )}
          >
            {chipModelLabel}
          </span>
          {primaryValue ? (
            <>
              <span className="px-2xs text-text-tertiary">·</span>
              <span className="mobile-prompt-model-chip__effort text-text-secondary">
                {primaryValue.label}
              </span>
            </>
          ) : null}
          <span className="ml-xs text-[0.7rem] text-text-tertiary" aria-hidden>
            {"\u25BE"}
          </span>
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-xs">
          {voiceButton}
          {sendButton}
        </div>
      </div>

      <Dialog
        open={sheet === "more"}
        onOpenChange={(next) => !next && closeSheet()}
      >
        <DialogContent
          unstyled
          anchor="stretch"
          scrimClassName={MOBILE_SHEET_SCRIM}
          contentClassName={MOBILE_SHEET_CARD}
          aria-label="More options"
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
                data-tone={backendToneToken(backend)}
                aria-hidden
              >
                {skillTriggerPrefixForBackend(backend)}
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
                    {backendLabel(backend)}
                  </span>
                ) : (
                  <div
                    className="inline-flex overflow-hidden rounded-sm border border-border-default"
                    role="radiogroup"
                    aria-label="Backend"
                  >
                    {catalogBackends.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        role="radio"
                        aria-checked={backend === b.id}
                        className="cursor-pointer border-0 bg-transparent px-[10px] py-[6px] font-mono text-[0.72rem] text-text-secondary transition-[background,color] duration-150 disabled:cursor-not-allowed disabled:opacity-50 data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary data-[active=true]:data-[tone=cyan]:bg-cyan-dim data-[active=true]:data-[tone=violet]:bg-violet-dim data-[active=true]:text-text-inverse"
                        data-active={backend === b.id}
                        data-backend={b.id}
                        data-tone={b.toneToken}
                        onClick={() => onSelectBackend(b.id)}
                        disabled={isBusy || isReadOnly}
                      >
                        {b.label}
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
                aria-busy={debugPending || undefined}
              >
                <span className={MOBILE_PROMPT_ROW_ICON_CLASS} aria-hidden>
                  <span className="size-[6px] shrink-0 rounded-full bg-text-tertiary transition-all duration-200 ease-[ease]" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-2xs">
                  <span className="font-medium text-text-primary">
                    Debug mode
                  </span>
                  <span className="text-[0.7rem] text-text-tertiary">
                    {debugPending
                      ? debugActive
                        ? "Exiting…"
                        : "Entering…"
                      : debugActive
                        ? "Enabled — extra diagnostics"
                        : "Capture extra diagnostics"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-xs">
                  {debugPending && <Spinner size="sm" tone="inherit" />}
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
        </DialogContent>
      </Dialog>

      <Dialog
        open={sheet === "settings"}
        onOpenChange={(next) => !next && closeSheet()}
      >
        <DialogContent
          unstyled
          anchor="stretch"
          scrimClassName={MOBILE_SHEET_SCRIM}
          contentClassName={MOBILE_SHEET_CARD}
          aria-label="Model options"
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
            {invalidModelReason !== null && (
              <div
                data-testid="mobile-prompt-model-invalid"
                role="alert"
                className="p-sm font-mono text-[0.78rem] text-[var(--red)]"
              >
                {invalidModelReason}
              </div>
            )}
            {availableModels.map((option) => {
              const active = option.id === selectedModel?.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={MOBILE_PROMPT_OPTION_CLASS}
                  data-active={active}
                  disabled={isBusy || isReadOnly}
                  onClick={() => {
                    if (modelCatalog === null) return;
                    onModelSelectionChange(
                      defaultSelectionForModel(modelCatalog, option.id),
                    );
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

          <div className="mobile-action-sheet-section px-sm pb-sm">
            <div className="mobile-action-sheet-label px-0">Parameters</div>
            {selectedModel && modelCatalog !== null ? (
              <ModelOptionsEditor
                catalog={modelCatalog}
                selection={modelSelection}
                onApply={(nextSelection) => {
                  onModelSelectionChange(nextSelection);
                  closeSheet();
                }}
                onCancel={closeSheet}
                disabled={isBusy || isReadOnly}
                parameterProminence="all"
                selectContentLayer="popover"
              />
            ) : (
              <p className="p-sm font-mono text-[0.78rem] text-text-tertiary">
                Choose an available model to configure its parameters.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
