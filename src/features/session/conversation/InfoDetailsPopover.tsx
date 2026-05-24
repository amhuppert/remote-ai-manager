"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
interface InfoDetailsPopoverProps {
  conversationId: string;
  backendRef: AgentSessionRef | null;
  createdAt: string;
  worktreePath: string;
  /** Opens the session-level MCP servers modal. */
  onOpenMcpServers?: () => void;
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

interface CopyableRowProps {
  label: string;
  value: string;
  copyable?: boolean;
}

function CopyableRow({ label, value, copyable = true }: CopyableRowProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!copyable || value === "\u2014") return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [copyable, value]);

  return (
    <div className="info-popover-row">
      <span className="info-popover-label">{label}</span>
      <span className="info-popover-val">{value}</span>
      {copyable && value !== "\u2014" && (
        <button
          className="info-popover-copy"
          onClick={handleCopy}
          aria-label={`Copy ${label}`}
        >
          {copied ? "\u2713" : "\u2398"}
        </button>
      )}
    </div>
  );
}

export default function InfoDetailsPopover({
  conversationId,
  backendRef,
  createdAt,
  worktreePath,
  onOpenMcpServers,
}: InfoDetailsPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  return (
    <div className="info-details-trigger" ref={containerRef}>
      <button
        className="si-info-btn"
        onClick={toggle}
        aria-label="Session details"
        aria-expanded={open}
      >
        &#x24D8;
      </button>
      {open && (
        <div className="info-popover" onClick={(e) => e.stopPropagation()}>
          <CopyableRow label="Conversation ID" value={conversationId} />
          <CopyableRow
            label="Session Ref"
            value={formatBackendRef(backendRef)}
          />
          <CopyableRow
            label="Created"
            value={formatCreatedDate(createdAt)}
            copyable={false}
          />
          <CopyableRow label="Worktree" value={worktreePath} />
          {onOpenMcpServers && (
            <div className="info-popover-row">
              <span className="info-popover-label">MCP Servers</span>
              <button
                type="button"
                className="info-popover-link"
                onClick={() => {
                  setOpen(false);
                  onOpenMcpServers();
                }}
              >
                Configure…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
