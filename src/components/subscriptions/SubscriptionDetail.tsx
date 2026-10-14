"use client";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { useSubscriptionControl } from "@/lib/subscriptions/mutations";
import type {
  SubscriptionView,
  SubscriptionControlRequest,
} from "@/lib/subscriptions/controls-schemas";
import { subscriptionQueryString } from "@/lib/subscriptions/queries";
import {
  subscriptionState,
  SourceLink,
  ownerLabel,
} from "./SubscriptionPrimitives";

function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "No expiry";
}
export function SubscriptionDetail({
  row,
  onInbox,
  onClose,
}: {
  row: SubscriptionView;
  onInbox(): void;
  onClose(): void;
}) {
  const control = useSubscriptionControl();
  const state = subscriptionState(row);
  const act = (action: SubscriptionControlRequest | { action: "unfollow" }) =>
    control.mutate({
      target: row.owner.target,
      id: row.subscription.id,
      action,
    });
  return (
    <section
      aria-label="Subscription details"
      className="sticky top-4 flex min-w-0 flex-col gap-5 rounded-xl border border-solid border-border-default bg-bg-elevated p-5 max-768:static max-768:p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-tertiary">
          Subscription details
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          aria-label="Close subscription details"
        >
          ×
        </Button>
      </div>
      <div>
        <div className="mb-3 flex flex-wrap gap-2">
          <StatusChip tone={state.tone}>{state.label}</StatusChip>
          <StatusChip>
            {row.subscription.mode === "active" ? "One-time wake" : "Passive"}
          </StatusChip>
        </div>
        <h2 className="m-0 break-words font-display text-xl font-semibold leading-snug text-text-primary">
          {row.sourceTitle}
        </h2>
        <div className="mt-2">
          <SourceLink source={row.subscription.source} href={row.sourceHref}>
            Open source ↗
          </SourceLink>
        </div>
      </div>
      <div className="rounded-lg border border-solid border-border-subtle bg-bg-base p-4">
        <p className="m-0 font-mono text-[0.65rem] uppercase tracking-wider text-text-tertiary">
          Purpose
        </p>
        <p className="mb-0 mt-2 whitespace-pre-wrap break-words font-mono text-[0.8rem] leading-relaxed text-text-primary">
          {row.subscription.reason}
        </p>
      </div>
      <dl className="m-0 grid grid-cols-[85px_1fr] gap-x-4 gap-y-4 font-mono text-[0.73rem]">
        <dt className="text-text-tertiary">Recipient</dt>
        <dd className="m-0 min-w-0 text-text-primary">
          {row.owner.conversationTitle}
          <span className="mt-1 block break-words text-[0.65rem] text-text-tertiary">
            {ownerLabel(row.owner)}
          </span>
        </dd>
        <dt className="text-text-tertiary">Delivery</dt>
        <dd className="m-0 text-text-secondary">
          {row.subscription.mode === "active"
            ? "Starts a turn at the next safe boundary."
            : row.subscription.wakes
              ? "Starts a turn at the next safe boundary for each new update."
              : "Alongside your next message. Never starts a turn."}
        </dd>
        <dt className="text-text-tertiary">Selection</dt>
        <dd className="m-0 break-words text-text-secondary">
          {row.wait
            ? "One terminal outcome"
            : (row.subscription.eventKinds?.join(", ") ??
              "All supported source changes")}
        </dd>
        <dt className="text-text-tertiary">Lifetime</dt>
        <dd className="m-0 text-text-secondary">
          {date(row.subscription.expiresAt)}
        </dd>
        {row.wait && row.wait.expiresAt !== row.subscription.expiresAt ? (
          <>
            <dt className="text-text-tertiary">
              {row.wait.state === "waiting" || row.wait.state === "ready"
                ? "Wait deadline"
                : "Prior wait deadline"}
            </dt>
            <dd className="m-0 text-text-secondary">
              {date(row.wait.expiresAt)}
            </dd>
          </>
        ) : null}
      </dl>
      {row.holdReason || row.rateLimitUntil || row.subscription.pausedAt ? (
        <div className="rounded-md bg-amber-glow p-3 font-mono text-[0.72rem] leading-relaxed text-amber">
          {row.subscription.pausedAt
            ? "Delivery paused. New outcomes are kept, and the expiry clock continues."
            : (row.holdReason ??
              `Wake rate limited until ${date(row.rateLimitUntil)}`)}
        </div>
      ) : null}
      {row.subscription.lastError ||
      row.wait?.lastError ||
      row.batch?.lastError ? (
        <p
          role="status"
          className="m-0 rounded-md bg-red-glow p-3 font-mono text-[0.72rem] leading-relaxed text-red"
        >
          {row.batch?.lastError ??
            row.wait?.lastError ??
            row.subscription.lastError}
        </p>
      ) : null}
      <Button size="sm" touch onClick={onInbox}>
        {row.pendingCount} pending · View delivery history
      </Button>
      <div className="flex flex-wrap gap-2">
        {row.actions.includes("pause") ? (
          <Button
            size="sm"
            touch
            loading={control.isPending}
            onClick={() => act({ action: "pause" })}
          >
            Pause delivery
          </Button>
        ) : null}
        {row.actions.includes("resume") ? (
          <Button
            size="sm"
            touch
            loading={control.isPending}
            onClick={() => act({ action: "resume" })}
          >
            Resume delivery
          </Button>
        ) : null}
        {row.actions.includes("passive") ? (
          <Button
            size="sm"
            touch
            loading={control.isPending}
            onClick={() => act({ action: "mode", mode: "passive" })}
          >
            Make passive
          </Button>
        ) : null}
        {row.actions.includes("active") ? (
          <Button
            size="sm"
            touch
            loading={control.isPending}
            onClick={() =>
              act({
                action: "mode",
                mode: "active",
                ...(row.wait ? {} : { expiresIn: 86400 }),
              })
            }
          >
            {row.wait ? "Restore wake" : "Wake once · 24h"}
          </Button>
        ) : null}
        {row.actions.includes("cancel") ? (
          <Button
            size="sm"
            touch
            variant="danger"
            loading={control.isPending}
            onClick={() => act({ action: "cancel" })}
          >
            Cancel wait
          </Button>
        ) : null}
        {row.actions.includes("unfollow") ? (
          <Button
            size="sm"
            touch
            variant="ghost"
            loading={control.isPending}
            onClick={() => act({ action: "unfollow" })}
          >
            Unfollow
          </Button>
        ) : null}
      </div>
      {control.isError ? (
        <p role="alert" className="m-0 text-[0.75rem] text-red">
          {control.error.message}
        </p>
      ) : control.isSuccess ? (
        <p role="status" className="m-0 text-[0.72rem] text-green">
          Subscription updated.
        </p>
      ) : null}
      <p className="m-0 font-mono text-[0.68rem] leading-relaxed text-text-tertiary">
        Making passive keeps an outstanding result for your next message.
        Cancelling ends the wait. Delivery confirms runtime acceptance, not
        completed agent work.
      </p>
      <Link
        href={`/subscriptions?${subscriptionQueryString({ project: row.owner.target.projectName, ...(row.owner.target.scope === "session" ? { session: row.owner.target.sessionName } : {}), conversation: row.owner.target.conversationId })}`}
        className="font-mono text-[0.7rem] text-cyan"
      >
        All subscriptions for this conversation ↗
      </Link>
      <details className="font-mono text-[0.65rem] text-text-tertiary">
        <summary className="cursor-pointer">Identifiers</summary>
        <p className="break-all">
          Subscription: {row.subscription.id}
          <br />
          Source: {row.subscription.source.id}
          {row.batch ? (
            <>
              <br />
              Wake batch: {row.batch.id} · {row.batch.state}
            </>
          ) : null}
        </p>
      </details>
    </section>
  );
}
