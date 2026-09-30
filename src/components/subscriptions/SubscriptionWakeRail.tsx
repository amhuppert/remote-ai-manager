"use client";
import Link from "next/link";
import {
  useSubscriptionOverview,
  subscriptionQueryString,
} from "@/lib/subscriptions/queries";
import { subscriptionState } from "./SubscriptionPrimitives";
import { StatusChip } from "@/components/ui/StatusChip";
export function SubscriptionWakeRail({ project }: { project?: string }) {
  const query = useSubscriptionOverview({
    project,
    mode: "active",
    status: "following",
    limit: 3,
  });
  if (!query.data?.items.length) return null;
  return (
    <section aria-label="Active work subscriptions" className="px-3 py-3">
      <div className="mb-3 flex items-center justify-between font-mono text-[0.67rem] uppercase tracking-wider text-text-secondary">
        <span>Agent wakeups</span>
        <span>{query.data.total}</span>
      </div>
      <div className="flex flex-col gap-2">
        {query.data.items.map((row) => {
          const state = subscriptionState(row);
          return (
            <Link
              key={row.subscription.id}
              href={`/subscriptions?${subscriptionQueryString({ project: row.owner.target.projectName, conversation: row.owner.target.conversationId, selected: row.subscription.id })}`}
              className="block rounded-md border border-solid border-border-subtle bg-bg-surface p-3 no-underline hover:border-cyan-dim"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[0.73rem] text-text-primary">
                  {row.sourceTitle}
                </span>
                <StatusChip tone={state.tone}>{state.label}</StatusChip>
              </div>
              <p className="mb-2 mt-0 line-clamp-2 font-mono text-[0.68rem] leading-relaxed text-text-secondary">
                {row.subscription.reason}
              </p>
              <span className="font-mono text-[0.64rem] text-text-tertiary">
                → {row.owner.conversationTitle}
              </span>
            </Link>
          );
        })}
      </div>
      <Link
        href={`/subscriptions?${subscriptionQueryString({ project })}`}
        className="mt-3 block font-mono text-[0.7rem] text-cyan"
      >
        View all subscriptions ↗
      </Link>
    </section>
  );
}
