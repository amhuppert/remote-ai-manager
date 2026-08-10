"use client";

import { useQuery } from "@tanstack/react-query";

import { StatusChip } from "@/components/ui/StatusChip";
import { specQueries } from "@/lib/specs/queries";
import type { SpecRevision } from "@/lib/specs/schemas";
import type { SpecPlanPreviewView } from "@/lib/specs/view-schemas";

/**
 * What launching the reviewed revision would compile, shown next to the change
 * set that decides it.
 *
 * The whole projection comes from `/plan-preview`, which materializes through
 * the compiler's own body: lane-group collapse, the union of task criterion
 * briefs into a context's acceptance contract, and edge derivation from task
 * dependencies are all decided there. Studio recomputes none of it — a second,
 * client-side derivation could only be a guess at the plan the launch actually
 * produces, and planning blindness is exactly the defect this closes.
 *
 * The panel takes the revision from Review's own selection model, so the plan
 * it previews is always the proposal the reviewer is looking at — including a
 * stranded one (#50).
 */
export default function SpecPlanPreviewPanel({
  projectName,
  slug,
  revision,
}: {
  projectName: string;
  slug: string;
  /** The proposal the Review surface is showing. */
  revision: SpecRevision;
}): React.JSX.Element | null {
  // Only a plan-stage revision carries the tasks a plan compiles from; at the
  // requirements and design stages there is no plan to preview yet, and an
  // empty panel would read as "this compiles to nothing".
  const compilable = revision.authoringStage === "plan";
  const preview = useQuery({
    ...specQueries.planPreview(projectName, slug, revision.id),
    enabled: compilable,
  });
  if (!compilable) return null;

  return (
    <section
      data-testid="plan-preview-panel"
      aria-label={`Compiled plan preview for revision ${revision.number}`}
      className="mt-lg overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <div className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <h2 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
          Compiled plan preview
        </h2>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          Revision {revision.number} as the compiler would build it
        </span>
      </div>

      {/*
        The refusal wins over a cached body: a preview compiled for this
        revision before an edit invalidated it would otherwise stay on screen
        under the same heading, and a reviewer cannot tell a stale plan from a
        current one by looking at it.
      */}
      {preview.error !== null ? (
        <p
          role="alert"
          className="m-md rounded-md border border-solid border-red-dim bg-red-glow px-md py-sm font-mono text-[0.72rem] leading-relaxed text-red"
        >
          {preview.error instanceof Error
            ? preview.error.message
            : "The plan preview could not be compiled."}
        </p>
      ) : preview.data === undefined ? (
        <p className="m-0 px-md py-lg font-mono text-[0.72rem] text-text-tertiary">
          Compiling the plan…
        </p>
      ) : (
        <PreviewBody preview={preview.data} />
      )}
    </section>
  );
}

function PreviewBody({
  preview,
}: {
  preview: SpecPlanPreviewView;
}): React.JSX.Element {
  return (
    <div className="grid gap-md px-md py-md">
      <div className="flex flex-wrap items-center gap-sm">
        <StatusChip tone="neutral">
          {countLabel(preview.totalContextCount, "context", "contexts")}
        </StatusChip>
        <StatusChip tone="neutral">
          {countLabel(preview.taskCount, "task", "tasks")}
        </StatusChip>
        <StatusChip tone="neutral">
          {countLabel(preview.edges.length, "edge", "edges")}
        </StatusChip>
        <StatusChip tone="neutral">
          {countLabel(
            preview.criterionCount,
            "selected criterion",
            "selected criteria",
          )}
        </StatusChip>
        {/*
          Both of these outrun a 390px row: the approval sentence is a full
          clause and the scope hash is a 64-character digest. The panel clips
          its overflow to keep its rounded edge, so they have to wrap inside it
          — a launch-gating term or a truncated hash the reader cannot compare
          is worse than a taller row.
        */}
        <StatusChip wrap tone={preview.approvalRequired ? "amber" : "neutral"}>
          {preview.approvalRequired
            ? "A human approves the compiled definition before the lanes run"
            : "No human approval gates the launch"}
        </StatusChip>
        <span className="min-w-0 font-mono text-[0.7rem] [overflow-wrap:anywhere] break-words text-text-tertiary">
          scope {preview.scopeHash}
        </span>
      </div>

      {preview.evidenceGaps.length > 0 && (
        <p
          data-testid="plan-preview-evidence-gaps"
          className="m-0 rounded-md border border-solid border-amber-dim bg-amber-glow px-md py-sm font-mono text-[0.72rem] leading-relaxed text-amber"
        >
          {`Evidence gaps: ${preview.evidenceGaps.join(", ")} — nothing in the ingest path mints these, so a criterion requiring one can never reach a proof. Narrow the strategy to a produced kind before launch.`}
        </p>
      )}

      <PreviewEdges edges={preview.edges} />

      <div className="grid gap-sm">
        {preview.contexts.map((context) => (
          <PreviewContext key={context.contextId} context={context} />
        ))}
      </div>
    </div>
  );
}

