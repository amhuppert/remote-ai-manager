"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useMergeMutation } from "@/lib/mutations";
import type { ApiCallError } from "@/lib/mutations";

interface MergeDialogProps {
  open: boolean;
  onClose: () => void;
  projectName: string;
  sessionName: string;
  branchName: string;
  commitCount: number;
  targetBranch?: string;
  /** Pre-populate error state (for Storybook / testing) */
  defaultError?: string;
  /** Pre-populate terminal output (for Storybook / testing) */
  defaultOutput?: string;
}

export default function MergeDialog({
  open,
  onClose,
  projectName,
  sessionName,
  branchName,
  commitCount,
  targetBranch = "main",
  defaultError,
  defaultOutput,
}: MergeDialogProps): React.JSX.Element | null {
  const router = useRouter();
  const [error, setError] = useState<string | null>(defaultError ?? null);
  const [output, setOutput] = useState<string | null>(defaultOutput ?? null);

  const mergeMutation = useMergeMutation(projectName, sessionName);

  // Track previous open value to detect closed→open transition
  const prevOpenRef = useRef(open);

  // Reset only when dialog transitions from closed to open
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on closed→open transition */
      setError(null);
      setOutput(null);
      /* eslint-enable react-hooks/set-state-in-effect */
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
    if (mergeMutation.isPending) return;
    setError(null);
    setOutput(null);

    mergeMutation.mutate(undefined, {
      onSuccess: () => {
        onClose();
        router.push(`/projects/${encodeURIComponent(projectName)}`);
      },
      onError: (err) => {
        setError(err.message);
        const apiErr = err as ApiCallError;
        setOutput(apiErr.output ?? null);
      },
    });
  };

  if (!open) return null;

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2 className="modal-title">Merge into {targetBranch}</h2>
        <p className="modal-desc">
          Squash merge all commits from this session branch into{" "}
          <code>{targetBranch}</code>. The session will be marked as finished
          and archived.
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

        {error && (
          <div className="merge-error-banner">
            <div className="merge-error-title">{error}</div>
            {output && <pre className="merge-error-output">{output}</pre>}
          </div>
        )}

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
            disabled={mergeMutation.isPending}
            onClick={handleSubmit}
          >
            {mergeMutation.isPending ? "Merging..." : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}
