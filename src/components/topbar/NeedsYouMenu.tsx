"use client";

import Link from "next/link";
import { useId } from "react";
import { DropdownMenu as RadixDropdownMenu } from "radix-ui";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import {
  activeConversationContextLabel,
  activeConversationHref,
} from "@/lib/active-conversations/row-helpers";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { StatusChip } from "@/components/ui/StatusChip";
import { formatElapsed } from "@/components/session/sidebar/active-work";
import { cn } from "@/lib/ui/cn";

export interface NeedsYouAction {
  id: string;
  kind: "job" | "workflow" | "collab" | "spec";
  title: string;
  projectName: string;
  sessionName: string;
  phase: string;
  href: string;
  startedAt: string;
  detail?: string;
}

export interface NeedsYouItem {
  id: string;
  source: "conversation" | "active-work";
  kind: "conversation" | NeedsYouAction["kind"];
  label: string;
  title: string;
  detail: string;
  occurredAt: string;
  href: string;
}

function conversationLabel(row: ActiveConversation): string {
  if (row.pendingApproval !== null) return "Approval required";
  if (row.status === "waiting_for_input") return "Input requested";
  return "Unread update";
}

function conversationTitle(row: ActiveConversation): string {
  const name = row.name?.trim();
  if (name) return name;
  if (row.scope === "session") return row.sessionName;
  return row.projectName;
}

function conversationDetail(row: ActiveConversation): string {
  if (row.pendingApproval !== null) {
    const context =
      row.pendingApproval.contextTitle ??
      row.pendingApproval.workflowName ??
      "Workflow";
    const completed = row.pendingApproval.tasksCompleted;
    const total = row.pendingApproval.tasksTotal;
    const progress =
      completed !== null && total !== null
        ? ` · ${completed}/${total} tasks complete`
        : "";
    return `${context} is awaiting approval${progress}`;
  }
  return (
    row.pendingQuestion?.trim() ||
    row.lastActivitySummary?.trim() ||
    row.summary?.trim() ||
    `${row.projectName} · ${activeConversationContextLabel(row)}`
  );
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function buildNeedsYouItems(
  conversations: ActiveConversation[],
  actions: NeedsYouAction[],
): NeedsYouItem[] {
  const items: Array<{ item: NeedsYouItem; order: number }> = [];

  for (const row of conversations) {
    items.push({
      order: items.length,
      item: {
        id: `conversation:${row.id}`,
        source: "conversation",
        kind: "conversation",
        label: conversationLabel(row),
        title: conversationTitle(row),
        detail: conversationDetail(row),
        occurredAt: row.lastActivityAt,
        href: activeConversationHref(row),
      },
    });
  }

  for (const action of actions) {
    items.push({
      order: items.length,
      item: {
        id: action.id,
        source: "active-work",
        kind: action.kind,
        label: action.phase,
        title: action.title,
        detail:
          action.detail ?? `${action.projectName} · ${action.sessionName}`,
        occurredAt: action.startedAt,
        href: action.href,
      },
    });
  }

  items.sort((left, right) => {
    const leftTimestamp = timestampValue(left.item.occurredAt);
    const rightTimestamp = timestampValue(right.item.occurredAt);
    return leftTimestamp === rightTimestamp
      ? left.order - right.order
      : rightTimestamp - leftTimestamp;
  });
  return items.map((row) => row.item);
}

function needsYouSummary(items: NeedsYouItem[]): string | null {
  const firstAction = items.find((item) => item.source === "active-work");
  if (firstAction !== undefined) return firstAction.label.toLowerCase();

  const approvals = items.filter(
    (item) => item.label === "Approval required",
  ).length;
  if (approvals === 0) return null;
  return `${approvals} approval${approvals === 1 ? "" : "s"}`;
}

function attentionRowAccessibleLabel(
  item: NeedsYouItem,
  elapsed: string,
): string {
  const detail = item.detail.endsWith(".")
    ? item.detail.slice(0, -1)
    : item.detail;
  const time = elapsed === "" ? "" : ` ${elapsed}`;
  return `${item.label}: ${item.title}. ${detail}.${time}`;
}

function DecisionArrowIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-cyan-dim"
    >
      <path
        d="M3 8h10m-3.5-3.5L13 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface NeedsYouMenuProps {
  items: NeedsYouItem[];
  nowMs: number;
  defaultOpen?: boolean;
}

