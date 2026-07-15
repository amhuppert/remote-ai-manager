"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/ui/cn";
import { WithTooltip } from "@/components/ui/WithTooltip";
import {
  clampAmbientRows,
  formatElapsed,
  partitionActiveWork,
  type ActiveWorkAction,
  type ActiveWorkItem,
  type AttentionItem,
} from "./active-work";

interface ActiveWorkSectionProps {
  items: ActiveWorkItem[];
  attention?: AttentionItem[];
  /** Clock for elapsed-time labels — owned by the host so labels re-render. */
  nowMs: number;
  defaultExpanded?: boolean;
  onAction?: (item: ActiveWorkItem, action: ActiveWorkAction) => void;
  onDismissAttention?: (item: AttentionItem) => void;
}

const GROUP_HEADER_CLASS =
  "flex min-w-0 items-center gap-sm px-[12px] pt-[12px] pb-[4px] font-mono text-[0.7rem] leading-[1.2] font-semibold tracking-[0.12em] uppercase after:order-2 after:h-[1px] after:min-w-[16px] after:flex-1 after:[background-image:linear-gradient(to_right,var(--border-default),transparent)] after:content-['']";

const SUBGROUP_LABEL_CLASS =
  "px-[12px] pt-[6px] pb-[2px] font-mono text-[0.62rem] leading-[1.2] font-semibold tracking-[0.1em] uppercase";

const ROW_CLASS =
  "flex items-start gap-xs px-[12px] py-[10px] no-underline text-inherit border-y-0 border-r-0 border-l-2 border-solid border-transparent transition-[background-color,border-color] duration-100 ease-[ease] hover:bg-bg-elevated";

const DOT_RUNNING = "bg-cyan shadow-[0_0_4px_var(--color-cyan)]";
const DOT_NEEDS_ACTION = "bg-amber shadow-[0_0_4px_var(--color-amber)]";
const DOT_ATTENTION = "bg-red shadow-[0_0_4px_var(--color-red)]";

const ACTION_BUTTON_CLASS =
  "inline-flex h-[22px] shrink-0 cursor-pointer items-center rounded-sm border border-solid border-amber-dim bg-amber-glow px-[9px] py-0 font-mono text-[0.62rem] font-bold tracking-[0.08em] text-amber uppercase transition-[background-color,border-color,transform] duration-[140ms] ease-[ease] hover:border-amber hover:bg-[var(--cc-amber-a22)] active:translate-y-[1px]";

const SECONDARY_ACTION_BUTTON_CLASS =
  "inline-flex h-[22px] shrink-0 cursor-pointer items-center rounded-sm border border-solid border-border-default bg-transparent px-[9px] py-0 font-mono text-[0.62rem] font-bold tracking-[0.08em] text-text-tertiary uppercase transition-[background-color,border-color,color,transform] duration-[140ms] ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary active:translate-y-[1px]";

function ActiveWorkRow({
  item,
  nowMs,
  onAction,
}: {
  item: ActiveWorkItem;
  nowMs: number;
  onAction?: (item: ActiveWorkItem, action: ActiveWorkAction) => void;
}): React.JSX.Element {
  const needsAction = item.needsAction !== undefined;
  const rightMeta =
    item.progress !== undefined
      ? `${item.progress.completed}/${item.progress.total}`
      : formatElapsed(item.startedAt, nowMs);

  return (
    <Link href={item.href} className={ROW_CLASS}>
      <span
        className={cn(
          "mt-[5px] size-[6px] shrink-0 rounded-full",
          needsAction ? DOT_NEEDS_ACTION : DOT_RUNNING,
        )}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-xs">
        <div className="flex min-w-0 items-baseline gap-xs">
          <div className="min-w-0 flex-1 overflow-hidden text-[0.78rem] font-medium text-ellipsis whitespace-nowrap text-text-primary">
            {item.title}
          </div>
          {rightMeta !== "" && (
            <span className="shrink-0 font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary">
              {rightMeta}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-sm">
          <span
            className={cn(
              "min-w-0 flex-1 overflow-hidden font-mono text-[0.7rem] text-ellipsis whitespace-nowrap",
              needsAction ? "text-amber" : "text-text-secondary",
            )}
          >
            {item.phase}
          </span>
          {item.needsAction !== undefined && (
            <span className="flex shrink-0 items-center gap-xs">
              {item.needsAction.secondary !== undefined && (
                <button
                  type="button"
                  className={SECONDARY_ACTION_BUTTON_CLASS}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (item.needsAction?.secondary !== undefined) {
                      onAction?.(item, item.needsAction.secondary);
                    }
                  }}
                  aria-label={`${item.needsAction.secondary.label}: ${item.title}`}
                >
                  {item.needsAction.secondary.label}
                </button>
              )}
              <button
                type="button"
                className={ACTION_BUTTON_CLASS}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (item.needsAction !== undefined) {
                    onAction?.(item, item.needsAction.primary);
                  }
                }}
                aria-label={`${item.needsAction.primary.label}: ${item.title}`}
              >
                {item.needsAction.primary.label}
              </button>
            </span>
          )}
        </div>
        <span className="overflow-hidden font-mono text-[0.7rem] text-ellipsis whitespace-nowrap text-text-tertiary">
          {item.projectName} / {item.sessionName}
        </span>
      </div>
    </Link>
  );
}

