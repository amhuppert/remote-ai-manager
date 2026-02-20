"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useMergeMutation } from "@/lib/mutations";

interface MergeDialogProps {
  open: boolean;
  onClose: () => void;
  projectName: string;
  sessionName: string;
  branchName: string;
  commitCount: number;
}

export default function MergeDialog({
  open,
  onClose,
  projectName,
  sessionName,
  branchName,
  commitCount,
}: MergeDialogProps): React.JSX.Element | null {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mergeMutation = useMergeMutation(projectName, sessionName);

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

  const handleSubmit = () => {
    if (!message.trim() || mergeMutation.isPending) return;
    setError(null);

    mergeMutation.mutate(message.trim(), {
      onSuccess: () => {
        onClose();
        router.push(`/projects/${encodeURIComponent(projectName)}`);
      },
      onError: (err) => {
        setError(err.message);
      },
    });
  };

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
            disabled={mergeMutation.isPending}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!message.trim() || mergeMutation.isPending}
            onClick={handleSubmit}
          >
            {mergeMutation.isPending ? "Merging..." : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}
