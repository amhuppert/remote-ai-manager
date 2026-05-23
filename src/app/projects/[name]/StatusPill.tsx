"use client";

import type { DerivedSessionStatus } from "@/types";

export type StatusPillStatus = DerivedSessionStatus | "merged" | "error";

interface StatusPillProps {
  status: StatusPillStatus;
}

function displayLabel(status: StatusPillStatus): string {
  // "waiting_for_input" surfaces in the UI as "awaiting"; CSS keeps the data-status raw.
  if (status === "waiting_for_input") return "awaiting";
  return status;
}

export default function StatusPill({
  status,
}: StatusPillProps): React.JSX.Element {
  return (
    <span className="s-status" data-status={status}>
      <span className="dot" />
      <span>{displayLabel(status)}</span>
    </span>
  );
}
