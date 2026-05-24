"use client";

import { useState, useEffect, useRef } from "react";
import { useCommitMutation } from "@/lib/git/mutations";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const commitMutation = useCommitMutation(projectName, sessionName);

  // Auto-focus textarea when opened
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const handleSubmit = () => {
    if (!message.trim() || commitMutation.isPending) return;
    setError(null);

    commitMutation.mutate(message.trim(), {
      onSuccess: () => {
        onSuccess();
      },
      onError: (err) => {
        setError(err.message);
      },
    });
  };

  if (!open) return null;

  return (
    <div className="modal-overlay">
      <div className="modal">
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
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button
            className="btn btn-sm"
            onClick={onClose}
            disabled={commitMutation.isPending}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!message.trim() || commitMutation.isPending}
            onClick={handleSubmit}
          >
            {commitMutation.isPending ? "Committing..." : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}
