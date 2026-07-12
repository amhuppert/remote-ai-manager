/**
 * Static visual maps for ticket status and work type per the Claude Design
 * handoff (§2 status & type visual language). Static records — mirroring
 * StatusPill's approach — keep every class literal scannable by Tailwind and
 * avoid `data-[status=…]` variants, whose underscores rewrite to spaces.
 */

import type { TicketStatus, TicketWorkType } from "@/lib/tickets/schemas";

export interface TicketStatusVisual {
  label: string;
  /** Uppercase mono label colour. */
  text: string;
  /** 6px status dot: fill + glow (+ pulse while in progress). */
  dot: string;
  /** 3px row rail: fill + opacity (+ glow for the loud states). */
  rail: string;
}

export const TICKET_STATUS_VISUALS: Record<TicketStatus, TicketStatusVisual> = {
  not_started: {
    label: "Not Started",
    text: "text-text-secondary",
    dot: "bg-text-tertiary",
    rail: "bg-text-tertiary opacity-[0.25]",
  },
  in_progress: {
    label: "In Progress",
    text: "text-cyan",
    dot: "bg-cyan shadow-[0_0_6px_var(--color-cyan-glow)] [animation:pulse-dot_1.5s_ease_infinite] motion-reduce:[animation:none]",
    rail: "bg-cyan shadow-[0_0_8px_var(--color-cyan-glow)]",
  },
  done: {
    label: "Done",
    text: "text-green",
    dot: "bg-green shadow-[0_0_6px_var(--color-green-glow)]",
    rail: "bg-green opacity-[0.55]",
  },
  blocked: {
    label: "Blocked",
    text: "text-red",
    dot: "bg-red shadow-[0_0_6px_var(--color-red-glow)]",
    rail: "bg-red shadow-[0_0_8px_var(--color-red-glow)]",
  },
  closed: {
    label: "Closed",
    text: "text-text-tertiary",
    dot: "bg-text-tertiary",
    rail: "bg-text-tertiary opacity-[0.15]",
  },
};

export const TICKET_WORK_TYPE_LABELS: Record<TicketWorkType, string> = {
  feature: "feature",
  bug: "bug",
  research: "research",
  tech_debt: "tech debt",
  performance: "performance",
};

export const TICKET_STATUS_ORDER: readonly TicketStatus[] = [
  "not_started",
  "in_progress",
  "done",
  "blocked",
  "closed",
];

export const TICKET_WORK_TYPE_ORDER: readonly TicketWorkType[] = [
  "feature",
  "bug",
  "research",
  "tech_debt",
  "performance",
];
