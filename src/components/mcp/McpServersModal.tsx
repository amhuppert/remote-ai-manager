"use client";

import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import McpServerList from "./McpServerList";
import type {
  McpServerCardActions,
  McpServerView,
  McpViewLevel,
} from "./types";

interface McpServersModalProps {
  open: boolean;
  onClose(): void;
  /** View level for inheritance labelling (project | session). */
  viewLevel: Exclude<McpViewLevel, "global" | "conversation">;
  servers: McpServerView[];
  actions: McpServerCardActions;
  /** Headline shown at the top of the modal (e.g. "Session MCP configuration"). */
  title: string;
  /** Sub-headline giving context (e.g. the project or session name). */
  subtitle?: string;
  /** Optional banner (e.g. "Changes apply to next turn in active conversations"). */
  banner?: React.ReactNode;
}

export default function McpServersModal({
  open,
  onClose,
  viewLevel,
  servers,
  actions,
  title,
  subtitle,
  banner,
}: McpServersModalProps): React.JSX.Element | null {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKey, { capture: true });
    return () =>
      document.removeEventListener("keydown", handleKey, { capture: true });
  }, [open, handleKey]);

  useOverlayScope(open);

  // Migration deferred (primitive-migration contract §1 / overlay-consumer
  // dispositions): the shipped `ui/Dialog` primitive's `DialogContent` bakes the
  // standard padded, centred card recipe (`p-xl`, max-w 480, motion). This modal
  // is a borderless `p-0 flex flex-col overflow-hidden` scrollable card with a
  // full-bleed sticky bordered header + a ≤640px full-screen variant — a box
  // model `DialogContent` does not model, so adopting it would change the
  // appearance and fail the parity criterion. Migrating cleanly requires a future
  // unstyled-content escape hatch on the Dialog primitive (out of this
  // consumer-migration context's scope); the Radix focus-trap/scroll-lock win is
  // worth that follow-up. Until then the bespoke keydown/outside-click stays.

  if (!open || typeof document === "undefined") return null;

  const total = servers.length;
  const on = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter(
    (s) => s.status.kind === "overridden" || s.status.kind === "disabled",
  ).length;

  const overlay = (
    <div
      // Marks this full-viewport blur scrim so the global ambient-animation
      // freeze (globals.css) pauses the page's perpetual status-dot animations
      // while it is mounted — otherwise the backdrop blur re-rasterizes every
      // frame behind them and saturates the compositor.
      data-cc-modal-scrim=""
      className="fixed inset-0 z-dropdown flex animate-[fadeIn_0.15s_ease] items-center justify-center bg-[var(--cc-overlay-scrim)] backdrop-blur-[8px] max-768:items-end"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Self-contained modal card: reproduces the standard CC modal-card
          appearance plus this modal's 720px / padding-0 / flex-column box model
          and the ≤768px bottom-sheet / ≤640px full-screen behaviour as utilities.
          The fixed `DialogContent` recipe cannot host this box model (see above),
          so the card is hand-rolled until the unstyled-content escape hatch lands. */}
      <div
        className="flex max-h-[min(800px,calc(100vh-4rem))] w-[min(720px,calc(100vw-2rem))] max-w-[480px] animate-[slideUp_0.2s_ease] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-solid border-border-default bg-bg-surface max-640:h-screen max-640:max-h-screen max-640:w-screen max-640:rounded-none max-768:max-w-full max-768:animate-[slideUpSheet_0.25s_ease] max-768:rounded-b-none"
        role="dialog"
        aria-label={title}
      >
        <header className="flex items-start gap-md border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-surface px-lg py-md">
          <div className="flex min-w-0 flex-1 flex-col gap-[0.15rem]">
            <span className="font-mono text-[0.7rem] font-bold tracking-[0.12em] text-[var(--accent-cyan)]">
              {viewLevel.toUpperCase()}
            </span>
            <h2 className="m-0 font-mono text-[1rem] font-semibold text-text-primary">
              {title}
            </h2>
            {subtitle ? (
              <span className="font-mono text-[0.72rem] text-[var(--text-muted)]">
                {subtitle}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-sm">
            <span className="font-mono text-[0.72rem] text-text-secondary">
              <strong>{on}</strong>/{total} enabled
            </span>
            {overrides > 0 ? (
              <span className="font-mono text-[0.72rem] text-[var(--accent-cyan)]">
                <strong>{overrides}</strong> override
                {overrides === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="cursor-pointer appearance-none rounded-[3px] border-0 bg-transparent px-[0.5rem] py-[0.2rem] text-[1.4rem] leading-none text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {banner ? (
          <div className="border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-surface px-lg py-xs font-mono text-[0.72rem] text-[var(--text-muted)]">
            {banner}
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-lg pt-md pb-lg">
          <McpServerList
            viewLevel={viewLevel}
            servers={servers}
            actions={actions}
          />
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
