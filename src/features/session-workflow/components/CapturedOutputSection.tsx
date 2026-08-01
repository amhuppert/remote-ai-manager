"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "@/components/icons";
import { JsonTree } from "@/components/ui/JsonTree";
import { SectionLabel } from "@/components/ui/SectionHeader";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  describeOutputSchemaFields,
  getContextOutput,
  outputSchemasMatch,
  summarizeOutputSchemaShape,
} from "@/lib/workflow-graph/context-outputs";
import type { GraphWorkflowValidationResultEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowContextOutput,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import { cn } from "@/lib/ui/cn";

// The "Output" group on the execution inspector's Tasks tab: one output per
// context, so it reads as a property of the context rather than a log entry.
// The group is rendered ONLY for a context that declares an `outputSchema` —
// a schema-less context has no contract to report against, and an explanatory
// placeholder there would be noise on the majority of contexts.

const COPY_CONFIRM_MS = 1600;

/**
 * What the Output group shows. `rejected` is deliberately a peer of `pending`
 * rather than a flag on it: a refused candidate is evidence about a contract
 * that is still owed, and collapsing the two would either hide the payload the
 * operator needs or imply the context banked something it did not.
 */
export type CapturedOutputView =
  | { kind: "pending"; outputSchema: Record<string, unknown> }
  | { kind: "captured"; output: GraphWorkflowContextOutput }
  | {
      kind: "rejected";
      /** The refused text, verbatim — it may not be parseable JSON at all. */
      rejectedOutput: string | null;
      iteration: number | null;
      occurredAt: string | null;
    };

/**
 * Resolves the group's state from the execution and this context's validation
 * history. Reads "what did this context produce" through the D6 accessor, never
 * `execution.contextOutputs` directly, so the UI and the prompt injection agree
 * on what counts as captured.
 *
 * `validationEvents` are this context's results, newest first.
 */
export function resolveCapturedOutputView(
  execution: GraphWorkflowExecution,
  contextId: string,
  validationEvents: ReadonlyArray<
    GraphWorkflowValidationResultEvent & { occurredAt: string }
  >,
): CapturedOutputView | null {
  const lookup = getContextOutput(execution, contextId);
  // `orphaned` renders nothing for the same reason `none` does: R7.6 scopes this
  // group to schema-DECLARING contexts, and a payload left behind by a cleared
  // contract has no contract to report against.
  if (lookup.kind === "none" || lookup.kind === "orphaned") return null;
  if (lookup.kind === "captured") {
    return { kind: "captured", output: lookup.output };
  }

  // A rejection only speaks for the contract it was measured against. The
  // Edit-schema action on the halt surfaces exists to replace a too-tight
  // contract while the halt is open, and after that edit the old refusal is
  // evidence about a contract this context no longer declares — the group falls
  // back to Pending rather than captioning the new contract with it. Records
  // written before the snapshot existed carry no schema and are attributed to
  // the context, which is where they came from.
  const rejection = validationEvents.find(
    (event) =>
      event.kind === "output_schema" &&
      !event.pass &&
      (event.rejectedAgainstSchema === undefined ||
        outputSchemasMatch(event.rejectedAgainstSchema, lookup.outputSchema)),
  );
  if (rejection === undefined) {
    return { kind: "pending", outputSchema: lookup.outputSchema };
  }
  return {
    kind: "rejected",
    rejectedOutput: rejection.rejectedOutput,
    iteration: execution.contextStates[contextId]?.iterationCount ?? null,
    occurredAt: rejection.occurredAt,
  };
}

function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "object · 3 fields · 2 required" — the contract's size, not its text. */
function describeContract(outputSchema: Record<string, unknown>): string {
  const shape = summarizeOutputSchemaShape(outputSchema);
  const fields = describeOutputSchemaFields(outputSchema);
  const parts = [shape.type ?? "schema"];
  if (shape.fieldCount !== null) {
    parts.push(
      `${shape.fieldCount} ${shape.fieldCount === 1 ? "field" : "fields"}`,
    );
  }
  const requiredCount = fields?.filter((field) => field.required).length ?? 0;
  if (requiredCount > 0) {
    parts.push(`${requiredCount} required`);
  }
  return parts.join(" · ");
}

const panelClass =
  "overflow-hidden rounded-sm border border-solid border-border-default bg-bg-base";
const provenanceStripClass =
  "flex flex-wrap items-center gap-[5px] border-b border-solid border-border-dim bg-[var(--cc-graph-ink-a55)] px-[10px] py-[6px]";
const noteClass = "mt-[6px] text-[0.7rem] leading-[1.5] text-text-tertiary";

function CopyOutputButton({ value }: { value: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(JSON.stringify(value, null, 2))
      .then(() => {
        setCopied(true);
        if (resetTimer.current !== null) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(
          () => setCopied(false),
          COPY_CONFIRM_MS,
        );
      });
  }, [value]);

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex h-[22px] shrink-0 cursor-pointer items-center gap-[5px] rounded-sm border border-solid border-border-default bg-bg-raised px-[8px] py-[3px] text-[0.7rem] font-medium text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary"
      >
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        {copied ? "Copied" : "Copy output"}
      </button>
      {/* The label swap is silent to a reader who is not on the button. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Output copied to clipboard" : ""}
      </span>
    </>
  );
}

function StatusChipForView({ view }: { view: CapturedOutputView }) {
  if (view.kind === "captured") {
    return (
      <StatusChip tone="green" data-testid="captured-output-status">
        Captured
      </StatusChip>
    );
  }
  if (view.kind === "rejected") {
    return (
      <StatusChip tone="red" data-testid="captured-output-status">
        Rejected
      </StatusChip>
    );
  }
  return (
    <StatusChip tone="neutral" data-testid="captured-output-status">
      Pending
    </StatusChip>
  );
}

function CapturedBody({ output }: { output: GraphWorkflowContextOutput }) {
  const { parse } = output;
  // `native` is the backend handing back the payload it was asked for; every
  // other source means the gate had to recover it from prose, which is worth
  // noticing when the payload later looks wrong.
  const parseTone = parse.source === "native" ? "neutral" : "amber";
  const repairAttempts =
    parse.repaired === true ? (parse.repairAttempts ?? 1) : null;

  return (
    <div className={panelClass}>
      <div
        className={provenanceStripClass}
        data-testid="captured-output-provenance"
      >
        <StatusChip tone={parseTone} data-testid="captured-output-parse">
          parse · {parse.source}
        </StatusChip>
        {repairAttempts !== null && (
          <StatusChip tone="amber" data-testid="captured-output-repair">
            repair turn · {repairAttempts}
          </StatusChip>
        )}
        <span className="ml-auto text-[0.7rem] whitespace-nowrap text-text-tertiary">
          iteration {output.iteration} · {formatClockTime(output.capturedAt)}
        </span>
      </div>
      <JsonTree value={output.value} defaultCollapsedDepth={2} />
    </div>
  );
}

export interface CapturedOutputSectionProps {
  /** `null` for a context that declares no schema — the group is not rendered. */
  view: CapturedOutputView | null;
}

export default function CapturedOutputSection({
  view,
}: CapturedOutputSectionProps): React.JSX.Element | null {
  if (view === null) return null;

  return (
    <section className="mb-lg" data-section="output">
      <div className="mb-[10px] flex items-center gap-sm">
        <SectionLabel>Output</SectionLabel>
        <StatusChipForView view={view} />
        <span aria-hidden="true" className="h-px flex-1 bg-border-dim" />
        {view.kind === "captured" && (
          <CopyOutputButton value={view.output.value} />
        )}
      </div>

      {view.kind === "pending" && (
        <>
          <div
            data-testid="captured-output-pending"
            className="w-full rounded-sm border border-dashed border-border-default px-md py-[14px] text-[0.74rem] leading-[1.5] text-text-tertiary"
          >
            Output pending — captured when this context completes.
          </div>
          <div className={noteClass} data-testid="captured-output-contract">
            Contract:{" "}
            <code className="rounded-[3px] bg-bg-raised px-[5px] py-px text-text-secondary">
              {describeContract(view.outputSchema)}
            </code>
          </div>
        </>
      )}

      {view.kind === "captured" && <CapturedBody output={view.output} />}

      {view.kind === "rejected" && (
        <>
          <div
            className={cn(panelClass, "border-[var(--cc-red-a25)]")}
            data-testid="captured-output-rejected"
          >
            {(view.iteration !== null || view.occurredAt !== null) && (
              <div className={provenanceStripClass}>
                <span className="ml-auto text-[0.7rem] whitespace-nowrap text-text-tertiary">
                  {view.iteration !== null ? `iteration ${view.iteration}` : ""}
                  {view.iteration !== null && view.occurredAt !== null
                    ? " · "
                    : ""}
                  {view.occurredAt !== null
                    ? formatClockTime(view.occurredAt)
                    : ""}
                </span>
              </div>
            )}
            <pre className="m-0 overflow-x-auto px-[10px] py-2 font-mono text-[0.72rem] leading-[1.6] whitespace-pre-wrap text-text-secondary">
              {view.rejectedOutput ?? "(the format turn produced no payload)"}
            </pre>
          </div>
          <div
            className={noteClass}
            data-testid="captured-output-rejected-note"
          >
            Not captured — the context stays incomplete. The offending value is
            kept for inspection only.
          </div>
        </>
      )}
    </section>
  );
}