function AttentionRow({
  item,
  onDismiss,
}: {
  item: AttentionItem;
  onDismiss?: (item: AttentionItem) => void;
}): React.JSX.Element {
  return (
    <Link href={item.href} className={ROW_CLASS}>
      <span
        className={cn(
          "mt-[5px] size-[6px] shrink-0 rounded-full",
          DOT_ATTENTION,
        )}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-xs">
        <div className="flex min-w-0 items-center gap-xs">
          <div className="min-w-0 flex-1 overflow-hidden text-[0.78rem] font-medium text-ellipsis whitespace-nowrap text-text-primary">
            {item.title}
          </div>
          <WithTooltip label="Dismiss">
            <button
              type="button"
              className="flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-sm border border-solid border-transparent bg-transparent p-0 text-[0.7rem] text-text-tertiary transition-[color,border-color,background-color] duration-150 ease-[ease] hover:border-border-default hover:bg-bg-hover hover:text-red"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDismiss?.(item);
              }}
              aria-label={`Dismiss: ${item.title}`}
            >
              &#10005;
            </button>
          </WithTooltip>
        </div>
        <span className="line-clamp-2 font-mono text-[0.7rem] leading-[1.35] text-text-secondary">
          {item.detail}
        </span>
        <span className="overflow-hidden font-mono text-[0.7rem] text-ellipsis whitespace-nowrap text-text-tertiary">
          {item.projectName} / {item.sessionName}
        </span>
      </div>
    </Link>
  );
}

export default function ActiveWorkSection({
  items,
  attention = [],
  nowMs,
  defaultExpanded = false,
  onAction,
  onDismissAttention,
}: ActiveWorkSectionProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (items.length === 0 && attention.length === 0) return null;

  const partition = partitionActiveWork(items);
  const { visible, hiddenCount } = expanded
    ? {
        visible: [...partition.needsAction, ...partition.running],
        hiddenCount: 0,
      }
    : clampAmbientRows(partition);
  const visibleNeedsAction = visible.filter((i) => i.needsAction !== undefined);
  const visibleRunning = visible.filter((i) => i.needsAction === undefined);
  const showToggle = hiddenCount > 0 || expanded;

  return (
    <section aria-label="Active work" className="flex flex-col">
      {items.length > 0 && (
        <div className={cn(GROUP_HEADER_CLASS, "text-text-primary")}>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            Active Work
          </span>
          <span className="order-1 font-medium text-text-tertiary">
            {items.length}
          </span>
        </div>
      )}
      {visibleNeedsAction.length > 0 && (
        <div className={cn(SUBGROUP_LABEL_CLASS, "text-amber")}>
          Needs action {partition.needsAction.length}
        </div>
      )}
      {visibleNeedsAction.map((item) => (
        <ActiveWorkRow
          key={item.id}
          item={item}
          nowMs={nowMs}
          onAction={onAction}
        />
      ))}
      {visibleRunning.length > 0 && (
        <div className={cn(SUBGROUP_LABEL_CLASS, "text-text-tertiary")}>
          Running {partition.running.length}
        </div>
      )}
      {visibleRunning.map((item) => (
        <ActiveWorkRow
          key={item.id}
          item={item}
          nowMs={nowMs}
          onAction={onAction}
        />
      ))}
      {showToggle && (
        <div className="flex justify-end px-[12px] pt-[2px] pb-[4px]">
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[0.7rem] text-cyan transition-colors duration-150 ease-[ease] hover:text-text-primary"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : `Show all ${items.length}`}
          </button>
        </div>
      )}
      {attention.length > 0 && (
        <>
          <div className={cn(GROUP_HEADER_CLASS, "text-red")}>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              Attention
            </span>
            <span className="order-1 font-medium text-red-dim">
              {attention.length}
            </span>
          </div>
          {attention.map((item) => (
            <AttentionRow
              key={item.id}
              item={item}
              onDismiss={onDismissAttention}
            />
          ))}
        </>
      )}
    </section>
  );
}
