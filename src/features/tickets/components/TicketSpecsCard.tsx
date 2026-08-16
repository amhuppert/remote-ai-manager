"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  CopyReferenceControl,
  formatSpecPhase,
  specPhaseTone,
} from "@/components/references/SpecRefChips";
import { Button } from "@/components/ui/Button";
import { Progress } from "@/components/ui/Progress";
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
          <LinkedSpecReadThrough
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

export function LinkedSpecReadThrough({
  projectName,
  spec,
}: {
  projectName: string;
  spec: TicketSpecReadThrough["specs"][number];
}): React.JSX.Element {
  const phase = formatSpecPhase(spec.phase);
  const progressLabel = `${spec.criteriaProgress.proven} of ${spec.criteriaProgress.total} criteria proven`;
  return (
    <article className="flex flex-col gap-sm rounded-md border border-solid border-border-default bg-bg-surface px-[13px] py-[11px]">
      <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim pb-sm">
        <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          Spec
        </span>
        <span className="h-px min-w-sm flex-1 bg-border-dim" />
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          Computed at query time — not editable here
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-sm">
        <Link
          href={specHref(projectName, spec.slug)}
          aria-label={`${spec.slug} ${spec.name} ${phase}`}
          title={spec.name}
          className="inline-flex min-w-0 items-center gap-xs rounded-full border border-solid border-[var(--cc-cyan-a25)] bg-cyan-glow px-sm py-xs font-mono text-[0.74rem] font-semibold text-cyan no-underline hover:border-cyan-dim hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        >
          <span className="truncate">{spec.slug}</span>
          <StatusChip
            tone={specPhaseTone(spec.phase.primary)}
            appearance="flat"
          >
            {phase}
          </StatusChip>
        </Link>
        <div className="ml-auto shrink-0 max-768:ml-0">
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

      <div className="flex items-center gap-sm">
        {spec.criteriaProgress.total > 0 ? (
          <Progress
            value={spec.criteriaProgress.proven}
            max={spec.criteriaProgress.total}
            aria-label={progressLabel}
            layoutClassName="min-w-0 flex-1"
          />
        ) : (
          <span className="h-[4px] min-w-0 flex-1 rounded-[2px] bg-bg-base" />
        )}
        <span className="shrink-0 font-mono text-[0.7rem] text-text-secondary">
          {spec.criteriaProgress.total > 0
            ? `${spec.criteriaProgress.proven}/${spec.criteriaProgress.total} in-scope criteria proven`
            : "No criteria in scope"}
        </span>
        {spec.criteriaProgress.total > 0 && (
          <span className="sr-only">
            {spec.criteriaProgress.proven}/{spec.criteriaProgress.total}{" "}
            criteria proven
          </span>
        )}
      </div>

      {spec.linkedTasks.map((task) => (
        <div
          key={task.taskElementId}
          data-source-task-state={task.sourceTaskState}
          className="border-x-0 border-t border-b-0 border-solid border-border-subtle pt-sm font-mono text-[0.7rem]"
        >
          <div className="flex flex-wrap items-center gap-sm">
            {task.taskHandle === null ? (
              <span title={task.taskElementId} className="text-text-tertiary">
                {task.taskElementId}
              </span>
            ) : (
              <Link
                href={`${specHref(projectName, spec.slug)}?${new URLSearchParams({ el: task.taskHandle }).toString()}`}
                aria-label={`${spec.slug}/${task.taskHandle}`}
                title={task.taskElementId}
                className="inline-flex rounded-full border border-solid border-border-default bg-bg-raised px-sm py-xs font-semibold text-text-primary no-underline hover:border-border-strong hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                {task.taskHandle}
              </Link>
            )}
            <StatusChip
              tone={taskStatusTone(task.workStatus)}
              appearance="flat"
            >
              {formatTaskStatus(task.workStatus)}
            </StatusChip>
            {task.sourceTaskState !== "current" ? (
              <span
                title={`The ticket was materialized from ${spec.slug}/${task.taskHandle ?? task.taskElementId}; that source task is ${task.sourceTaskState} in revision ${spec.revision}. Ticket lifecycle remains ticket-owned.`}
                className="inline-flex rounded-full border border-dashed border-amber-dim px-sm py-xs font-semibold tracking-[0.05em] text-amber-dim uppercase"
              >
                <span aria-hidden="true">source task removed/changed</span>
                <span className="sr-only">
                  Source task {task.sourceTaskState}
                </span>
              </span>
            ) : null}
          </div>
          <div className="mt-xs text-text-tertiary">
            materialized from {spec.slug}/
            {task.taskHandle ?? task.taskElementId}
            {task.sourceTaskState === "current"
              ? " · live read-through"
              : ` · re-scoped in rev ${spec.revision} — still read-through, never synced`}
          </div>
        </div>
      ))}
      <p className="m-0 font-mono text-[0.64rem] text-text-tertiary">
        The ticket persists only the link — phase, progress, and element status
        are read through it.
      </p>
    </article>
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
      return "green";
    case "running":
      return "cyan";
    case "failed":
      return "red";
    case "interrupted":
      return "amber";
    default:
      return "neutral";
  }
}
