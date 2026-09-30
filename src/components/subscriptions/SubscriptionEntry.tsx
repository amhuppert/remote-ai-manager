"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/Dialog";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { SubscriptionScope } from "@/lib/subscriptions/controls-schemas";
import type { SubscriptionSourceRef } from "@/lib/subscriptions/schemas";
import { useSubscriptionOverview } from "@/lib/subscriptions/queries";
import { SubscriptionWorkspace } from "./SubscriptionWorkspace";
export function SubscriptionEntry({
  scope = {},
  target,
  source,
  label,
}: {
  scope?: SubscriptionScope;
  target?: ConversationTarget;
  source?: SubscriptionSourceRef;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const queryScope = {
    ...scope,
    ...(target
      ? {
          project: target.projectName,
          conversation: target.conversationId,
          ...(target.scope === "session"
            ? { session: target.sessionName }
            : {}),
        }
      : {}),
    ...(source ? { sourceKind: source.kind, sourceId: source.id } : {}),
  };
  const query = useSubscriptionOverview({ ...queryScope, limit: 1 });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          touch
          variant="ghost"
          onClick={(event) => event.stopPropagation()}
        >
          {label ?? (source ? "Followers" : "Subscriptions")}
          {query.data ? ` · ${query.data.counts.following}` : ""}
        </Button>
      </DialogTrigger>
      <DialogContent
        unstyled
        contentClassName="flex max-h-[90dvh] w-[min(1100px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-solid border-border-default bg-bg-base p-5 shadow-menu max-768:max-h-[94dvh] max-768:w-[calc(100vw-16px)] max-768:p-3"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <DialogTitle>
              {source ? "Source followers" : "Subscriptions & inbox"}
            </DialogTitle>
            <DialogDescription>
              Inspect delivery and manage what agents follow.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" aria-label="Close subscriptions">
              ×
            </Button>
          </DialogClose>
        </div>
        <div className="min-h-0 overflow-auto">
          {open ? (
            <SubscriptionWorkspace
              initialScope={queryScope}
              target={target}
              source={source}
              compact
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
