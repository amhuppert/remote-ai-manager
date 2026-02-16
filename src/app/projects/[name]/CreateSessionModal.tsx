"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { tracedFetch } from "@/lib/traced-fetch";

interface CreateSessionModalProps {
  projectName: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateSessionModal({
  projectName,
  open,
  onClose,
  onCreated,
}: CreateSessionModalProps): React.JSX.Element | null {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      // Delay focus to after animation
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

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || creating) return;

    setError(null);
    setCreating(true);

    try {
      const res = await tracedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions`,
        "create-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionName: name.trim() }),
        },
      );

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Failed to create session");
        return;
      }

      onCreated();
      onClose();
    } catch {
      setError("Network error — could not create session");
    } finally {
      setCreating(false);
    }
  }, [name, creating, projectName, onCreated, onClose]);

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
                void handleSubmit();
              }
            }}
          />
          {sanitizedBranch && (
            <div className="form-hint">Branch: csm/{sanitizedBranch}</div>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void handleSubmit()}
            disabled={!name.trim() || creating}
          >
            {creating ? "Creating..." : "Create Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
