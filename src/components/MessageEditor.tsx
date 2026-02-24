"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface MessageEditorProps {
  /** The original text content of the user message */
  originalText: string;
  /** The 0-based message index */
  messageIndex: number;
  /** Called with the edited text to fork from this message */
  onSave: (messageIndex: number, newText: string) => void;
  /** Called when user cancels editing */
  onCancel: () => void;
  /** Whether the save operation is in progress */
  saving?: boolean;
}

/**
 * Inline editor that replaces a user message's content for editing.
 * On save, the parent triggers a conversation fork with the modified message.
 */
export default function MessageEditor({
  originalText,
  messageIndex,
  onSave,
  onCancel,
  saving = false,
}: MessageEditorProps) {
  const [text, setText] = useState(originalText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasChanged = text.trim() !== originalText.trim();

  // Auto-focus and select the textarea on mount
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const handleSave = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSave(messageIndex, trimmed);
  }, [text, messageIndex, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      // Ctrl/Cmd + Enter to save
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      }
    },
    [onCancel, handleSave],
  );

  return (
    <div className="msg-editor">
      <div className="msg-editor-hint">
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="3"
            cy="2.5"
            r="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle
            cx="3"
            cy="9.5"
            r="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle
            cx="9"
            cy="4.5"
            r="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M3 4V8M3 5.5C3 5.5 3 4.5 5.5 4.5H7.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
        Edit &amp; fork from turn {Math.floor(messageIndex / 2) + 1}
      </div>
      <textarea
        ref={textareaRef}
        className="msg-editor-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        disabled={saving}
        placeholder="Enter your message..."
      />
      <div className="msg-editor-actions">
        <span className="msg-editor-shortcut">
Ctrl+Enter to save
        </span>
        <div className="msg-editor-buttons">
          <button
            className="btn btn-sm"
            onClick={onCancel}
            disabled={saving}
            type="button"
          >
            Cancel
          </button>
          <button
            className="btn btn-sm msg-editor-save"
            onClick={handleSave}
            disabled={saving || text.trim().length === 0}
            type="button"
          >
            {saving ? "Forking..." : hasChanged ? "Save & Fork" : "Fork"}
          </button>
        </div>
      </div>
    </div>
  );
}
