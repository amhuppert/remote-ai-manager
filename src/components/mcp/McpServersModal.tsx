"use client";

import { Dialog, DialogContent } from "@/components/ui/Dialog";
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
  if (!open) return null;

  const total = servers.length;
  const on = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter(
    (s) => s.status.kind === "overridden" || s.status.kind === "disabled",
  ).length;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* The scrim, centring, Portal, focus trap, scroll-lock, and Escape/
          outside-press dismissal come from the primitive; `unstyled` lets this
          modal keep its own borderless `p-0 flex-column` scrollable box model
          (a full-bleed sticky bordered header + ≤640px full-screen variant) that
          the padded card recipe does not model. `mobileSheet` docks it as a
          bottom sheet below 768px. */}
      <DialogContent
        unstyled
        mobileSheet
        aria-label={title}
        contentClassName="flex max-h-[min(800px,calc(100vh-4rem))] w-[min(720px,calc(100vw-2rem))] max-w-[480px] motion-safe:animate-[slideUp_0.2s_ease] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-solid border-border-default bg-bg-surface max-640:h-screen max-640:max-h-screen max-640:w-screen max-640:rounded-none max-768:max-w-full max-768:motion-safe:animate-[slideUpSheet_0.25s_ease] max-768:rounded-b-none"
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
      </DialogContent>
    </Dialog>
  );
}
