"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { tracedFetch } from "@/lib/traced-fetch";

interface MergeDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  projectName: string;
  sessionName: string;
  branchName: string;
  commitCount: number;
}

export default function MergeDialog({
  open,
  onClose,
  onSuccess,
  projectName,
  sessionName,
  branchName,
  commitCount,
}: MergeDialogProps): React.JSX.Element | null {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset and pre-fill when opened
  useEffect(() => {
    if (open) {
      setMessage(sessionName);
      setError(null);
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open, sessionName]);

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
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/merge`,
        "merge-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: message.trim() }),
        },
      );

      if (res.ok) {
        onSuccess();
      } else {
        const data = await res
          .json()
          .catch(() => ({ error: "Merge failed" }));
        setError(data.error || "Merge failed");
      }
    } catch {
      setError("Failed to merge session");
    } finally {
      setSubmitting(false);
    }
  }, [message, submitting, projectName, sessionName, onSuccess]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Merge into Main</h2>
        <p className="modal-desc">
          Squash merge all commits from this session branch into{" "}
          <code>main</code>. The session will be marked as finished and
          archived.
        </p>

        <div className="merge-info">
          <div className="merge-info-row">
            <span className="merge-info-label">Branch</span>
            <span className="merge-info-value">{branchName}</span>
          </div>
          <div className="merge-info-row">
            <span className="merge-info-label">Commits</span>
            <span className="merge-info-value">{commitCount}</span>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Merge Commit Message</label>
          <textarea
            ref={textareaRef}
            className="form-input"
            rows={3}
            placeholder="Describe this merge..."
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
          <button className="btn btn-sm" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!message.trim() || submitting}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Merging..." : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}
