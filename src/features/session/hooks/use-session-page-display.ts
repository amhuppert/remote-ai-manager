"use client";

import type { DerivedSessionStatus } from "@/lib/sessions/schemas";

export interface UseSessionPageDisplayArgs {
  projectName: string;
  isFinished: boolean;
  pendingQuestions: unknown;
  sending: boolean;
  sessionStatus: DerivedSessionStatus;
}

export interface SessionPageDisplay {
  decodedProjectName: string;
  displayStatus: string;
  statusDotClass: string;
}

export function useSessionPageDisplay({
  projectName,
  isFinished,
  pendingQuestions,
  sending,
  sessionStatus,
}: UseSessionPageDisplayArgs): SessionPageDisplay {
  const decodedProjectName = decodeURIComponent(projectName);
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
    displayStatus,
    statusDotClass,
  };
}
