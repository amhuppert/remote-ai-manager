"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useCreateSessionMutation } from "@/lib/mutations";

interface CreateSessionModalProps {
  projectName: string;
  open: boolean;
  onClose: () => void;
}

export default function CreateSessionModal({
  projectName,
  open,
  onClose,
}: CreateSessionModalProps): React.JSX.Element | null {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const createMutation = useCreateSessionMutation(projectName);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const sanitizedBranch = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const handleSubmit = () => {
    if (!name.trim() || createMutation.isPending) return;
    setError(null);

    createMutation.mutate(name.trim(), {
      onSuccess: (session) => {
        onClose();
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`,
        );
      },
      onError: (err) => {
        setError(err.message);
      },
    });
  };

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-title">New Session</div>
        <div className="form-group">
          <label className="form-label" htmlFor="session-name-input">
            Session Name
          </label>
          <input
            ref={inputRef}
            id="session-name-input"
            className="form-input"
            type="text"
            placeholder="e.g. implement-auth"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          {sanitizedBranch && (
            <div className="form-hint">Branch: csm/{sanitizedBranch}</div>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-actions">
          <button
            className="btn btn-sm"
            onClick={onClose}
            disabled={createMutation.isPending}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!name.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
