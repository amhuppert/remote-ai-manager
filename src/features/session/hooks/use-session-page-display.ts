"use client";

import type { DerivedSessionStatus } from "@/lib/sessions/schemas";

export interface UseSessionPageDisplayArgs {
  projectName: string;
  isFinished: boolean;
  isReadOnly: boolean;
  isBusy: boolean;
  hasUncommittedChanges: boolean;
  pendingQuestions: unknown;
  sending: boolean;
  sessionStatus: DerivedSessionStatus;
}

export interface SessionPageDisplay {
  decodedProjectName: string;
  commitDisabled: boolean;
  mergeDisabled: boolean;
  displayStatus: string;
  statusDotClass: string;
}

export function useSessionPageDisplay({
  projectName,
  isFinished,
  isReadOnly,
  isBusy,
  hasUncommittedChanges,
  pendingQuestions,
  sending,
  sessionStatus,
}: UseSessionPageDisplayArgs): SessionPageDisplay {
  const decodedProjectName = decodeURIComponent(projectName);
  const commitDisabled = !hasUncommittedChanges || isBusy || isReadOnly;
  const mergeDisabled = isBusy || isReadOnly;
  const displayStatus = isFinished
    ? "merged"
    : pendingQuestions
      ? "waiting_for_input"
      : sending
        ? "running"
        : sessionStatus;
  const statusDotClass =
    displayStatus === "running"
      ? "cyan"
      : displayStatus === "merged"
        ? "green"
        : displayStatus === "waiting_for_input"
          ? "amber"
          : "";

  return {
    decodedProjectName,
    commitDisabled,
    mergeDisabled,
    displayStatus,
    statusDotClass,
  };
}
