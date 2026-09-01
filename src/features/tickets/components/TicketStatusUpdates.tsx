"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";

import { DocumentMarkdown } from "@/components/markdown/Markdown";
import { MultilineInput } from "@/components/MultilineInput";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  SectionCount,
  SectionHeader,
  SectionLabel,
} from "@/components/ui/SectionHeader";
import { backendLabel } from "@/lib/agent-backends/catalog";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { useAddTicketStatusUpdateMutation } from "@/lib/tickets/mutations";
import { useTicketStatusUpdatesQuery } from "@/lib/tickets/queries";
import type { TicketStatusUpdate } from "@/lib/tickets/schemas";
import { formatRelativeTime } from "../format-relative-time";

export interface TicketStatusUpdatesProps {
  projectName: string;
  number: number;
}

export default function TicketStatusUpdates(
  props: TicketStatusUpdatesProps,
): React.JSX.Element {
  const headingId = useId();
  const inputId = useId();
  const updatesQuery = useTicketStatusUpdatesQuery(
    props.projectName,
    props.number,
  );
  const addMutation = useAddTicketStatusUpdateMutation();
  const [body, setBody] = useState("");
  const [postError, setPostError] = useState<string | null>(null);

  const updates = useMemo(() => {
    const seen = new Set<string>();
    const items: TicketStatusUpdate[] = [];
    for (const update of updatesQuery.data?.pages.flatMap(
      (page) => page.items,
    ) ?? []) {
      if (seen.has(update.id)) continue;
      seen.add(update.id);
      items.push(update);
    }
    return items;
  }, [updatesQuery.data]);
  const total = updatesQuery.data?.pages[0]?.total ?? updates.length;

  const post = (value = body) => {
    if (value.trim().length === 0) {
      setPostError("Enter an update before posting.");
      return;
    }
    if (addMutation.isPending) return;
    setPostError(null);
    addMutation.mutate(
      {
        projectName: props.projectName,
        number: props.number,
        bodyMarkdown: value,
      },
      {
        onSuccess: () => setBody(""),
        onError: (error) => {
          setPostError(
            error instanceof Error
              ? error.message
              : "Couldn't post the status update.",
          );
        },
      },
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      aria-label="Status updates"
      className="flex flex-col gap-md"
    >
      <SectionHeader layoutClassName="mb-0">
        <SectionLabel id={headingId}>Status updates</SectionLabel>
        <SectionCount>{total}</SectionCount>
      </SectionHeader>

      <form
        className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-md"
        onSubmit={(event) => {
          event.preventDefault();
          post();
        }}
      >
        <label
          htmlFor={inputId}
          className="font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase"
        >
          Status update
        </label>
        <MultilineInput
          id={inputId}
          rows={4}
          value={body}
          disabled={addMutation.isPending}
          voiceProjectName={props.projectName}
          placeholder="What changed, what remains, or what needs attention?"
          className="box-border w-full resize-y rounded-md border border-solid border-border-default bg-bg-surface px-[12px] py-[9px] font-mono text-[0.82rem] leading-[1.55] text-text-primary outline-none placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] disabled:opacity-60"
          onValueChange={(value) => {
            setBody(value);
            if (postError !== null) setPostError(null);
          }}
          onPrimaryAction={post}
        />
        <div className="flex items-start gap-sm max-768:flex-col">
          {postError !== null ? (
            <div
              role="alert"
              className="flex min-w-0 flex-1 flex-wrap items-center gap-sm font-mono text-[0.72rem] text-red"
            >
              <span>{postError}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                touch
                disabled={body.trim().length === 0}
                onClick={() => post()}
              >
                Retry post
              </Button>
            </div>
          ) : (
            <span className="min-w-0 flex-1 font-mono text-[0.68rem] text-text-tertiary">
              Ctrl/⌘ + Enter to post
            </span>
          )}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            touch
            loading={addMutation.isPending}
          >
            {addMutation.isPending ? "Posting…" : "Post update"}
          </Button>
        </div>
      </form>

      <StatusUpdateLog
        updates={updates}
        loading={updatesQuery.isPending}
        initialError={
          updatesQuery.isError && updatesQuery.data === undefined
            ? errorMessage(updatesQuery.error, "Couldn't load status updates.")
            : null
        }
        pageError={
          updatesQuery.isFetchNextPageError
            ? errorMessage(
                updatesQuery.error,
                "Couldn't load older status updates.",
              )
            : null
        }
        hasNextPage={updatesQuery.hasNextPage}
        fetchingNextPage={updatesQuery.isFetchingNextPage}
        onRetryInitial={() => void updatesQuery.refetch()}
        onLoadOlder={() => void updatesQuery.fetchNextPage()}
      />
    </section>
  );
}

function StatusUpdateLog({
  updates,
  loading,
  initialError,
  pageError,
  hasNextPage,
  fetchingNextPage,
  onRetryInitial,
  onLoadOlder,
}: {
  updates: readonly TicketStatusUpdate[];
  loading: boolean;
  initialError: string | null;
  pageError: string | null;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  onRetryInitial: () => void;
  onLoadOlder: () => void;
}): React.JSX.Element {
  if (loading) {
    return <LocalStatus>Loading updates…</LocalStatus>;
  }

  if (initialError !== null) {
    return (
      <LocalError
        message={initialError}
        retryLabel="Retry updates"
        onRetry={onRetryInitial}
      />
    );
  }

  return (
    <div className="flex flex-col gap-sm">
      {updates.length === 0 ? (
        <LocalStatus>No status updates yet.</LocalStatus>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-sm p-0">
          {updates.map((update) => (
            <StatusUpdateRow key={update.id} update={update} />
          ))}
        </ol>
      )}

      {pageError !== null ? (
        <LocalError
          message={pageError}
          retryLabel="Retry older updates"
          onRetry={onLoadOlder}
        />
      ) : hasNextPage ? (
        <Button
          type="button"
          variant="default"
          size="sm"
          touch
          loading={fetchingNextPage}
          layoutClassName="self-start"
          onClick={onLoadOlder}
        >
          {fetchingNextPage ? "Loading older…" : "Load older"}
        </Button>
      ) : null}
    </div>
  );
}

function StatusUpdateRow({
  update,
}: {
  update: TicketStatusUpdate;
}): React.JSX.Element {
  return (
    <li className="rounded-md border border-solid border-border-subtle bg-bg-base p-md">
      <div className="mb-sm flex flex-wrap items-center gap-sm font-mono text-[0.68rem] text-text-tertiary">
        <StatusUpdateAuthor update={update} />
        <span aria-hidden="true">·</span>
        <time dateTime={update.createdAt} title={update.createdAt}>
          {formatRelativeTime(update.createdAt)}
        </time>
      </div>
      <DocumentMarkdown content={update.bodyMarkdown} />
    </li>
  );
}

function StatusUpdateAuthor({
  update,
}: {
  update: TicketStatusUpdate;
}): React.JSX.Element {
  if (update.author.kind === "user") {
    return <span className="font-semibold text-text-secondary">User</span>;
  }

  const name = update.author.redactedProfileSnapshot?.name ?? "Agent";
  return (
    <>
      <Link
        href={conversationsPageHref({
          conversationId: update.author.conversationId,
        })}
        className="font-semibold text-text-secondary! no-underline hover:text-cyan! focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
      >
        {name}
      </Link>
      <Badge backend={update.author.backend} subtle>
        {backendLabel(update.author.backend)}
      </Badge>
    </>
  );
}

function LocalStatus({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p
      role="status"
      className="m-0 py-sm font-mono text-[0.74rem] text-text-tertiary"
    >
      {children}
    </p>
  );
}

function LocalError({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-sm font-mono text-[0.72rem] text-red"
    >
      <span>{message}</span>
      <Button type="button" variant="ghost" size="sm" touch onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
