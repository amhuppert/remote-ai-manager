import { StatusChip } from "@/components/ui/StatusChip";
import type { GraphWorkflowUpstreamInput } from "@/lib/workflow-graph/context-outputs";
import { cn } from "@/lib/ui/cn";

/**
 * "Inputs from upstream" — what structured data this context's prompt will
 * actually contain, on the builder inspector and the execution inspector (D8).
 *
 * Read-only and resolver-fed: the rows come from
 * `resolveDefinitionUpstreamInputs`/`resolveUpstreamInputs`, and this component
 * never touches edges or the context list. That is the point — the injection
 * scope (Q2: direct predecessors only) is answered once, next to the prompt
 * builder that obeys it, so changing it never means changing this file.
 *
 * The design mock's scope selector is deliberately absent: Q2 closed to
 * direct-predecessors-only, and a control with one reachable value is a lie
 * about what the engine will do. Its per-row "direct/transitive" relation label
 * went with it — every row is direct.
 */

const LABEL =
  "text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

// Same glyph vocabulary as the graph node's schema indicator (R7.7): filled
// once a payload is banked, hollow while one is owed. A schema-less upstream
// gets a muted dot instead of nothing, so the field-chip column stays aligned
// and the row still reads as a listed input rather than an omission.
const GLYPH = {
  captured: "◈",
  declared: "◇",
  none: "·",
  skipped: "⊘",
} as const;

const GLYPH_TONE = {
  captured: "text-green",
  declared: "text-text-secondary",
  none: "text-text-tertiary",
  skipped: "text-text-tertiary",
} as const;

const GLYPH_LABEL = {
  captured: "Output captured",
  declared: "Output schema declared — not yet captured",
  none: "No output schema",
  skipped: "Skipped — branch not taken",
} as const;

type RowState = keyof typeof GLYPH;

// Declaration state comes from the resolver's `declared` flag, never from
// `schemaFields`: a valid contract can name no top-level fields (a bare object,
// a root `oneOf`), and greying such a row would call a declared upstream
// free-form and drop it from the count.
//
// `skipped` outranks both (D4 R4.3): a not-taken branch owes nothing, so the
// hollow "declared, not yet captured" glyph would promise an input that is
// never coming.
function rowState(input: GraphWorkflowUpstreamInput): RowState {
  if (input.skipped) return "skipped";
  if (!input.declared) return "none";
  return input.output === null ? "declared" : "captured";
}

function UpstreamRow({
  input,
}: {
  input: GraphWorkflowUpstreamInput;
}): React.JSX.Element {
  const state = rowState(input);
  const declared = input.declared;

  return (
    <li
      data-testid="upstream-input-row"
      data-context-id={input.contextId}
      data-declared={declared ? "true" : "false"}
      data-captured={state === "captured" ? "true" : "false"}
      className="flex list-none flex-col gap-[4px] border-x-0 border-t-0 border-b border-solid border-border-dim px-[10px] py-[8px] last:border-b-0"
    >
      <div className="flex items-baseline gap-sm">
        <span
          role="img"
          aria-label={GLYPH_LABEL[state]}
          title={GLYPH_LABEL[state]}
          className={cn(
            "w-[12px] shrink-0 text-center text-[0.72rem]",
            GLYPH_TONE[state],
          )}
        >
          {GLYPH[state]}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 overflow-hidden text-[0.76rem] font-semibold text-ellipsis whitespace-nowrap",
            declared ? "text-text-primary" : "text-text-tertiary",
          )}
        >
          {input.title}
        </span>
      </div>

      {input.schemaFields !== null && input.schemaFields.length > 0 ? (
        <div className="flex flex-wrap gap-[4px] pl-[20px]">
          {input.schemaFields.map((field) => (
            <span
              key={field.name}
              data-testid="upstream-input-field"
              title={`${field.name}${field.type === null ? "" : ` · ${field.type}`}${field.required ? " · required" : ""}`}
              className="inline-flex items-center rounded-[3px] bg-bg-raised px-[5px] py-px font-mono text-[0.68rem] text-text-secondary"
            >
              {field.name}
            </span>
          ))}
        </div>
      ) : (
        <div
          data-testid="upstream-input-prose"
          className="pl-[20px] text-[0.7rem] text-text-tertiary"
        >
          {declared
            ? "Declared with no named top-level fields — its whole payload is injected."
            : "No schema — its work reaches this context as prose only."}
        </div>
      )}
    </li>
  );
}

export interface UpstreamInputsListProps {
  /** Direct predecessors, resolver-ordered. Empty means the block is absent. */
  inputs: GraphWorkflowUpstreamInput[];
}

export function UpstreamInputsList({
  inputs,
}: UpstreamInputsListProps): React.JSX.Element | null {
  // A context with no predecessors is the common leaf case; an explanatory
  // placeholder there would be noise on every root context.
  if (inputs.length === 0) return null;

  const declaredCount = inputs.filter((input) => input.declared).length;

  return (
    <div data-testid="upstream-inputs">
      <div className="mb-xs flex items-center justify-between gap-sm">
        <span className={LABEL}>Inputs from upstream</span>
        <StatusChip tone="neutral" data-testid="upstream-inputs-count">
          {declaredCount} of {inputs.length} declared
        </StatusChip>
      </div>

      <ul className="m-0 list-none overflow-hidden rounded-sm border border-solid border-border-default bg-bg-base p-0">
        {inputs.map((input) => (
          <UpstreamRow key={input.contextId} input={input} />
        ))}
      </ul>

      <div
        data-testid="upstream-inputs-note"
        className="mt-[6px] text-[0.7rem] leading-[1.5] text-text-tertiary"
      >
        {declaredCount === 0
          ? "No upstream context declares an output schema — nothing structured is injected into this context's prompt."
          : "Declared outputs are injected into this context's prompt as JSON, above its own brief."}
      </div>
    </div>
  );
}
