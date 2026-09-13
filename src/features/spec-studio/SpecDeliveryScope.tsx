"use client";

import { useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/Accordion";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/Collapsible";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/Tabs";
import { createClientLogger } from "@/lib/logging/client-logger";
import type {
  CriterionDeliveryClass,
  DeliveryDeltaElementClass,
  DeliveryDeltaProjection,
} from "@/lib/specs/delivery-delta";
import type { SpecDetailView } from "@/lib/specs/queries";
import type { SpecElementPayload } from "@/lib/specs/schemas";
import { cn } from "@/lib/ui/cn";
import SpecDeliveryElementPreview, {
  deliveryElementText,
  deliveryElementTitle,
} from "./SpecDeliveryElementPreview";

const logger = createClientLogger("spec-studio-delivery");
const PAGE_SIZE = 8;
const criteriaPresentation: Record<
  CriterionDeliveryClass,
  { label: string; tone: StatusChipTone }
> = {
  hard_stale: { label: "Needs revalidation", tone: "red" },
  soft_stale: { label: "Review changes", tone: "amber" },
  never_delivered: { label: "Never delivered", tone: "cyan" },
  deferred: { label: "Deferred", tone: "neutral" },
  waived: { label: "Waived", tone: "neutral" },
  delivered_and_fresh: { label: "Delivered & fresh", tone: "green" },
};
const elementPresentation: Record<
  DeliveryDeltaElementClass,
  { label: string; tone: StatusChipTone }
> = {
  added: { label: "Added", tone: "cyan" },
  amended: { label: "Amended", tone: "amber" },
  removed: { label: "Removed", tone: "red" },
  unchanged: { label: "Unchanged", tone: "neutral" },
};

type ScopeRow = {
  id: string;
  handle: string;
  kind: SpecElementPayload["kind"];
  status: string;
  label: string;
  tone: StatusChipTone;
  payload: SpecElementPayload | undefined;
  revisionId: string;
  revisionNumber: number;
  removed: boolean;
};

export default function SpecDeliveryScope({
  detail,
  projectName,
  projection,
  besidePlan = false,
}: {
  detail: SpecDetailView;
  projectName: string;
  projection: DeliveryDeltaProjection;
  besidePlan?: boolean;
}): React.JSX.Element {
  const counts = projection.counts.criteria;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const snapshots = [
    detail.currentApprovedRevision,
    detail.currentRevision,
    detail.baseRevision,
    ...detail.executionRevisionSnapshots,
  ];
  function contentFor(id: string, removed: boolean) {
    const ref =
      removed && projection.base ? projection.base : projection.current;
    return {
      ...ref,
      payload: snapshots
        .find((snapshot) => snapshot?.revision.id === ref.revisionId)
        ?.elements.find((entry) => entry.element.id === id)?.version.payload,
    };
  }
  const criteria: ScopeRow[] = projection.criteria.map((row) => ({
    id: row.criterionElementId,
    handle: row.handle,
    kind: "criterion",
    status: row.class,
    ...criteriaPresentation[row.class],
    ...contentFor(row.criterionElementId, false),
    removed: false,
  }));
  const elements: ScopeRow[] = projection.elements.map((row) => ({
    id: row.elementId,
    handle: row.handle,
    kind: row.kind,
    status: row.class,
    ...elementPresentation[row.class],
    ...contentFor(row.elementId, row.class === "removed"),
    removed: row.class === "removed",
  }));
  return (
    <section
      aria-label="Delivery delta"
      className={cn(
        "font-mono",
        besidePlan ? "contents" : "grid min-w-0 gap-xl",
      )}
    >
      <div className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-xl max-768:p-lg">
        <div className="flex flex-wrap items-start justify-between gap-md">
          <div>
            <h3 className="m-0 font-display text-[1.05rem] font-bold text-text-primary">
              Delivery coverage
            </h3>
            <p className="mt-xs mb-0 text-[0.72rem] leading-relaxed text-text-secondary">
              {projection.comparedExecution === null
                ? `Revision ${projection.current.revisionNumber} · No delivered execution yet.`
                : `Revision ${projection.current.revisionNumber} · Compared with delivered revision ${projection.base?.revisionNumber ?? "unknown"}.`}
            </p>
          </div>
          <span className="text-[0.7rem] text-text-tertiary">
            Delivery history across {total} criteria
          </span>
        </div>
        <div className="mt-xl grid grid-cols-4 gap-lg max-768:grid-cols-2">
          <Metric
            label="Delivered & fresh"
            value={counts.delivered_and_fresh}
            tone="green"
          />
          <Metric
            label="Never delivered"
            value={counts.never_delivered}
            tone="cyan"
          />
          <Metric
            label="Needs review"
            value={counts.hard_stale + counts.soft_stale}
            tone="amber"
          />
          <Metric
            label="Deferred / waived"
            value={counts.deferred + counts.waived}
            tone="neutral"
          />
        </div>
        <progress
          aria-label="Delivered and fresh criteria"
          max={Math.max(total, 1)}
          value={counts.delivered_and_fresh}
          className="mt-lg block h-[6px] w-full overflow-hidden rounded-sm border-0 bg-bg-raised accent-green [&::-moz-progress-bar]:bg-green [&::-webkit-progress-bar]:bg-bg-raised [&::-webkit-progress-value]:bg-green"
        />
        <p className="mt-sm mb-0 text-[0.7rem] leading-relaxed text-text-tertiary">
          {total === 0
            ? "No acceptance criteria in the approved scope."
            : "Coverage includes verified and accepted delivery. Work awaiting merge appears in the delivery review."}
        </p>
      </div>
      <div
        className={cn(
          "grid min-w-0 gap-md",
          besidePlan && "col-span-2 max-1180:col-span-1",
        )}
      >
        <div>
          <h3 className="m-0 font-display text-[1rem] font-bold text-text-primary">
            Scope for the next plan
          </h3>
          <p className="mt-xs mb-0 text-[0.72rem] leading-relaxed text-text-secondary">
            Inspect criteria and spec changes. Expand a row to read its content.
          </p>
        </div>
        {projection.advisories.length > 0 && (
          <Collapsible asChild>
            <div className="rounded-md border border-solid border-amber-dim bg-bg-base p-md">
              <CollapsibleTrigger asChild>
                <Button size="sm" touch>
                  Carry-forward advisories · {projection.advisories.length}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-md grid list-none gap-sm p-0 text-[0.72rem] leading-relaxed text-text-primary">
                  {projection.advisories.map((advisory) => (
                    <li key={advisory.criterionElementId}>
                      {advisory.message}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </div>
          </Collapsible>
        )}
        <TabsRoot
          defaultValue="criteria"
          onValueChange={(view) =>
            logger.info("spec_studio.delivery.scope_view", {
              specId: detail.spec.id,
              view,
            })
          }
        >
          <TabsList aria-label="Delivery scope">
            <TabsTrigger value="criteria" touch>
              Criteria · {criteria.length}
            </TabsTrigger>
            <TabsTrigger value="elements" touch>
              Spec changes ·{" "}
              {elements.filter((row) => row.status !== "unchanged").length}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="criteria">
            <ScopeList
              rows={criteria}
              detail={detail}
              projectName={projectName}
              type="criteria"
            />
          </TabsContent>
          <TabsContent value="elements">
            <ScopeList
              rows={elements}
              detail={detail}
              projectName={projectName}
              type="elements"
            />
          </TabsContent>
        </TabsRoot>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "cyan" | "amber" | "neutral";
}): React.JSX.Element {
  return (
    <div data-tone={tone} className="group grid gap-sm">
      <span className="text-[1.65rem] leading-none font-semibold text-text-primary tabular-nums group-data-[tone=amber]:text-amber group-data-[tone=cyan]:text-cyan group-data-[tone=green]:text-green">
        {value}
      </span>
      <span className="text-[0.7rem] font-medium text-text-secondary">
        {label}
      </span>
    </div>
  );
}

function ScopeList({
  rows,
  detail,
  projectName,
  type,
}: {
  rows: ScopeRow[];
  detail: SpecDetailView;
  projectName: string;
  type: "criteria" | "elements";
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(type === "elements" ? "changed" : "all");
  const [page, setPage] = useState(0);
  const term = search.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    const matchesStatus =
      status === "all" ||
      (status === "changed"
        ? row.status !== "unchanged"
        : row.status === status);
    const text = [
      row.handle,
      row.kind,
      row.label,
      row.payload ? deliveryElementText(row.payload) : "",
    ]
      .join(" ")
      .toLocaleLowerCase();
    return matchesStatus && (!term || text.includes(term));
  });
  const maxPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, maxPage);
  const visible = filtered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const options =
    type === "criteria" ? criteriaPresentation : elementPresentation;
  return (
    <div className="mt-md grid min-w-0 gap-md">
      <div className="flex items-center gap-md max-768:flex-col max-768:items-stretch">
        <FormInput
          aria-label="Search scope"
          placeholder="Search by content or reference…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          layoutClassName="grow"
        />
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(0);
            logger.info("spec_studio.delivery.scope_filter", {
              specId: detail.spec.id,
              type,
              status: value,
            });
          }}
        >
          <SelectTrigger
            aria-label="Scope status"
            layoutClassName="w-[230px] shrink-0 max-768:w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              All {type === "criteria" ? "criteria" : "elements"} ·{" "}
              {rows.length}
            </SelectItem>
            {type === "elements" && (
              <SelectItem value="changed">
                Changed elements ·{" "}
                {rows.filter((row) => row.status !== "unchanged").length}
              </SelectItem>
            )}
            {Object.entries(options).map(([value, presentation]) => (
              <SelectItem key={value} value={value}>
                {presentation.label} ·{" "}
                {rows.filter((row) => row.status === value).length}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {visible.length === 0 ? (
        <div
          role="status"
          className="rounded-md border border-solid border-border-subtle bg-bg-surface p-xl text-[0.78rem] text-text-secondary"
        >
          {rows.length === 0
            ? `No ${type === "criteria" ? "criteria" : "elements"} in this scope.`
            : "No matching items. Adjust the search or status filter."}
        </div>
      ) : (
        <Accordion
          type="single"
          collapsible
          key={`${status}-${search}-${currentPage}`}
          onValueChange={(elementId) => {
            if (elementId)
              logger.info("spec_studio.delivery.element_opened", {
                specId: detail.spec.id,
                elementId,
              });
          }}
        >
          {visible.map((row) => (
            <AccordionItem key={row.id} value={row.id}>
              <AccordionTrigger asChild>
                <button
                  type="button"
                  className="group grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-md border-0 bg-bg-surface p-lg text-left font-mono text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px] data-[state=closed]:hover:bg-bg-raised data-[state=open]:bg-bg-raised data-[state=open]:hover:bg-bg-elevated max-768:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <span className="grid min-w-0 gap-xs">
                    <span className="text-[0.7rem] text-text-tertiary group-hover:text-text-primary group-data-[state=open]:text-text-primary">
                      {row.kind === "section"
                        ? "Section"
                        : `${row.handle} · ${row.kind}`}
                    </span>
                    <span className="line-clamp-2 text-[0.82rem] leading-relaxed [overflow-wrap:anywhere]">
                      {row.payload
                        ? deliveryElementTitle(row.payload) ||
                          "Untitled element"
                        : "Expand to read element content"}
                    </span>
                  </span>
                  <StatusChip
                    tone={row.tone}
                    layoutClassName="max-768:col-start-1 max-768:row-start-2 max-768:justify-self-start"
                  >
                    {row.label}
                  </StatusChip>
                  <ChevronDownIcon
                    size={20}
                    className="shrink-0 text-text-tertiary group-data-[state=open]:rotate-180 max-768:col-start-2 max-768:row-start-1"
                  />
                </button>
              </AccordionTrigger>
              <AccordionContent asChild>
                <div className="border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-base p-lg">
                  <SpecDeliveryElementPreview
                    projectName={projectName}
                    slug={detail.spec.slug}
                    handle={row.handle}
                    kind={row.kind}
                    payload={row.payload}
                    revisionId={row.revisionId}
                    revisionNumber={row.revisionNumber}
                    removed={row.removed}
                  />
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <span role="status" className="text-[0.7rem] text-text-tertiary">
          {filtered.length === 0
            ? "0 items"
            : `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length}`}
        </span>
        {maxPage > 0 && (
          <div className="flex gap-sm">
            <Button
              size="sm"
              touch
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              touch
              disabled={currentPage === maxPage}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
