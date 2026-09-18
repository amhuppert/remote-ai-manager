import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type {
  TicketChildStatusCount,
  TicketStatus,
} from "@/lib/tickets/schemas";
import {
  TICKET_STATUS_ORDER,
  TICKET_STATUS_VISUALS,
} from "@/lib/tickets/ticket-visuals";

const STATUS_TONES: Record<TicketStatus, StatusChipTone> = {
  not_started: "neutral",
  in_progress: "cyan",
  done: "green",
  blocked: "red",
  closed: "neutral",
};

export function TicketChildSummary({
  counts,
}: {
  counts?: TicketChildStatusCount[];
}): React.JSX.Element | null {
  if (!counts?.length) return null;
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const done = counts.find((entry) => entry.status === "done")?.count ?? 0;
  return (
    <span
      role="group"
      aria-label="Child ticket status"
      className="flex min-w-0 flex-col gap-xs font-mono text-[0.7rem]"
    >
      <span className="flex flex-wrap items-center gap-x-sm gap-y-2xs text-text-secondary">
        <span className="inline-flex items-center gap-xs">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3 2v9a2 2 0 0 0 2 2h4M3 5h6M9 3h4v4H9zM9 11h4v4H9z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          {total} {total === 1 ? "child" : "children"}
        </span>
        <span className="text-text-tertiary">
          {done} of {total} done
        </span>
      </span>
      <span className="flex flex-wrap gap-xs">
        {TICKET_STATUS_ORDER.map((status) => {
          const entry = counts.find((candidate) => candidate.status === status);
          if (!entry) return null;
          return (
            <StatusChip key={status} tone={STATUS_TONES[status]}>
              {entry.count} {TICKET_STATUS_VISUALS[status].label}
            </StatusChip>
          );
        })}
      </span>
    </span>
  );
}
