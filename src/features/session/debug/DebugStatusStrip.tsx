"use client";

import {
  useDebugRecordingMutation,
  useClearDebugLogsMutation,
} from "@/lib/debug-log/mutations";
import { useDebugLogEntryCountQuery } from "@/lib/debug-log/queries";
import type { ConversationState } from "@/lib/conversations/schemas";
interface DebugStatusStripProps {
  projectName: string;
  sessionName: string;
  conversation: ConversationState;
}

export default function DebugStatusStrip({
  projectName,
  sessionName,
  conversation,
}: DebugStatusStripProps): React.JSX.Element | null {
  const recordingMutation = useDebugRecordingMutation(
    projectName,
    sessionName,
    conversation.id,
  );
  const clearLogsMutation = useClearDebugLogsMutation(
    projectName,
    sessionName,
    conversation.id,
  );

  const debugMode = conversation.debugMode;
  const isRecording = debugMode?.recording ?? false;
  const isActive = debugMode?.active ?? false;

  const entryCountQuery = useDebugLogEntryCountQuery(
    projectName,
    sessionName,
    conversation.id,
    isActive,
  );

  if (!isActive) return null;

  const anyPending = recordingMutation.isPending || clearLogsMutation.isPending;
  const entryCount = entryCountQuery.data ?? 0;

  return (
    <div
      className={`debug-status-strip${isRecording ? "" : " paused"}`}
      data-recording={isRecording ? "on" : "off"}
    >
      <div className="debug-status-strip__row">
        <div className="debug-status-strip__left">
          <span className="debug-status-strip__badge">DEBUG</span>
          <div className="debug-status-strip__sep" />
          <button
            type="button"
            className={`debug-status-strip__rec${isRecording ? " recording" : ""}`}
            onClick={() => recordingMutation.mutate(!isRecording)}
            disabled={anyPending}
            data-tooltip={isRecording ? "Pause recording" : "Resume recording"}
          >
            <span className="debug-status-strip__rec-dot" />
            <span>{isRecording ? "REC" : "PAUSED"}</span>
          </button>
        </div>
        <div className="debug-status-strip__right">
          <span className="debug-status-strip__entry-count">
            {entryCount} {entryCount === 1 ? "entry" : "entries"}
          </span>
          <div className="debug-status-strip__sep" />
          <button
            type="button"
            className="debug-status-strip__clear"
            onClick={() => clearLogsMutation.mutate()}
            disabled={anyPending}
            data-tooltip="Clear debug log entries"
          >
            Clear
          </button>
        </div>
      </div>
      {!isRecording && (
        <div
          className="debug-status-strip__paused-banner"
          role="status"
          aria-live="polite"
        >
          PAUSED — new debug log entries are being dropped until recording is
          resumed.
        </div>
      )}
    </div>
  );
}
