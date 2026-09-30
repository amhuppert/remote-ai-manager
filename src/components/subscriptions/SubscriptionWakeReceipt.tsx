"use client";
import Link from "next/link";
import {
  useSubscriptionInbox,
  subscriptionQueryString,
} from "@/lib/subscriptions/queries";
import { SourceLink } from "./SubscriptionPrimitives";
export function SubscriptionWakeReceipt({ batchId }: { batchId: string }) {
  const query = useSubscriptionInbox({ batchId, state: "all", limit: 6 });
  return (
    <aside
      aria-label="Why the agent woke"
      className="mb-4 rounded-lg border border-solid border-cyan-dim bg-cyan-glow p-4"
    >
      <p className="mb-2 mt-0 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-cyan">
        Subscription wake
      </p>
      {query.data?.items.map((item) => (
        <div key={item.delivery.id} className="mb-3">
          <p className="my-2 font-mono text-[0.75rem] leading-relaxed text-text-primary">
            {item.delivery.fact.summary}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <SourceLink source={item.delivery.source} href={item.sourceHref}>
              Source ↗
            </SourceLink>
            <Link
              href={`/subscriptions?${subscriptionQueryString({ project: item.owner.target.projectName, conversation: item.owner.target.conversationId, selected: item.delivery.subscriptionId })}`}
              className="font-mono text-[0.7rem] text-cyan"
            >
              Subscription & delivery receipt ↗
            </Link>
          </div>
        </div>
      ))}
      <p className="m-0 font-mono text-[0.68rem] leading-relaxed text-text-secondary">
        This event started an agent turn. Runtime acceptance is recorded
        separately from the agent&apos;s response and your read status.
      </p>
      {query.isError ? (
        <p role="status" className="text-[0.7rem] text-amber">
          Receipt details are unavailable. The delivered update remains below.
        </p>
      ) : null}
    </aside>
  );
}