export function NeedsYouMenu({
  items,
  nowMs,
  defaultOpen = false,
}: NeedsYouMenuProps): React.JSX.Element | null {
  const menuLabelId = useId();
  if (items.length === 0) return null;

  const count = items.length;
  const summary = needsYouSummary(items);
  const decisionLabel = `${count} item${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your decision`;
  const accessibleLabel = `Needs you: ${decisionLabel}`;

  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={decisionLabel}
          aria-label={accessibleLabel}
          className="cursor-pointer appearance-none border-0 bg-transparent p-0 transition-colors duration-[140ms] ease-[ease] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px] hover:[&_[data-needs-you-chip]]:border-amber hover:[&_[data-needs-you-chip]]:bg-[var(--cc-topbar-needs-hover-bg)]"
        >
          <StatusChip
            tone="amber"
            data-needs-you-chip=""
            icon={
              <span
                className="size-[7px] [animation:pulse-dot_1.6s_ease-in-out_infinite] rounded-full bg-amber [box-shadow:0_0_7px_var(--amber)] motion-reduce:[animation:none]"
                aria-hidden="true"
              />
            }
          >
            <span className="contents font-bold tracking-[0.07em] uppercase">
              <span className="tabular-nums">{count}</span>
              <span className="font-semibold text-amber-dim max-768:hidden">
                {count === 1 ? "needs you" : "need you"}
              </span>
              {summary !== null && (
                <span className="font-semibold whitespace-nowrap text-amber max-768:hidden">
                  · {summary}
                </span>
              )}
            </span>
          </StatusChip>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-labelledby={menuLabelId}
        layoutClassName="w-[500px] max-w-[calc(100vw-16px)]"
      >
        <div className="-m-xs overflow-hidden rounded-md bg-bg-surface">
          <RadixDropdownMenu.Label
            id={menuLabelId}
            aria-label={`Needs you, ${count} item${count === 1 ? "" : "s"}`}
            className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle px-md py-[7px] font-mono text-[0.7rem] font-bold tracking-[0.08em] text-amber uppercase select-none"
          >
            <span>Needs you</span>
            <StatusChip tone="amber">
              <span className="font-bold tabular-nums">{count}</span>
            </StatusChip>
          </RadixDropdownMenu.Label>
          {items.map((item, index) => {
            const elapsed = formatElapsed(item.occurredAt, nowMs);
            return (
              <RadixDropdownMenu.Item key={item.id} asChild>
                <Link
                  href={item.href}
                  aria-label={attentionRowAccessibleLabel(item, elapsed)}
                  className="flex w-full cursor-pointer items-center gap-[10px] border-x-0 border-t-0 border-b border-solid border-border-dim bg-transparent px-md py-[9px] text-left font-mono text-[0.74rem] font-normal text-text-primary transition-colors duration-150 ease-[ease] outline-none last:border-b-0 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] data-[highlighted]:bg-bg-raised"
                >
                  <span
                    className={cn(
                      "size-[7px] shrink-0 rounded-full bg-amber [box-shadow:0_0_7px_var(--amber)]",
                      index === 0 &&
                        "motion-safe:[animation:pulse-dot_1.6s_ease-in-out_infinite]",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-[6px]">
                      <span className="inline-flex shrink-0 rounded-sm border border-solid border-border-subtle bg-bg-raised px-xs font-mono text-[0.7rem] font-bold tracking-[0.05em] text-text-tertiary uppercase">
                        {item.label}
                      </span>
                      <span className="min-w-0 overflow-hidden font-semibold text-ellipsis whitespace-nowrap text-text-primary">
                        {item.title}
                      </span>
                    </span>
                    <span className="mt-[1px] block overflow-hidden text-[0.7rem] font-normal text-ellipsis whitespace-nowrap text-text-tertiary">
                      {item.detail}
                    </span>
                  </span>
                  <time
                    className="shrink-0 text-[0.7rem] font-normal text-text-tertiary max-[360px]:hidden"
                    dateTime={item.occurredAt}
                  >
                    {elapsed}
                  </time>
                  <DecisionArrowIcon />
                </Link>
              </RadixDropdownMenu.Item>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
