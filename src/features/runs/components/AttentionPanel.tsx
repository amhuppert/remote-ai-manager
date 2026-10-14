"use client";

import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  RefreshIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { cn } from "@/lib/ui/cn";
import { ApprovalIcon, QuestionIcon } from "@/components/runs/icons";
import type { AttentionItem, RunOwner } from "@/components/runs/model";
import { haltTitle, runHaltTitle } from "@/components/runs/present";
import { Refusal, useAwaitedAction } from "@/components/runs/awaited-action";

export interface AttentionActions {
  onSelectContext(key: string): void;
  onRetryLane(lane: string): void | Promise<void>;
  onResume(): void | Promise<void>;
  onOpenConversation(conversationId: string): void;
}

function Item({
  icon,
  tone,
  title,
  detail,
  at,
  action,
  refusal,
}: {
  icon: React.ReactNode;
  tone: "red" | "amber" | "neutral";
  title: React.ReactNode;
  detail: string;
  /** Absent when nothing recorded when it began. */
  at?: string;
  action: React.ReactNode;
  refusal?: string | null;
}) {
  return (
    <li className="flex items-center gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-[10px] last:border-b-0 max-640:items-start max-640:px-md">
      <span
        className={cn(
          "shrink-0",
          tone === "red"
            ? "text-red"
            : tone === "amber"
              ? "text-amber"
              : "text-text-tertiary",
        )}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="min-w-0 font-mono text-[0.78rem] font-medium text-text-primary max-640:whitespace-normal">
          {title}
        </span>
        <span className="min-w-0 font-mono text-[0.72rem] leading-relaxed break-words text-text-secondary">
          {detail}
        </span>
        {refusal !== undefined && refusal !== null ? (
          <Refusal message={refusal} />
        ) : null}
      </div>
      {at !== undefined ? (
        <time
          dateTime={at}
          className="shrink-0 font-mono text-[0.7rem] text-text-tertiary max-640:hidden"
        >
          {formatLocalTime(at)}
        </time>
      ) : null}
      <div className="shrink-0">{action}</div>
    </li>
  );
}

/**
 * What the run needs: the person's decisions first (halts, approvals, lane
 * stops), then what the owner conversation is handling. Each row names its
 * one action.
 */
