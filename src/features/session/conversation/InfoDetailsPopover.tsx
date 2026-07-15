"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/lib/ui/cn";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import CopyableId from "@/components/CopyableId";
import { shortenWorktreePath } from "@/lib/sessions/worktree-path";
import type { AgentSessionRef } from "@/lib/shared/schemas";

interface InfoDetailsPopoverProps {
  conversationId: string;
  backendRef: AgentSessionRef | null;
  createdAt: string;
  worktreePath: string;
  promptCount: number;
  /** Opens the session-level MCP servers modal. */
  onOpenMcpServers?: () => void;
  /** Opens the agent capabilities config modal. */
  onOpenCapabilities?: () => void;
  /** Copies the full conversation context to clipboard. Returns true on success. */
  onCopyContext?: () => boolean | Promise<boolean>;
}

function formatBackendRef(ref: AgentSessionRef | null): string {
  if (!ref) return "\u2014";
  return ref.ref;
}

function formatCreatedDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface Row {
  key: string;
  label: string;
  value: string;
  copyValue?: string;
  copyable: boolean;
}

const HOVER_OPEN_DELAY_MS = 180;
const HOVER_CLOSE_DELAY_MS = 200;

export default function InfoDetailsPopover({
  conversationId,
  backendRef,
  createdAt,
  worktreePath,
  promptCount,
  onOpenMcpServers,
  onOpenCapabilities,
  onCopyContext,
}: InfoDetailsPopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!pinned) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setPinned(false);
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [pinned]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, []);

  useOverlayScope(pinned, {
    onEscape: () => {
      setPinned(false);
      setOpen(false);
    },
  });

  // Migration deferred (overlay-consumer dispositions): this is a dual-mode
  // panel — hover-to-peek (open on hover with open/close delays, no focus grab)
  // plus click-to-pin — which diverges from the Radix `Popover` primitive's
  // click/focus-managed model (same class of exception as the documented
  // `PeekPopover` in migration-contract §3). Adopting it would drop the
  // hover-peek affordance, so the bespoke open/pinned state + outside-click
  // listener are retained.

  const handleEnter = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  }, []);

  const handleLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (!pinned) {
      hoverTimer.current = setTimeout(
        () => setOpen(false),
        HOVER_CLOSE_DELAY_MS,
      );
    }
  }, [pinned]);

  const togglePin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setPinned((prev) => {
      const next = !prev;
      setOpen(next);
      return next;
    });
  }, []);

  const handleCopyContext = useCallback(() => {
    if (!onCopyContext) return;
    const result = onCopyContext();
    Promise.resolve(result).then((ok) => {
      if (ok) {
        setCopied("ctx");
        setTimeout(() => setCopied(null), 1400);
      }
    });
  }, [onCopyContext]);

  const sessionRefValue = formatBackendRef(backendRef);

  const rows: Row[] = [
    {
      key: "cid",
      label: "Conversation ID",
      value: conversationId,
      copyable: true,
    },
    {
      key: "sref",
      label: "Session ref",
      value: sessionRefValue,
      copyable: sessionRefValue !== "\u2014",
    },
    {
      key: "wt",
      label: "Worktree",
      value: shortenWorktreePath(worktreePath),
      copyValue: worktreePath,
      copyable: true,
    },
    {
      key: "cr",
      label: "Created",
      value: formatCreatedDate(createdAt),
      copyable: false,
    },
    {
      key: "pr",
      label: "Prompts",
      value: String(promptCount),
      copyable: false,
    },
  ];

  return (
    <div
      data-open={open}
      data-pinned={pinned}
      className="group relative shrink-0"
      ref={containerRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        type="button"
        className={cn(
          "inline-flex size-[26px] cursor-pointer items-center justify-center rounded-sm border border-solid border-border-default bg-transparent text-[14px] leading-none text-text-secondary transition-[color,border-color,background,box-shadow] duration-150 ease-[ease]",
          "group-data-[open=false]:hover:border-cyan group-data-[open=false]:hover:text-text-primary",
          "group-data-[open=true]:border-cyan group-data-[open=true]:bg-bg-hover group-data-[open=true]:text-cyan",
          "group-data-[pinned=true]:shadow-[0_0_0_2px_var(--cc-cyan-a18)]",
        )}
        onClick={togglePin}
        title={
          pinned
            ? "Click to unpin details"
            : "Session details (hover to peek, click to pin)"
        }
        aria-expanded={open}
        aria-label="Session details"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="5.6"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle cx="7" cy="4.1" r="0.9" fill="currentColor" />
          <path
            d="M7 6.5v4.2"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div
          className="absolute top-[calc(100%+6px)] right-0 z-panel w-[380px] animate-[info-details-pop-in_0.12s_ease-out] rounded-md border border-solid border-border-default bg-bg-elevated px-0 pt-[10px] pb-[8px] font-mono shadow-dropdown"
          role="dialog"
          // Sanctioned bespoke-overlay survivor (seam-adoption site marker): a
          // NON-MODAL hover-peek/click-pin popover — no focus trap or scrim by
          // design. Deletion condition: a hover-intent ui/Popover trigger
          // variant. The attribute renders as a harmless data-* on the element.
          data-bespoke-overlay-justified=""
          aria-label="Session details"
        >
          <div className="flex items-center gap-[8px] border-x-0 border-t-0 border-b border-solid border-border-default px-[14px] pb-[8px]">
            <span className="font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
              Session details
            </span>
            {pinned && (
              <span className="rounded-full border border-solid border-[var(--cc-cyan-a35)] bg-[var(--cc-cyan-a06)] px-[6px] py-px font-mono text-[0.62rem] tracking-[0.06em] text-cyan uppercase">
                pinned
              </span>
            )}
          </div>
          <div className="px-[6px] py-[8px]">
            {rows.map((r) => (
              <div
                key={r.key}
                className="grid grid-cols-[110px_1fr] items-center gap-[8px] rounded-sm px-[10px] py-[6px] hover:bg-bg-hover"
              >
                <span className="font-mono text-[0.66rem] tracking-[0.06em] text-text-tertiary uppercase">
                  {r.label}
                </span>
                {r.copyable ? (
                  <CopyableId
                    value={r.copyValue ?? r.value}
                    displayValue={r.value}
                    ariaLabel={`Copy ${r.label}`}
                    className="min-w-0"
                    valueClassName="min-w-0 flex-1 truncate"
                  />
                ) : (
                  <span
                    className="overflow-hidden font-mono text-[0.72rem] text-ellipsis whitespace-nowrap text-text-primary"
                    title={r.value}
                  >
                    {r.value}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-[6px] flex flex-wrap gap-[4px] border-x-0 border-t border-b-0 border-solid border-border-default px-[14px] pt-[10px] pb-0">
            {onCopyContext && (
              <button
                type="button"
                className="cursor-pointer rounded-sm border border-solid border-border-default bg-transparent px-[10px] py-[4px] font-mono text-[0.66rem] text-text-secondary transition-all duration-150 ease-[ease] hover:border-cyan hover:bg-bg-hover hover:text-cyan"
                onClick={handleCopyContext}
              >
                {copied === "ctx" ? "Copied \u2713" : "Copy context"}
              </button>
            )}
            {onOpenMcpServers && (
              <button
                type="button"
                className="cursor-pointer rounded-sm border border-solid border-border-default bg-transparent px-[10px] py-[4px] font-mono text-[0.66rem] text-text-secondary transition-all duration-150 ease-[ease] hover:border-cyan hover:bg-bg-hover hover:text-cyan"
                onClick={() => {
                  setPinned(false);
                  setOpen(false);
                  onOpenMcpServers();
                }}
              >
                MCP servers…
              </button>
            )}
            {onOpenCapabilities && (
              <button
                type="button"
                className="cursor-pointer rounded-sm border border-solid border-border-default bg-transparent px-[10px] py-[4px] font-mono text-[0.66rem] text-text-secondary transition-all duration-150 ease-[ease] hover:border-cyan hover:bg-bg-hover hover:text-cyan"
                onClick={() => {
                  setPinned(false);
                  setOpen(false);
                  onOpenCapabilities();
                }}
              >
                Agent capabilities…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
