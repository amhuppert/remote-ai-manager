"use client";

import Link from "next/link";
import Topbar from "@/components/Topbar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useTicketDetailQuery } from "@/lib/tickets/queries";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import TicketDependencyMap from "./TicketDependencyMap";

export default function TicketDependenciesView({
  projectName,
  number,
}: {
  projectName: string;
  number: number;
}): React.JSX.Element {
  const query = useTicketDetailQuery(projectName, number);
  const identifier = formatTicketIdentifier(projectName, number);
  return (
    <div className="app" data-page="ticket-dependencies">
      <Topbar
        page="tickets"
        breadcrumbs={[
          { label: "tickets", href: "/tickets" },
          { label: identifier, href: ticketDetailHref(projectName, number) },
          { label: "dependencies" },
        ]}
      />
      <main className="main">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-xl p-xl max-768:p-md">
          <div className="flex flex-wrap items-start justify-between gap-md">
            <div className="flex min-w-0 flex-col gap-sm">
              <h1 className="m-0 font-display text-[1.35rem] font-semibold text-text-primary">
                Ticket dependencies
              </h1>
              <p className="m-0 font-mono text-[0.78rem] break-words text-text-secondary">
                {identifier}
                {query.data ? ` · ${query.data.title}` : ""}
              </p>
            </div>
            <Link
              href={ticketDetailHref(projectName, number)}
              className="inline-flex min-h-[44px] items-center font-mono text-[0.74rem] text-text-secondary! no-underline hover:text-cyan! focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
            >
              Back to ticket
            </Link>
          </div>
          {query.isPending && (
            <div
              role="status"
              className="flex items-center gap-sm py-xl font-mono text-[0.78rem] text-text-secondary"
            >
              <Spinner size="sm" />
              Loading ticket…
            </div>
          )}
          {query.isError && (
            <div
              role="alert"
              className="flex flex-col items-start gap-md py-xl font-mono text-[0.78rem] text-red"
            >
              <span>
                Couldn&apos;t load {identifier}. The ticket may have been
                deleted.
              </span>
              <Button
                size="sm"
                touch
                loading={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Retry ticket
              </Button>
            </div>
          )}
          {query.data && (
            <TicketDependencyMap key={query.data.id} ticket={query.data} />
          )}
        </div>
      </main>
    </div>
  );
}
