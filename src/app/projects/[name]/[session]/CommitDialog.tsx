"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { tracedFetch } from "@/lib/traced-fetch";

interface CommitDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  projectName: string;
  sessionName: string;
}

export default function CommitDialog({
  open,
  onClose,
  onSuccess,
  projectName,
  sessionName,
}: CommitDialogProps): React.JSX.Element | null {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus textarea when opened
  useEffect(() => {
    if (open) {
      setMessage("");
      setError(null);
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open]);

  // Escape key to close
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!message.trim() || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await tracedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commit`,
        "commit-changes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: message.trim() }),
        },
      );

      if (res.ok) {
        onSuccess();
      } else {
        const data = await res.json().catch(() => ({ error: "Commit failed" }));
        setError(data.error || "Commit failed");
      }
    } catch {
      setError("Failed to commit changes");
    } finally {
      setSubmitting(false);
    }
  }, [message, submitting, projectName, sessionName, onSuccess]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Commit Changes</h2>
        <p className="modal-desc">
          Stage all changes and create a commit in the session worktree.
        </p>

        <div className="form-group">
          <label className="form-label">Commit Message</label>
          <textarea
            ref={textareaRef}
            className="form-input"
            rows={3}
            placeholder="Describe your changes..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button
            className="btn btn-sm"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!message.trim() || submitting}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Committing..." : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}
