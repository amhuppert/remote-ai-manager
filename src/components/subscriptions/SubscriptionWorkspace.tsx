"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { subscriptionTurnHref } from "@/lib/subscriptions/turn-links";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/FormField";
import { StatusChip } from "@/components/ui/StatusChip";
import { Switch } from "@/components/ui/Switch";
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/Tabs";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/Dialog";
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { SubscriptionSourceRef } from "@/lib/subscriptions/schemas";
import type {
  SubscriptionScope,
  SubscriptionOverviewQuery,
  InboxOverviewQuery,
  InboxView,
} from "@/lib/subscriptions/controls-schemas";
import {
  useSubscriptionOverview,
  useSubscriptionInbox,
  useSubscriptionRecipients,
  useInboxPreferences,
  subscriptionQueryString,
} from "@/lib/subscriptions/queries";
import {
  useMarkSubscriptionRead,
  useSetInboxHints,
  useReviewSubscriptionDelivery,
} from "@/lib/subscriptions/mutations";
import {
  Choice,
  SubscriptionRows,
  SourceLink,
  PageControls,
  ownerLabel,
  clampListOffset,
} from "./SubscriptionPrimitives";
import { SubscriptionDetail } from "./SubscriptionDetail";
import { CreateSubscription } from "./CreateSubscription";