export function AttentionPanel({
  items,
  owner,
  actions,
}: {
  items: AttentionItem[];
  owner: RunOwner;
  actions: AttentionActions;
}) {
  const { pending, refusal, act } = useAwaitedAction<string>();
  const refusalFor = (key: string) =>
    refusal?.key === key ? refusal.message : null;
  const ownerName = owner.title ?? "The owner";
  const yours = items.filter((item) => item.kind !== "question");
  const owners = items.filter(
    (item): item is Extract<AttentionItem, { kind: "question" }> =>
      item.kind === "question",
  );
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-md">
      {yours.length > 0 ? (
        <section
          aria-label="Needs you"
          className="overflow-hidden rounded-lg border border-solid border-[var(--cc-amber-a25)] bg-bg-surface shadow-[0_0_24px_var(--cc-amber-a04)]"
        >
          <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-[var(--cc-amber-a18)] bg-[var(--cc-amber-a08)] px-lg py-[8px]">
            <span className="font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-amber uppercase">
              Needs you
            </span>
            <span className="font-mono text-[0.7rem] text-amber">
              {yours.length}
            </span>
          </div>
          <ul className="m-0 list-none p-0">
            {yours.map((item) => {
              switch (item.kind) {
                case "halt":
                  return (
                    <Item
                      key={`halt-${item.contextKey}`}
                      icon={<AlertTriangleIcon size={15} />}
                      tone="red"
                      title={
                        <>
                          <span className="text-text-tertiary">
                            {item.contextKey} ·{" "}
                          </span>
                          {haltTitle(item.halt)}
                        </>
                      }
                      detail={item.detail}
                      at={item.at}
                      action={
                        <Button
                          touch
                          size="sm"
                          variant="default"
                          onClick={() =>
                            actions.onSelectContext(item.contextKey)
                          }
                        >
                          Resolve
                        </Button>
                      }
                    />
                  );
                case "approval":
                  return (
                    <Item
                      key={`approval-${item.contextKey}`}
                      icon={<ApprovalIcon size={15} />}
                      tone="amber"
                      title={
                        <>
                          <span className="text-text-tertiary">
                            {item.contextKey} ·{" "}
                          </span>
                          Awaiting your approval
                        </>
                      }
                      detail={`${item.contextTitle} · ${item.reviewersPassed} ${item.reviewersPassed === 1 ? "reviewer" : "reviewers"} passed`}
                      at={item.requestedAt}
                      action={
                        <Button
                          touch
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            actions.onSelectContext(item.contextKey)
                          }
                        >
                          Review
                        </Button>
                      }
                    />
                  );
                case "run_halt":
                  return (
                    <Item
                      key={`run-${item.occurrence}`}
                      icon={<AlertTriangleIcon size={15} />}
                      tone="red"
                      title={runHaltTitle(item.halt)}
                      refusal={refusalFor(`run-${item.occurrence}`)}
                      detail={
                        item.clearedBy === "amend"
                          ? `${item.detail} · ${ownerName} can amend the definition, or you can cancel the run.`
                          : item.clearedBy === "cancel"
                            ? `${item.detail} · Only cancelling the run clears this.`
                            : item.detail
                      }
                      at={item.at}
                      action={
                        item.clearedBy === "resume" ? (
                          <Button
                            touch
                            size="sm"
                            loading={pending === `run-${item.occurrence}`}
                            disabled={pending !== null}
                            onClick={() =>
                              void act(
                                `run-${item.occurrence}`,
                                actions.onResume,
                              )
                            }
                          >
                            <RefreshIcon size={13} />
                            Resume
                          </Button>
                        ) : item.clearedBy === "retry_lane" &&
                          item.lane !== undefined ? (
                          <Button
                            touch
                            size="sm"
                            variant="default"
                            loading={pending === `run-${item.occurrence}`}
                            disabled={pending !== null}
                            onClick={() =>
                              void act(`run-${item.occurrence}`, () =>
                                actions.onRetryLane(item.lane ?? ""),
                              )
                            }
                          >
                            <RefreshIcon size={13} />
                            Retry lane
                          </Button>
                        ) : item.clearedBy === "amend" ? (
                          <Button
                            touch
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              actions.onOpenConversation(owner.conversationId)
                            }
                          >
                            Open owner
                            <ArrowUpRightIcon size={12} />
                          </Button>
                        ) : null
                      }
                    />
                  );
                case "stalled": {
                  const key = `stalled-${item.contextKey ?? "run"}`;
                  return (
                    <Item
                      key={key}
                      icon={<AlertTriangleIcon size={15} />}
                      tone="amber"
                      title={
                        <>
                          {item.contextKey !== undefined ? (
                            <span className="text-text-tertiary">
                              {item.contextKey} ·{" "}
                            </span>
                          ) : null}
                          Finished work was not picked up
                        </>
                      }
                      detail="A step finished, but nothing went on from it. Resuming the run picks it up."
                      refusal={refusalFor(key)}
                      action={
                        <Button
                          touch
                          size="sm"
                          loading={pending === key}
                          disabled={pending !== null}
                          onClick={() => void act(key, actions.onResume)}
                        >
                          <RefreshIcon size={13} />
                          Resume
                        </Button>
                      }
                    />
                  );
                }
              }
            })}
          </ul>
        </section>
      ) : null}
      {owners.length > 0 ? (
        <section
          aria-label="With the owner"
          className="overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface"
        >
          <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-base px-lg py-[8px]">
            <span className="font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">
              With {ownerName}
            </span>
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              {owners.length}
            </span>
          </div>
          <ul className="m-0 list-none p-0">
            {owners.map((item) => (
              <Item
                key={`question-${item.questionId}`}
                icon={<QuestionIcon size={15} />}
                tone="amber"
                title={
                  <>
                    <span className="text-text-tertiary">
                      {item.contextKey} ·{" "}
                    </span>
                    {item.question}
                  </>
                }
                detail={`The ${item.seat} asked; the owner answers or asks you.`}
                at={item.askedAt}
                action={
                  <Button
                    touch
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      actions.onOpenConversation(owner.conversationId)
                    }
                  >
                    Open owner
                    <ArrowUpRightIcon size={12} />
                  </Button>
                }
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
