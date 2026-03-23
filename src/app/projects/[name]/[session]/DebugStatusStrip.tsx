"use client";

import {
  useDebugRecordingMutation,
  useClearDebugLogsMutation,
} from "@/lib/mutations";
import type { ConversationState } from "@/types";

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

  if (!debugMode?.active) return null;

  const anyPending = recordingMutation.isPending || clearLogsMutation.isPending;

  return (
    <div className="debug-status-strip">
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
  );
}
