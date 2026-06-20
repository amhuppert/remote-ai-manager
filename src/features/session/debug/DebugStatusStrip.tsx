"use client";

import { cn } from "@/lib/ui/cn";
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
      data-recording={isRecording ? "on" : "off"}
      className={cn(
        "flex flex-col gap-[6px] rounded-sm border-y border-r border-l-[3px] border-solid px-sm py-[6px] font-mono text-[0.7rem]",
        "data-[recording=on]:border-y-[var(--cc-amber-a20)] data-[recording=on]:border-r-[var(--cc-amber-a20)] data-[recording=on]:border-l-amber data-[recording=on]:bg-[var(--cc-amber-a04)]",
        "data-[recording=off]:border-y-[var(--cc-amber-a45)] data-[recording=off]:border-r-[var(--cc-amber-a45)] data-[recording=off]:border-l-[var(--cc-amber-a45)] data-[recording=off]:bg-[var(--cc-amber-a09)]",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-sm">
          <span className="font-bold tracking-[0.06em] text-amber uppercase">
            DEBUG
          </span>
          <div className="h-[14px] w-px shrink-0 bg-[var(--cc-amber-a20)]" />
          <button
            type="button"
            data-recording={isRecording ? "on" : "off"}
            className={cn(
              "group/rec flex items-center gap-[6px] rounded-sm border-none bg-transparent px-[8px] py-[2px] font-mono text-[0.7rem] font-semibold text-text-tertiary transition-all duration-150 ease-[ease]",
              "hover:bg-bg-hover data-[recording=off]:hover:text-text-secondary",
              "data-[recording=on]:text-red",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
            onClick={() => recordingMutation.mutate(!isRecording)}
            disabled={anyPending}
            data-tooltip={isRecording ? "Pause recording" : "Resume recording"}
          >
            <span className="size-[8px] shrink-0 rounded-full bg-text-tertiary transition-all duration-200 ease-[ease] group-data-[recording=on]/rec:animate-[debug-rec-pulse_1.5s_ease-in-out_infinite] group-data-[recording=on]/rec:bg-red group-data-[recording=on]/rec:shadow-[0_0_6px_var(--color-red)]" />
            <span>{isRecording ? "REC" : "PAUSED"}</span>
          </button>
        </div>
        <div className="flex items-center gap-sm">
          <span className="text-text-tertiary tabular-nums">
            {entryCount} {entryCount === 1 ? "entry" : "entries"}
          </span>
          <div className="h-[14px] w-px shrink-0 bg-[var(--cc-amber-a20)]" />
          <button
            type="button"
            className="rounded-sm border border-solid border-border-subtle bg-transparent px-[8px] py-[2px] font-mono text-[0.7rem] font-medium text-text-tertiary transition-all duration-150 ease-[ease] hover:border-border-default hover:bg-bg-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
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
          className="rounded-sm bg-[var(--cc-amber-a18)] px-[8px] py-[4px] font-semibold tracking-[0.02em] text-amber"
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
