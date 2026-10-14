"use client";
import Link from "next/link";
import { useState } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/Dialog";
import { useNotepadDetailQuery } from "@/lib/notepads/queries";
import NotepadMarkdownRenderer from "@/components/markdown/NotepadMarkdownRenderer";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/Select";
import { StatusChip } from "@/components/ui/StatusChip";
import { Button } from "@/components/ui/Button";
import type {
  SubscriptionView,
  SubscriptionOwner,
} from "@/lib/subscriptions/controls-schemas";
import type { SubscriptionSourceRef } from "@/lib/subscriptions/schemas";
import { cn } from "@/lib/ui/cn";

export function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function clampListOffset(
  offset: number,
  total: number,
  limit: number,
): number {
  return offset < total
    ? offset
    : Math.floor(Math.max(0, total - 1) / limit) * limit;
}
export function ownerLabel(owner: SubscriptionOwner) {
  return `${owner.target.projectName} / ${owner.target.scope === "session" ? owner.target.sessionName : "Project conversation"}`;
}
export function subscriptionState(row: SubscriptionView) {
  if (row.subscription.status === "unfollowed")
    return {
      label: row.wait?.state === "cancelled" ? "Cancelled" : "Unfollowed",
      tone: "neutral" as const,
    };
  if (
    row.subscription.lastError ||
    row.wait?.lastError ||
    row.batch?.state === "failed" ||
    row.batch?.state === "uncertain"
  )
    return { label: "Needs attention", tone: "red" as const };
  if (row.subscription.pausedAt)
    return { label: "Paused", tone: "amber" as const };
  if (row.subscription.missingAt || row.wait?.outcome === "source_missing")
    return { label: "Source missing", tone: "amber" as const };
  if (row.wait?.outcome === "expired")
    return { label: "Expired", tone: "amber" as const };
  if (
    row.wait?.state === "settled" &&
    row.batch?.state === "accepted" &&
    row.wait.batchId === row.batch.id
  )
    return { label: "Delivered", tone: "green" as const };
  if (
    row.subscription.mode === "passive" &&
    row.subscription.expiresAt !== null &&
    Date.parse(row.subscription.expiresAt) <= Date.now()
  )
    return { label: "Expired", tone: "amber" as const };
  if (row.holdReason) return { label: "Held", tone: "amber" as const };
  if (row.rateLimitUntil)
    return { label: "Rate limited", tone: "amber" as const };
  return {
    label:
      row.subscription.mode === "active"
        ? row.wait?.state === "ready"
          ? "Ready to wake"
          : "Waiting"
        : "Following",
    tone:
      row.subscription.mode === "active"
        ? ("cyan" as const)
        : ("neutral" as const),
  };
}
export function SourceLink({
  source,
  href,
  children,
}: {
  source: SubscriptionSourceRef;
  href: string | null;
  children: React.ReactNode;
}) {
  if (source.kind === "notepad")
    return <NotepadSource id={source.id}>{children}</NotepadSource>;
  return href ? (
    <Link
      href={href}
      className="font-mono text-[0.75rem] text-cyan underline-offset-4 hover:underline focus-visible:outline-cyan"
    >
      {children}
    </Link>
  ) : (
    <span className="font-mono text-[0.75rem] text-text-tertiary">
      {children}
    </span>
  );
}
export function SubscriptionRows({
  items,
  selectedId,
  onSelect,
}: {
  items: SubscriptionView[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  return (
    <div className="flex flex-col gap-2" aria-label="Subscriptions">
      {items.map((row) => {
        const state = subscriptionState(row);
        return (
          <button
            key={row.subscription.id}
            type="button"
            onClick={() => onSelect(row.subscription.id)}
            aria-pressed={selectedId === row.subscription.id}
            className={cn(
              "group flex w-full cursor-pointer items-start gap-4 rounded-lg border border-solid p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-cyan max-768:gap-3 max-768:p-3",
              selectedId === row.subscription.id
                ? "border-cyan-dim bg-cyan-glow"
                : "border-border-subtle bg-bg-surface hover:border-border-strong hover:bg-bg-hover",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-1 flex size-9 shrink-0 items-center justify-center rounded-md font-mono text-[0.8rem]",
                row.subscription.mode === "active"
                  ? "bg-cyan-glow text-cyan"
                  : "bg-bg-raised text-text-secondary",
              )}
            >
              {row.subscription.mode === "active" ? "↗" : "≈"}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[0.65rem] uppercase tracking-[0.1em] text-text-tertiary">
                  {row.subscription.source.kind.replace("_", " ")}
                </span>
                <StatusChip tone={state.tone}>{state.label}</StatusChip>
              </span>
              <span className="truncate font-mono text-[0.85rem] font-semibold text-text-primary">
                {row.sourceTitle}
              </span>
              <span className="truncate font-mono text-[0.72rem] text-text-secondary">
                {row.owner.conversationTitle}{" "}
                <span className="text-text-tertiary">
                  · {ownerLabel(row.owner)}
                </span>
              </span>
              <span className="line-clamp-2 font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
                {row.subscription.reason}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-3">
              <span className="font-mono text-[0.65rem] uppercase tracking-wider text-text-tertiary">
                {row.subscription.mode === "active"
                  ? "Wake once"
                  : row.subscription.wakes
                    ? "Wakes"
                    : "Passive"}
              </span>
              {row.pendingCount > 0 ? (
                <StatusChip tone="cyan">{row.pendingCount} pending</StatusChip>
              ) : null}
              <span
                aria-hidden="true"
                className="text-text-tertiary group-hover:text-cyan"
              >
                ↗
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
export function PageControls({
  total,
  offset,
  limit,
  onPage,
}: {
  total: number;
  offset: number;
  limit: number;
  onPage(offset: number): void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-4">
      <span className="font-mono text-[0.7rem] text-text-tertiary">
        {total ? Math.min(offset + 1, total) : 0}–
        {Math.min(offset + limit, total)} of {total}
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          touch
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          type="button"
          size="sm"
          touch
          disabled={offset + limit >= total}
          onClick={() => onPage(offset + limit)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function NotepadSource({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const query = useNotepadDetailQuery(id, { enabled: open });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          {children}
        </Button>
      </DialogTrigger>
      <DialogContent
        unstyled
        contentClassName="max-h-[88dvh] w-[min(800px,calc(100vw-24px))] overflow-auto rounded-xl border border-solid border-border-default bg-bg-base p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{query.data?.name ?? "Notepad"}</DialogTitle>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" aria-label="Close source">
              ×
            </Button>
          </DialogClose>
        </div>
        <DialogDescription>
          {query.data
            ? `Revision ${query.data.revision} · read-only source preview`
            : "Loading source…"}
        </DialogDescription>
        {query.isError ? (
          <p role="alert" className="text-red">
            {query.error.message}
          </p>
        ) : query.data ? (
          <div className="mt-5">
            <NotepadMarkdownRenderer
              notepadId={id}
              content={query.data.content}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
