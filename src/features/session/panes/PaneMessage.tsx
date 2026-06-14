"use client";

import type { TranscriptMessage } from "@/lib/conversations/schemas";
import { summarizeMessage } from "./pane-view-model";

export interface PaneMessageProps {
  message: TranscriptMessage;
  compact: boolean;
}

export default function PaneMessage({
  message,
  compact,
}: PaneMessageProps): React.JSX.Element {
  const { role, text, tool } = summarizeMessage(message);

  return (
    <div
      className="pane-message"
      data-role={role}
      data-compact={compact ? "true" : undefined}
    >
      <span className="pane-message__role" aria-hidden="true">
        {role}
      </span>
      <div className="pane-message__body">
        {text && <span className="pane-message__text">{text}</span>}
        {tool && (
          <span className="pane-message__tool">
            <span className="pane-message__tool-name">{tool.name}</span>
            {tool.detail && (
              <span className="pane-message__tool-detail">{tool.detail}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