function PreviewEdges({
  edges,
}: {
  edges: SpecPlanPreviewView["edges"];
}): React.JSX.Element {
  if (edges.length === 0) {
    return (
      <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
        No edges — every context starts immediately.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-sm">
      <span className="font-mono text-[0.7rem] tracking-[0.08em] text-text-tertiary uppercase">
        Edges
      </span>
      <ul className="m-0 flex list-none flex-wrap gap-xs p-0">
        {edges.map((edge) => (
          <li
            key={edge.id}
            className="rounded-sm border border-solid border-border-dim bg-bg-base px-sm py-2xs font-mono text-[0.7rem] text-text-secondary"
          >
            {`${edge.sourceContextId} → ${edge.targetContextId}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewContext({
  context,
}: {
  context: SpecPlanPreviewView["contexts"][number];
}): React.JSX.Element {
  return (
    <article
      data-testid={`plan-preview-context-${context.contextId}`}
      className="rounded-md border border-solid border-border-dim bg-bg-base"
    >
      <div className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <span className="font-mono text-[0.72rem] font-bold text-cyan-dim">
          {context.contextId}
        </span>
        <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
          {context.title}
        </span>
      </div>
      <div className="grid gap-sm px-md py-sm">
        {context.description !== null && (
          <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-tertiary">
            {context.description}
          </p>
        )}
        <p className="m-0 font-mono text-[0.7rem] text-text-secondary">
          Tasks:{" "}
          {context.taskHandles.length === 0
            ? "none"
            : context.taskHandles.join(", ")}
        </p>
        {/*
          The context contract a validator receives is the union of exactly
          these briefs, so an omitted brief is a term of that contract the
          reviewer never read — the count says so rather than trailing off.
        */}
        <p className="m-0 font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
          {context.omittedBriefCount === 0
            ? `Criterion briefs unioned into this context's contract (${context.totalBriefCount})`
            : `Criterion briefs unioned into this context's contract (${context.shownBriefCount} of ${context.totalBriefCount}, ${context.omittedBriefCount} omitted — cctl spec plan preview --context ${context.contextId} prints them all)`}
        </p>
        <div className="grid gap-xs">
          {context.criterionBriefs.map((brief) => (
            <PreviewBrief key={brief.criterionElementId} brief={brief} />
          ))}
        </div>
      </div>
    </article>
  );
}

function PreviewBrief({
  brief,
}: {
  brief: SpecPlanPreviewView["contexts"][number]["criterionBriefs"][number];
}): React.JSX.Element {
  return (
    <div className="rounded-sm border border-solid border-border-dim bg-bg-surface px-sm py-xs">
      <div className="flex flex-wrap items-baseline gap-sm">
        <span className="font-mono text-[0.7rem] font-bold text-cyan-dim">
          {brief.criterionHandle}
        </span>
        <span className="min-w-0 font-mono text-[0.7rem] leading-relaxed text-text-primary">
          {brief.text}
        </span>
      </div>
      <p className="mt-xs mb-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
        {brief.brief}
      </p>
      <ul className="mt-xs mb-0 grid list-none gap-2xs p-0">
        {brief.evidence.map((row) => (
          <li
            key={row.kind}
            className="font-mono text-[0.7rem] leading-relaxed text-text-tertiary"
          >
            {row.producer === null ? (
              <span className="text-amber">
                {`${row.kind}: no producer — ${row.detail}`}
              </span>
            ) : (
              `${row.kind}: ${row.producer} — ${row.detail}`
            )}
          </li>
        ))}
      </ul>
      {brief.strategyNote !== null && (
        <p className="mt-xs mb-0 font-mono text-[0.7rem] leading-relaxed text-text-tertiary">
          Approved strategy note: {brief.strategyNote}
        </p>
      )}
    </div>
  );
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
