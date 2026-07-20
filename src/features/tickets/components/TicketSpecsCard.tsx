"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  CopyReferenceControl,
  formatSpecPhase,
  specPhaseTone,
} from "@/components/references/SpecRefChips";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  authoringSpecResultSchema,
  type AuthoringSpecResultView,
  useSpecProjectActionMutation,
} from "@/lib/specs/mutations";
import {
  useTicketSpecReadThroughQuery,
  type TicketSpecReadThrough,
} from "@/lib/specs/queries";
import { buildSpecReadCommand } from "@/lib/prompt-editor/spec-reference-contract";
import type { TicketDetail } from "@/lib/tickets/schemas";
import { pushToast } from "@/stores/toast.store";

const logger = createClientLogger("tickets.spec-read-through");

export default function TicketSpecsCard({
  detail,
}: {
  detail: TicketDetail;
}): React.JSX.Element {
  const router = useRouter();
  const readThrough = useTicketSpecReadThroughQuery(
    detail.projectName,
    detail.number,
  );
  const graduate = useSpecProjectActionMutation<
    {
      ticket: { projectName: string; number: number };
      slug: string;
      name: string;
      gatePolicy: { preset: "contract-bearing" };
    },
    AuthoringSpecResultView
  >(detail.projectName, "graduate-ticket", authoringSpecResultSchema);

  const graduateTicket = async () => {
    const slug = ticketGraduationSlug(detail.number, detail.title);
    try {
      const result = await graduate.mutateAsync({
        ticket: {
          projectName: detail.projectName,
          number: detail.number,
        },
        slug,
        name: detail.title,
        gatePolicy: { preset: "contract-bearing" },
      });
      logger.info("ticket_graduation.complete", {
        ticketId: detail.id,
        specId: result.spec.id,
      });
      router.push(specHref(detail.projectName, result.spec.slug));
    } catch {
      logger.warn("ticket_graduation.failed", { ticketId: detail.id });
      pushToast(`Couldn't graduate ${detail.projectName}#${detail.number}`);
    }
  };

  const specs = readThrough.data?.specs ?? [];
  return (
    <section
      aria-label="Specs"
      className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-md"
    >
      <div className="flex items-center gap-[6px]">
        <span className="font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          Specs
        </span>
        <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-bg-raised px-[6px] py-px font-mono text-[0.68rem] font-semibold text-text-secondary">
          {specs.length}
        </span>
      </div>

      {readThrough.isPending ? (
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          Loading linked specs…
        </span>
      ) : readThrough.isError ? (
        <div role="alert" className="flex flex-col gap-sm">
          <span className="font-mono text-[0.7rem] text-red-text">
            Linked spec state unavailable
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={readThrough.isFetching}
            onClick={() => void readThrough.refetch()}
          >
            {readThrough.isFetching ? "Retrying…" : "Retry specs"}
          </Button>
        </div>
      ) : specs.length === 0 ? (
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          No specs linked to this ticket.
        </span>
      ) : (
        specs.map((spec) => (
          <LinkedSpec
            key={spec.specId}
            projectName={detail.projectName}
            spec={spec}
          />
        ))
      )}

      <Button
        variant="ghost"
        size="sm"
        disabled={graduate.isPending}
        aria-busy={graduate.isPending || undefined}
        onClick={() => void graduateTicket()}
      >
        {graduate.isPending ? <Spinner size="sm" tone="inherit" /> : null}
        {graduate.isPending ? "Graduating…" : "Graduate to spec"}
      </Button>
      <span className="font-mono text-[0.66rem] text-text-tertiary">
        Spec state is read live; ticket status remains ticket-owned.
      </span>
    </section>
  );
}

function LinkedSpec({
  projectName,
  spec,
}: {
  projectName: string;
  spec: TicketSpecReadThrough["specs"][number];
}): React.JSX.Element {
  const phase = formatSpecPhase(spec.phase);
  return (
    <div className="flex flex-col gap-sm rounded-md border border-solid border-border-default bg-bg-raised p-sm">
      <div className="flex items-center gap-sm">
        <Link
          href={specHref(projectName, spec.slug)}
          aria-label={`${spec.name} ${phase}`}
          className="inline-flex min-w-0 items-center gap-xs rounded-md font-mono text-[0.74rem] font-semibold text-text-primary no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        >
          <span className="truncate">{spec.name}</span>
          <StatusChip
            tone={specPhaseTone(spec.phase.primary)}
            appearance="flat"
          >
            {phase}
          </StatusChip>
        </Link>
        <div className="ml-auto shrink-0">
          <CopyReferenceControl
            referenceType="spec"
            attrs={{
              projectName,
              slug: spec.slug,
              name: spec.name,
              revision: String(spec.revision),
              readCommand: buildSpecReadCommand(projectName, spec.slug),
            }}
          />
        </div>
      </div>
      <span className="font-mono text-[0.68rem] text-text-secondary">
        {spec.criteriaProgress.proven}/{spec.criteriaProgress.total} criteria
        proven
      </span>
      {spec.linkedTasks.map((task) => (
        <div
          key={task.taskElementId}
          data-source-task-state={task.sourceTaskState}
          className="flex items-center gap-sm border-x-0 border-t border-b-0 border-solid border-border-subtle pt-sm font-mono text-[0.68rem]"
        >
          <span
            title={task.taskElementId}
            className="min-w-0 flex-1 truncate text-text-tertiary"
          >
            {task.taskHandle ?? task.taskElementId}
          </span>
          {task.sourceTaskState !== "current" ? (
            <StatusChip tone="amber" appearance="flat">
              Source task {task.sourceTaskState}
            </StatusChip>
          ) : null}
          <StatusChip tone={taskStatusTone(task.workStatus)} appearance="flat">
            {formatTaskStatus(task.workStatus)}
          </StatusChip>
        </div>
      ))}
    </div>
  );
}

export function ticketGraduationSlug(number: number, title: string): string {
  const titleSlug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `ticket-${number}-${titleSlug || "spec"}`;
}

function specHref(projectName: string, slug: string): string {
  return `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;
}

function formatTaskStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

function taskStatusTone(status: string): StatusChipTone {
  switch (status) {
    case "completed":
    case "claimed":
      return "green";
    case "running":
      return "cyan";
    case "failed":
      return "red";
    case "interrupted":
    case "reopened":
      return "amber";
    default:
      return "neutral";
  }
}
