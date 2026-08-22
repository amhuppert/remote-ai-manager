"use client";

import { CompactMarkdown } from "@/components/markdown/Markdown";
import { ExpandGlyphIcon } from "@/components/workflow-config/InspectorChips";
import { UpstreamInputsList } from "@/components/workflow-config/UpstreamInputsList";
import type { GraphWorkflowUpstreamInput } from "@/lib/workflow-graph/schemas";
import { acceptanceCriteriaText } from "@/lib/workflow-graph/criteria/criterion-records";
import { cn } from "@/lib/ui/cn";
import {
  GroupHeader,
  inspectorFocusRingClass,
  inspectorInsetFocusRingClass,
  inspectorSectionClass,
} from "./chrome";

/**
 * Tasks tab → Brief (§11): what this context was asked to do — its description,
 * its acceptance criteria and the upstream outputs bound into it.
 *
 * The two long-form fields are read views: the whole box is a click target that
 * hands off to the focus sheet, which is the one place long prose is read in
 * full. Keyboard users reach the same sheet with Enter/Space.
 */

export type BriefField = "description" | "acceptanceCriteria";

const fieldActionClass = cn(
  "inline-flex cursor-pointer items-center gap-[5px] rounded-sm border-0 bg-transparent px-[6px] py-[2px] font-mono text-[0.7rem] text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary max-768:min-h-[44px] max-768:min-w-[44px] max-768:justify-center",
  inspectorFocusRingClass,
);

const readViewClass =
  "relative w-full box-border cursor-pointer rounded-sm border border-solid border-border-default bg-bg-base px-[14px] py-[10px] text-left font-[inherit] text-[0.8rem] leading-[1.6] text-text-primary transition-[border-color] duration-150 hover:border-border-strong";

const readViewControlClass = cn(
  "absolute inset-0 cursor-pointer rounded-sm border-0 bg-transparent p-0 max-768:min-h-[44px]",
  inspectorInsetFocusRingClass,
);

/**
 * The preview sits ON TOP of the box-wide control and is inert to the pointer,
 * so a click anywhere in the prose falls through to the control beneath — except
 * on a link, which opts back in. That keeps both behaviours the Brief had before
 * the rail was reworked: the whole box opens the focus sheet, and a link in the
 * description or the acceptance criteria is still directly clickable.
 */
const readViewPreviewClass =
  "relative max-h-[220px] overflow-hidden pointer-events-none [&_a]:pointer-events-auto";

const fieldLabelClass =
  "block text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

function MarkdownReadView({
  value,
  ariaLabel,
  onOpen,
}: {
  value: string;
  ariaLabel: string;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <div className={readViewClass}>
      {/* Rendered markdown brings its own links and code blocks, so the control
          cannot wrap it — interactive content inside a button is invalid and
          swallows what it contains. The button spans the box behind the prose
          instead: a real focusable control whose ring traces the read view it
          opens. */}
      <button
        type="button"
        aria-label={ariaLabel}
        className={readViewControlClass}
        onClick={onOpen}
      />
      <div data-testid="brief-read-view" className={readViewPreviewClass}>
        <CompactMarkdown content={value} />
      </div>
    </div>
  );
}

function BriefField({
  label,
  ariaLabel,
  value,
  onOpen,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-xs flex items-center justify-between">
        <span className={fieldLabelClass}>{label}</span>
        <button type="button" className={fieldActionClass} onClick={onOpen}>
          <ExpandGlyphIcon /> Open
        </button>
      </div>
      <MarkdownReadView value={value} ariaLabel={ariaLabel} onOpen={onOpen} />
    </div>
  );
}

export default function BriefSection({
  description,
  acceptanceCriteria,
  upstreamInputs,
  onOpenField,
}: {
  description: string | null | undefined;
  acceptanceCriteria: Parameters<typeof acceptanceCriteriaText>[0];
  upstreamInputs: GraphWorkflowUpstreamInput[];
  onOpenField: (field: BriefField) => void;
}): React.JSX.Element {
  return (
    <section className={inspectorSectionClass} data-section="brief">
      <GroupHeader label="Brief" />
      <div className="flex flex-col gap-md">
        {description ? (
          <BriefField
            label="Description"
            ariaLabel="View description"
            value={description}
            onOpen={() => onOpenField("description")}
          />
        ) : null}
        {/* The canonical text rendering (#69 change 4 stage 1): prose passes
            through byte-identical, records render as numbered `[id]` lines —
            markdown turns them into the numbered-record list validator verdicts
            cite. */}
        <BriefField
          label="Acceptance criteria"
          ariaLabel="View acceptance criteria"
          value={acceptanceCriteriaText(acceptanceCriteria)}
          onOpen={() => onOpenField("acceptanceCriteria")}
        />
        <UpstreamInputsList inputs={upstreamInputs} />
      </div>
    </section>
  );
}