export function SubscriptionWorkspace({
  initialScope = {},
  target,
  source,
  initialSelected = null,
  compact = false,
}: {
  initialScope?: SubscriptionScope;
  target?: ConversationTarget;
  source?: SubscriptionSourceRef;
  initialSelected?: string | null;
  compact?: boolean;
}) {
  const [scope, setScope] = useState(initialScope);
  const [tab, setTab] = useState("subscriptions");
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [filter, setFilter] =
    useState<SubscriptionOverviewQuery["status"]>("following");
  const [mode, setMode] = useState<SubscriptionOverviewQuery["mode"]>("all");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [inboxOffset, setInboxOffset] = useState(0);
  const [inboxState, setInboxState] =
    useState<InboxOverviewQuery["state"]>("pending");
  const [inboxSubscription, setInboxSubscription] = useState<
    string | undefined
  >();
  const queryScope = {
    ...scope,
    ...(source ? { sourceKind: source.kind, sourceId: source.id } : {}),
  };
  const overview = useSubscriptionOverview({
    ...queryScope,
    status: filter,
    mode,
    q: search,
    offset,
    limit: 20,
  });
  const selectedQuery = useSubscriptionOverview(
    {
      ...queryScope,
      status: "all",
      subscriptionId: selected ?? undefined,
      limit: 1,
    },
    selected !== null,
  );
  const inbox = useSubscriptionInbox(
    {
      ...queryScope,
      subscriptionId: inboxSubscription,
      q: search,
      state: inboxState,
      offset: inboxOffset,
      limit: 20,
    },
    tab === "inbox",
  );
  const selectedRow = selectedQuery.data?.items[0];
  const ownerQuery = useSubscriptionRecipients(
    { project: scope.project, conversation: scope.conversation, limit: 1 },
    !target && Boolean(scope.conversation),
  );
  const effectiveTarget = target ?? ownerQuery.data?.items[0]?.target;
  const selectedRowId = selectedRow?.subscription.id;
  const overviewOffset = overview.data
    ? clampListOffset(offset, overview.data.total, 20)
    : offset;
  if (overviewOffset !== offset) setOffset(overviewOffset);
  const currentInboxOffset = inbox.data
    ? clampListOffset(inboxOffset, inbox.data.total, 20)
    : inboxOffset;
  if (currentInboxOffset !== inboxOffset) setInboxOffset(currentInboxOffset);
  const attachDetail = useCallback(
    (node: HTMLDivElement | null) => {
      if (
        node &&
        selectedRowId &&
        window.matchMedia("(max-width: 1080px)").matches
      )
        node.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [selectedRowId],
  );
  const preferences = useInboxPreferences(effectiveTarget);
  const hints = useSetInboxHints();
  function changeScope(next: SubscriptionScope) {
    setScope(next);
    setSelected(null);
    setOffset(0);
    setInboxOffset(0);
    setInboxSubscription(undefined);
  }
  const counts = overview.data?.counts;
  return (
    <div className="flex min-w-0 flex-col gap-5 font-mono">
      {!compact ? (
        <header className="flex items-start justify-between gap-5 max-768:flex-col">
          <div>
            <p className="mb-2 mt-0 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-cyan">
              Agent awareness
            </p>
            <h1 className="m-0 font-display text-[2rem] font-bold tracking-tight text-text-primary max-768:text-[1.7rem]">
              Subscriptions & inbox
            </h1>
            <p className="mb-0 mt-3 max-w-[650px] text-[0.78rem] leading-relaxed text-text-secondary">
              See what your agents are following, what will wake them, and what
              is waiting to be delivered.
            </p>
          </div>
          <CreateSubscription
            scope={scope}
            target={effectiveTarget}
            source={source}
            onCreated={(id) => {
              setSelected(id);
              setFilter("all");
            }}
          />
        </header>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[0.72rem] text-text-secondary">
            {source
              ? "Conversations following this source"
              : "Awareness for this scope"}
          </span>
          <CreateSubscription
            scope={scope}
            target={effectiveTarget}
            source={source}
            onCreated={(id) => {
              setSelected(id);
              setFilter("all");
            }}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[0.65rem] uppercase tracking-wider text-text-tertiary">
          Scope
        </span>
        {!target ? (
          <>
            <Button
              size="sm"
              variant={!scope.project ? "primary" : "ghost"}
              onClick={() => changeScope({})}
            >
              Global
            </Button>
            {scope.project ? (
              <>
                <span className="text-text-tertiary">/</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => changeScope({ project: scope.project })}
                >
                  {scope.project}
                </Button>
              </>
            ) : null}
            {scope.session ? (
              <>
                <span className="text-text-tertiary">/</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    changeScope({
                      project: scope.project,
                      session: scope.session,
                    })
                  }
                >
                  {scope.session}
                </Button>
              </>
            ) : null}
            <ScopePicker scope={scope} onScope={changeScope} />
          </>
        ) : (
          <StatusChip>
            {target.scope === "session"
              ? target.sessionName
              : target.projectName}{" "}
            · conversation
          </StatusChip>
        )}
        {scope.conversation && !target ? (
          <StatusChip tone="cyan">Conversation selected</StatusChip>
        ) : null}
      </div>
      <div className="grid grid-cols-4 gap-3 max-768:grid-cols-2">
        {[
          {
            label: "Following",
            value: counts?.following,
            onClick: () => {
              setTab("subscriptions");
              setFilter("following");
              setMode("all");
            },
          },
          {
            label: "Wake waits",
            value: counts?.active,
            onClick: () => {
              setTab("subscriptions");
              setFilter("following");
              setMode("active");
            },
          },
          {
            label: "Pending",
            value: counts?.pending,
            onClick: () => {
              setTab("inbox");
              setInboxState("pending");
              setInboxSubscription(undefined);
            },
          },
          {
            label: "Needs attention",
            value: counts?.attention,
            onClick: () => {
              setTab("subscriptions");
              setFilter("attention");
              setMode("all");
            },
          },
        ].map((metric, index) => (
          <button
            key={metric.label}
            type="button"
            onClick={() => {
              metric.onClick();
              setOffset(0);
              setInboxOffset(0);
            }}
            className="flex cursor-pointer flex-col gap-3 rounded-lg border border-solid border-border-subtle bg-bg-surface p-4 text-left transition-colors hover:border-cyan-dim focus-visible:outline-cyan"
          >
            <span className="flex items-center justify-between text-[0.64rem] uppercase tracking-[0.12em] text-text-tertiary">
              {metric.label}
              <span aria-hidden="true">0{index + 1}</span>
            </span>
            <span className="font-display text-[1.8rem] font-semibold tabular-nums text-text-primary">
              {metric.value ?? "—"}
            </span>
          </button>
        ))}
      </div>
      <TabsRoot value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList aria-label="Subscription workspace">
            <TabsTrigger value="subscriptions" touch>
              Subscriptions
            </TabsTrigger>
            <TabsTrigger value="inbox" touch>
              Inbox
            </TabsTrigger>
          </TabsList>
          {effectiveTarget && preferences.data ? (
            <label className="flex min-h-[44px] items-center gap-3 text-[0.7rem] text-text-secondary">
              CLI inbox hints
              <Switch
                aria-label="CLI inbox hints"
                checked={preferences.data.hintsEnabled}
                disabled={hints.isPending}
                onCheckedChange={(hintsEnabled) =>
                  hints.mutate({ target: effectiveTarget, hintsEnabled })
                }
              />
            </label>
          ) : null}
        </div>
        {hints.isError ? (
          <p role="alert" className="text-red">
            {hints.error.message}
          </p>
        ) : null}
        <TabsContent value="subscriptions">
          <div className="mb-4 mt-5 flex flex-wrap gap-3">
            <div className="min-w-[180px] flex-1">
              <FormInput
                aria-label="Search subscriptions"
                placeholder="Search source, recipient or purpose…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOffset(0);
                  setInboxOffset(0);
                }}
              />
            </div>
            <Choice
              label="Subscription status"
              value={filter ?? "following"}
              options={[
                { value: "following", label: "Following" },
                { value: "paused", label: "Paused" },
                { value: "attention", label: "Needs attention" },
                { value: "unfollowed", label: "Unfollowed" },
                { value: "all", label: "All states" },
              ]}
              onChange={(value) => {
                if (
                  value === "all" ||
                  value === "following" ||
                  value === "paused" ||
                  value === "unfollowed" ||
                  value === "attention"
                )
                  setFilter(value);
                setOffset(0);
              }}
            />
            <Choice
              label="Delivery mode filter"
              value={mode ?? "all"}
              options={[
                { value: "all", label: "All delivery modes" },
                { value: "passive", label: "Passive" },
                { value: "active", label: "Wake once" },
              ]}
              onChange={(value) => {
                if (
                  value === "all" ||
                  value === "passive" ||
                  value === "active"
                )
                  setMode(value);
                setOffset(0);
              }}
            />
          </div>
          <div
            className={
              selected
                ? "grid grid-cols-[minmax(0,1fr)_minmax(300px,380px)] items-start gap-5 max-1080:grid-cols-1"
                : "block"
            }
          >
            <div>
              {overview.isPending ? (
                <WorkspaceEmpty title="Loading subscriptions…" />
              ) : overview.isError ? (
                <WorkspaceError
                  error={overview.error}
                  retry={() => void overview.refetch()}
                />
              ) : overview.data.items.length === 0 ? (
                <WorkspaceEmpty
                  title={
                    search
                      ? "No matching subscriptions"
                      : "Nothing following here yet"
                  }
                  description={
                    search
                      ? "Try another source, recipient or purpose."
                      : "Subscribe a conversation to a source, or let involvement-based follows appear as your agents work."
                  }
                />
              ) : (
                <SubscriptionRows
                  items={overview.data.items}
                  selectedId={selected}
                  onSelect={setSelected}
                />
              )}{" "}
              {overview.data ? (
                <PageControls
                  total={overview.data.total}
                  offset={offset}
                  limit={20}
                  onPage={setOffset}
                />
              ) : null}
            </div>
            {selectedRow ? (
              <div ref={attachDetail}>
                <SubscriptionDetail
                  key={selectedRow.subscription.id}
                  row={selectedRow}
                  onClose={() => setSelected(null)}
                  onInbox={() => {
                    setInboxSubscription(selectedRow.subscription.id);
                    setInboxState("all");
                    setInboxOffset(0);
                    setTab("inbox");
                  }}
                />
              </div>
            ) : selected && selectedQuery.isError ? (
              <WorkspaceError
                error={selectedQuery.error}
                retry={() => void selectedQuery.refetch()}
              />
            ) : null}
          </div>
        </TabsContent>
        <TabsContent value="inbox">
          <div className="mb-4 mt-5 flex flex-wrap items-center justify-between gap-3">
            <FormInput
              aria-label="Search inbox"
              placeholder="Search source, recipient or purpose…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
                setInboxOffset(0);
              }}
            />
            <p className="m-0 max-w-[620px] text-[0.72rem] leading-relaxed text-text-tertiary">
              Reading here does not deliver an update to the agent. Marking read
              records only your own review.
            </p>
            <Choice
              label="Inbox status"
              value={inboxState ?? "pending"}
              options={[
                { value: "pending", label: "Pending delivery" },
                { value: "accepted", label: "Runtime accepted" },
                { value: "issues", label: "Delivery problems" },
                { value: "all", label: "All deliveries" },
              ]}
              onChange={(value) => {
                if (
                  value === "all" ||
                  value === "pending" ||
                  value === "accepted" ||
                  value === "issues"
                )
                  setInboxState(value);
                setInboxOffset(0);
              }}
            />
          </div>
          {inboxSubscription ? (
            <div className="mb-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setInboxSubscription(undefined);
                  setInboxOffset(0);
                }}
              >
                × Clear subscription filter
              </Button>
            </div>
          ) : null}
          {inbox.isPending ? (
            <WorkspaceEmpty title="Loading inbox…" />
          ) : inbox.isError ? (
            <WorkspaceError
              error={inbox.error}
              retry={() => void inbox.refetch()}
            />
          ) : inbox.data.items.length === 0 ? (
            <WorkspaceEmpty
              title={
                inboxState === "pending"
                  ? "You're all caught up"
                  : "No deliveries in this view"
              }
              description="Recorded outcomes will appear here, with their source and delivery status."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {inbox.data.items.map((item) => (
                <InboxRow
                  key={item.delivery.id}
                  item={item}
                  onSubscription={() => {
                    setSelected(item.delivery.subscriptionId);
                    setTab("subscriptions");
                    setFilter("all");
                  }}
                />
              ))}
            </div>
          )}
          {inbox.data ? (
            <PageControls
              total={inbox.data.total}
              offset={inboxOffset}
              limit={20}
              onPage={setInboxOffset}
            />
          ) : null}
        </TabsContent>
      </TabsRoot>
      {compact ? (
        <Link
          href={`/subscriptions?${subscriptionQueryString(queryScope)}`}
          className="text-[0.72rem] text-cyan"
        >
          Open full subscription overview ↗
        </Link>
      ) : null}
    </div>
  );
}
export function WorkspaceEmpty({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border-default bg-bg-base">
      <EmptyState>
        <EmptyStateTitle>{title}</EmptyStateTitle>
        {description ? <EmptyStateDesc>{description}</EmptyStateDesc> : null}
      </EmptyState>
    </div>
  );
}
function WorkspaceError({ error, retry }: { error: Error; retry(): void }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-solid border-red-dim bg-red-glow p-4"
    >
      <p className="text-[0.75rem] text-red">{error.message}</p>
      <Button size="sm" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
function InboxRow({
  item,
  onSubscription,
}: {
  item: InboxView;
  onSubscription(): void;
}) {
  const mark = useMarkSubscriptionRead();
  const review = useReviewSubscriptionDelivery();
  const delivery = item.delivery;
  return (
    <article className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusChip
            tone={
              delivery.state === "accepted"
                ? "green"
                : delivery.state === "failed" || delivery.state === "uncertain"
                  ? "red"
                  : "amber"
            }
          >
            {delivery.state === "accepted"
              ? "Runtime accepted"
              : delivery.state}
          </StatusChip>
          {!item.readAt ? (
            <StatusChip tone="cyan" appearance="flat">
              Unread by you
            </StatusChip>
          ) : null}
        </div>
        <time
          className="text-[0.65rem] text-text-tertiary"
          dateTime={delivery.recordedAt}
        >
          {new Date(delivery.recordedAt).toLocaleString()}
        </time>
      </div>
      <h3 className="mb-2 mt-4 text-[0.85rem] font-semibold text-text-primary">
        {delivery.fact.sourceTitle}
      </h3>
      <p className="text-[0.77rem] leading-relaxed text-text-secondary">
        {delivery.fact.summary}
      </p>
      <p className="text-[0.68rem] text-text-tertiary">
        To {item.owner.conversationTitle} · {ownerLabel(item.owner)}
      </p>
      {delivery.lastError ? (
        <p role="status" className="text-[0.75rem] text-red">
          {delivery.lastError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <SourceLink source={delivery.source} href={item.sourceHref}>
          Open source ↗
        </SourceLink>
        <Button size="sm" variant="ghost" onClick={onSubscription}>
          Subscription
        </Button>
        <Button
          size="sm"
          touch
          loading={mark.isPending}
          onClick={() =>
            mark.mutate({
              target: item.owner.target,
              id: delivery.id,
              read: item.readAt === null,
            })
          }
        >
          {item.readAt ? "Mark unread" : "Mark read"}
        </Button>
      </div>
      {(delivery.state === "failed" || delivery.state === "uncertain") &&
      item.wakeBatchId === null ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-[0.68rem] text-text-tertiary">
            Retry may repeat work if the agent received this update. Dismiss
            keeps the evidence in history without recording acceptance.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              size="sm"
              touch
              loading={review.isPending && review.variables?.action === "retry"}
              disabled={review.isPending}
              onClick={() =>
                review.mutate({
                  target: item.owner.target,
                  id: delivery.id,
                  action: "retry",
                })
              }
            >
              Retry delivery
            </Button>
            <Button
              size="sm"
              touch
              variant="danger"
              loading={
                review.isPending && review.variables?.action === "dismiss"
              }
              disabled={review.isPending}
              onClick={() =>
                review.mutate({
                  target: item.owner.target,
                  id: delivery.id,
                  action: "dismiss",
                })
              }
            >
              Dismiss delivery
            </Button>
          </div>
        </div>
      ) : null}
      {(delivery.state === "failed" || delivery.state === "uncertain") &&
      item.wakeBatchId ? (
        <p className="mt-3 text-[0.68rem] text-text-tertiary">
          <Link
            className="text-cyan"
            href={subscriptionTurnHref(item.owner.target, item.wakeBatchId)}
          >
            Review queued wake ↗
          </Link>{" "}
          · Resolve the queued wake before changing its receipt.
        </p>
      ) : null}
      {item.wakeBatchId && delivery.state === "accepted" ? (
        <p className="text-[0.68rem] text-text-tertiary">
          Wake batch{" "}
          <Link
            className="text-cyan"
            href={subscriptionTurnHref(item.owner.target, item.wakeBatchId)}
          >
            Open resulting turn ↗
          </Link>{" "}
          · Runtime acceptance does not confirm the agent acted.
        </p>
      ) : null}
      <details className="mt-3 text-[0.65rem] text-text-tertiary">
        <summary className="cursor-pointer">Event & delivery details</summary>
        <p className="break-all">
          Event: {delivery.fact.eventKind}
          <br />
          Occurrence: {delivery.fact.occurrenceId}
          <br />
          Delivery: {delivery.id}
          <br />
          Read source: {delivery.fact.retrievalHandle}
        </p>
      </details>
      {mark.isError ? (
        <p role="alert" className="text-red">
          {mark.error.message}
        </p>
      ) : null}
      {review.isError ? (
        <p role="alert" className="text-red">
          {review.error.message}
        </p>
      ) : null}
    </article>
  );
}
function ScopePicker({
  scope,
  onScope,
}: {
  scope: SubscriptionScope;
  onScope(scope: SubscriptionScope): void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const recipients = useSubscriptionRecipients({ q, limit: 10, offset }, open);
  const recipientOffset = recipients.data
    ? clampListOffset(offset, recipients.data.total, 10)
    : offset;
  if (recipientOffset !== offset) setOffset(recipientOffset);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" touch>
          Choose scope…
        </Button>
      </DialogTrigger>
      <DialogContent mobileSheet>
        <DialogTitle>Choose a scope</DialogTitle>
        <DialogDescription>
          Find a conversation, then view its conversation, session or project.
        </DialogDescription>
        <div className="mt-5">
          <FormInput
            aria-label="Find a conversation or session"
            placeholder="Search conversations, sessions or projects…"
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="mt-4 flex max-h-[400px] flex-col gap-3 overflow-auto">
          {recipients.data?.items.map((owner) => (
            <div
              key={owner.target.conversationId}
              className="rounded-md border border-solid border-border-subtle p-3"
            >
              <p className="m-0 text-[0.8rem] text-text-primary">
                {owner.conversationTitle}
              </p>
              <p className="mb-2 mt-1 text-[0.65rem] text-text-tertiary">
                {ownerLabel(owner)}
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  {
                    label: "Conversation",
                    value: {
                      project: owner.target.projectName,
                      ...(owner.target.scope === "session"
                        ? { session: owner.target.sessionName }
                        : {}),
                      conversation: owner.target.conversationId,
                    },
                  },
                  ...(owner.target.scope === "session"
                    ? [
                        {
                          label: "Session",
                          value: {
                            project: owner.target.projectName,
                            session: owner.target.sessionName,
                          },
                        },
                      ]
                    : []),
                  {
                    label: "Project",
                    value: { project: owner.target.projectName },
                  },
                ].map((option) => (
                  <Button
                    key={option.label}
                    size="sm"
                    onClick={() => {
                      onScope(option.value);
                      setOpen(false);
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {recipients.isError ? (
          <WorkspaceError
            error={recipients.error}
            retry={() => void recipients.refetch()}
          />
        ) : null}
        {recipients.data?.total === 0 ? (
          <p className="text-[0.75rem] text-text-tertiary">
            No conversations match this search.
          </p>
        ) : null}
        {recipients.data ? (
          <PageControls
            total={recipients.data.total}
            limit={10}
            offset={offset}
            onPage={setOffset}
          />
        ) : null}
        {scope.project ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onScope({});
              setOpen(false);
            }}
          >
            Show global scope
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
