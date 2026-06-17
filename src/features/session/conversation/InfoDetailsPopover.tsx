"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import CopyableId from "@/components/CopyableId";
import { shortenWorktreePath } from "@/lib/sessions/worktree-path";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";

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
  if (ref.backend === "claude") return ref.sessionId;
  if (ref.backend === "codex") return ref.threadId;
  return "\u2014";
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
      className={`info-details${open ? " open" : ""}${pinned ? " pinned" : ""}`}
      ref={containerRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        type="button"
        className="info-details-trigger"
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
          className="info-details-popover"
          role="dialog"
          aria-label="Session details"
        >
          <div className="info-details-header">
            <span className="info-details-title">Session details</span>
            {pinned && <span className="info-details-pin">pinned</span>}
          </div>
          <div className="info-details-grid">
            {rows.map((r) => (
              <div key={r.key} className="info-details-row">
                <span className="info-details-label">{r.label}</span>
                {r.copyable ? (
                  <CopyableId
                    value={r.copyValue ?? r.value}
                    displayValue={r.value}
                    className="info-details-copyable"
                    ariaLabel={`Copy ${r.label}`}
                  />
                ) : (
                  <span className="info-details-value" title={r.value}>
                    {r.value}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="info-details-footer">
            {onCopyContext && (
              <button
                type="button"
                className="info-details-link"
                onClick={handleCopyContext}
              >
                {copied === "ctx" ? "Copied \u2713" : "Copy context"}
              </button>
            )}
            {onOpenMcpServers && (
              <button
                type="button"
                className="info-details-link"
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
                className="info-details-link"
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
