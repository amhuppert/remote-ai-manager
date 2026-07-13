"use client";

import { useRef, useState } from "react";
import {
  MultilineInput,
  runMultilinePrimaryAction,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import type { ConflictDecisionInput, ConflictEntry } from "@/lib/jobs/schemas";
import { Spinner } from "@/components/ui/Spinner";

export interface JoinConflictRecoveryCardProps {
  conflictFiles: string[];
  /** Per-file analysis persisted from the failed resolution attempt. */
  analysis: ConflictEntry[] | null;
  /** Retry the join merge; guidance entries exist only for files the operator
   *  annotated. An empty array retries without guidance. */
  onRetry(guidance: ConflictDecisionInput[]): void;
  isRetrying: boolean;
  disabled: boolean;
}

export default function JoinConflictRecoveryCard({
  conflictFiles,
  analysis,
  onRetry,
  isRetrying,
  disabled,
}: JoinConflictRecoveryCardProps) {
  const [feedbackByFile, setFeedbackByFile] = useState<Record<string, string>>(
    {},
  );
  const feedbackActionRefs = useRef<
    Map<string, MultilineInputActionHandle | null>
  >(new Map());

  const analysisByFile = new Map(
    (analysis ?? []).map((entry) => [entry.file, entry]),
  );

  const handleRetry = (feedbackOverride?: { file: string; value: string }) => {
    const guidance: ConflictDecisionInput[] = conflictFiles
      .map((file) => ({
        file,
        feedback:
          feedbackOverride?.file === file
            ? feedbackOverride.value.trim()
            : (feedbackByFile[file] ?? "").trim(),
      }))
      .filter((entry) => entry.feedback.length > 0)
      .map((entry) => ({
        file: entry.file,
        decision: "rejected" as const,
        feedback: entry.feedback,
      }));
    onRetry(guidance);
  };

  return (
    <div className="mt-[6px] flex basis-full flex-col gap-[8px] rounded-sm border border-border-default bg-bg-raised px-md py-sm text-[0.74rem] leading-[1.45] text-text-secondary">
      <div className="text-[0.78rem] font-semibold text-text-primary">
        Retry automatic conflict resolution
      </div>
      <ul className="m-0 flex list-none flex-col gap-[8px] p-0">
        {conflictFiles.map((file) => {
          const entry = analysisByFile.get(file);
          return (
            <li key={file} className="flex flex-col gap-[4px]">
              <span className="font-mono text-[0.7rem] text-amber">{file}</span>
              {entry && (
                <div className="text-[0.72rem] text-text-secondary">
                  <p className="m-0">{entry.description}</p>
                  <p className="m-0 text-text-tertiary">
                    Attempted: {entry.resolution} — {entry.rationale}
                  </p>
                </div>
              )}
              <MultilineInput
                aria-label={`Guidance for ${file}`}
                className="min-h-[32px] w-full resize-y rounded-sm border border-border-default bg-bg-surface p-[6px] font-[inherit] text-[0.72rem] text-text-primary placeholder:text-text-tertiary"
                placeholder="Optional guidance for the resolver (e.g. which side wins, how to combine)"
                value={feedbackByFile[file] ?? ""}
                onValueChange={(value) =>
                  setFeedbackByFile((prev) => ({
                    ...prev,
                    [file]: value,
                  }))
                }
                onPrimaryAction={(value) => handleRetry({ file, value })}
                actionRef={(handle) => {
                  if (handle) feedbackActionRefs.current.set(file, handle);
                  else feedbackActionRefs.current.delete(file);
                }}
                disabled={disabled}
              />
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-sm">
        <button
          type="button"
          className="inline-flex h-[24px] cursor-pointer items-center justify-center gap-[6px] rounded-sm border border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a12)] px-[10px] py-[3px] text-[0.7rem] font-medium whitespace-nowrap text-cyan transition-all duration-150 hover:bg-[var(--cc-cyan-a20)] disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() =>
            runMultilinePrimaryAction(
              feedbackActionRefs.current.values(),
              handleRetry,
            )
          }
          disabled={disabled}
          aria-busy={isRetrying || undefined}
        >
          {isRetrying ? (
            <>
              <Spinner size="sm" tone="inherit" />
              Retrying…
            </>
          ) : (
            "Retry merge"
          )}
        </button>
        <span className="text-[0.7rem] text-text-tertiary italic">
          Or resolve and commit the merge in the lane worktree, then Resume.
        </span>
      </div>
    </div>
  );
}
