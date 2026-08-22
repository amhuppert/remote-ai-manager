"use client";

import { useState } from "react";
import { MultilineInput } from "@/components/MultilineInput";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
// The dependency-free subset module, NOT the gate that re-exports it: the gate
// creates a module-scope logger, which pulls `node:fs` into the browser bundle
// (a failure only `bun run build` reports). Importing the walker directly is
// also the single-source guarantee behind D2/R1.3 — the red errors below are
// literally the function the server refuses with.
import {
  OUTPUT_SCHEMA_SUPPORTED_KEYWORDS,
  validateOutputSchemaDeclaration,
  type OutputSchemaDeclarationIssue,
} from "@/lib/workflows/primitives/output-schema-subset";

/**
 * The hint line names the SUPPORTED keywords rather than a sample of refused
 * ones: it is derived from the descriptor, so it can never drift from what the
 * engine accepts, and it answers the author's actual question ("what may I
 * write?") instead of listing four of thirty refusals.
 */
const SUPPORTED_KEYWORD_LIST = Object.values(OUTPUT_SCHEMA_SUPPORTED_KEYWORDS)
  .flat()
  .join(", ");

/**
 * The seed an author gets from "+ Add schema": a concrete, fully-supported
 * declaration to edit down rather than a bare `{}` that immediately lints red.
 */
export const OUTPUT_SCHEMA_TEMPLATE = `{
  "type": "object",
  "properties": {
    "verdict": { "type": "string", "enum": ["pass", "fail", "blocked"] },
    "confidence": { "type": "number" },
    "blockers": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["verdict", "confidence"],
  "additionalProperties": false
}`;

/**
 * What the editor makes of the current text.
 *
 * `empty` and `ok` are the two states an owner may persist; `invalid-json` and
 * `unsupported` both carry a non-empty `issues` list and must block a save,
 * because `unsupported` is exactly what the definition accept path refuses.
 */
export type OutputSchemaTextStage =
  | "empty"
  | "ok"
  | "invalid-json"
  | "unsupported";

export interface OutputSchemaTextLint {
  stage: OutputSchemaTextStage;
  /** Empty exactly when the text is persistable (`empty` or `ok`). */
  issues: OutputSchemaDeclarationIssue[];
  /** Neutral chip copy (`object · 3 fields`), null unless the text parses. */
  shape: string | null;
  /** Green-line detail (`3 properties · 2 required`), null unless `ok`. */
  summary: string | null;
  /** The parsed document when — and only when — it is fully enforceable. */
  schema: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `line N · col M` for a JSON syntax error, derived from the `position` V8
 * reports in the message. A engine that omits it (JavaScriptCore states only
 * what it expected) degrades to the document root rather than inventing a
 * location.
 */
function locateSyntaxError(text: string, message: string): string {
  const match = /position (\d+)/.exec(message);
  if (!match?.[1]) return "$";
  const index = Number(match[1]);
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const column = index - before.lastIndexOf("\n");
  return `line ${line} · col ${column}`;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function describeShape(parsed: Record<string, unknown>): string {
  if (Array.isArray(parsed.oneOf)) {
    return `oneOf · ${pluralize(parsed.oneOf.length, "variant", "variants")}`;
  }
  const properties = isRecord(parsed.properties) ? parsed.properties : {};
  const type = typeof parsed.type === "string" ? parsed.type : "object";
  return `${type} · ${pluralize(Object.keys(properties).length, "field", "fields")}`;
}

function describeSummary(parsed: Record<string, unknown>): string {
  if (Array.isArray(parsed.oneOf)) {
    return pluralize(parsed.oneOf.length, "variant", "variants");
  }
  const properties = isRecord(parsed.properties) ? parsed.properties : {};
  const required = Array.isArray(parsed.required) ? parsed.required.length : 0;
  const count = pluralize(
    Object.keys(properties).length,
    "property",
    "properties",
  );
  return `${count} · ${required} required`;
}

/**
 * The editor's whole opinion about a schema draft, as a pure function of its
 * raw text — so both consuming surfaces gate their save on the same verdict
 * that produces the red lines the author is looking at.
 *
 * Subset violations come from `validateOutputSchemaDeclaration`, the same
 * walker every definition accept path runs (R1.3). This function adds only what
 * that walker cannot see: whether the text is JSON at all, and the display
 * summaries.
 */
export function lintOutputSchemaText(text: string): OutputSchemaTextLint {
  if (text.trim().length === 0) {
    return {
      stage: "empty",
      issues: [],
      shape: null,
      summary: null,
      schema: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stage: "invalid-json",
      issues: [
        {
          path: locateSyntaxError(text, message),
          message: message
            .replace(/ in JSON at position \d+.*$/, "")
            .replace(/^JSON\.parse: /, ""),
        },
      ],
      shape: null,
      summary: null,
      schema: null,
    };
  }

  const issues = validateOutputSchemaDeclaration(parsed);
  // A non-object document has no shape to summarise; the walker has already
  // said so at `$`.
  const shape = isRecord(parsed) ? describeShape(parsed) : null;
  if (issues.length > 0) {
    return { stage: "unsupported", issues, shape, summary: null, schema: null };
  }
  // The walker's root rule guarantees an object here; the guard keeps the
  // narrowing local rather than asserting it.
  if (!isRecord(parsed)) {
    return { stage: "unsupported", issues, shape, summary: null, schema: null };
  }
  return {
    stage: "ok",
    issues: [],
    shape,
    summary: describeSummary(parsed),
    schema: parsed,
  };
}

const LABEL =
  "text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

// The label row's inline affordance, matching the Brief group's Edit actions.
const INLINE_ACTION =
  "inline-flex cursor-pointer items-center gap-[5px] rounded-sm border-0 bg-transparent px-[6px] py-[2px] font-mono text-[0.7rem] text-text-tertiary transition-colors duration-150 hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]";

const HINT = "text-[0.7rem] leading-[1.5] text-text-tertiary";

const HEADLINE: Record<"invalid-json" | "unsupported", string> = {
  "invalid-json": "Invalid JSON",
  unsupported: "Unsupported schema",
};

/**
 * Why this text cannot be committed, in one line, for a surface that has room
 * for a row rather than for the editor's issue list — the builder's validation
 * strip lists it beside the errors the definition validator raised. Null when
 * nothing is refused: an absent contract is a legitimate choice.
 *
 * The copy is the editor's own headline and the walker's own message, so the
 * strip and the red lines under the textarea cannot say different things.
 */
export function describeOutputSchemaRefusal(text: string): string | null {
  const lint = lintOutputSchemaText(text);
  if (lint.stage === "ok" || lint.stage === "empty") return null;
  const headline =
    lint.stage === "invalid-json"
      ? HEADLINE["invalid-json"]
      : HEADLINE.unsupported;
  const first = lint.issues[0];
  return first === undefined ? headline : `${headline}: ${first.message}`;
}

export interface OutputSchemaFieldProps {
  /** Raw JSON text. Held as text — never as a parsed object — so a half-typed
   * schema survives a re-render or an SSE rebase. */
  value: string;
  onChange: (next: string) => void;
  /** Disables every affordance; pair with `readOnlyHint` to say why. */
  readOnly?: boolean;
  /** Mode-specific explanation rendered under the field when `readOnly`. */
  readOnlyHint?: string;
  /** Extra status line under the field (e.g. the live tier's unsaved hint). */
  footer?: React.ReactNode;
}

/**
 * The per-context output-schema editor, shared by the builder inspector's Brief
 * group and the execution config tab (D8).
 *
 * Identity content, not cascade config: it carries no provenance badge, no
 * source dot and no reset affordance, because `outputSchema` is per-context only
 * and has nothing to inherit from.
 *
 * The owner keeps the text; this component owns only the ephemeral "just
 * cleared" affordance, because clearing silently changes every downstream
 * context's prompt and deserves an undo the value alone cannot express.
 */
export function OutputSchemaField({
  value,
  onChange,
  readOnly = false,
  readOnlyHint,
  footer,
}: OutputSchemaFieldProps): React.JSX.Element {
  const [clearedFrom, setClearedFrom] = useState<string | null>(null);
  const lint = lintOutputSchemaText(value);
  const blank = lint.stage === "empty";
  // Gated on `readOnly` like every other affordance: this notice outlives the
  // keystroke that produced it, so the owner can go read-only underneath it (a
  // status change freezing the context). An enabled Undo would then be the one
  // live write left into a draft nothing can save.
  const showCleared = clearedFrom !== null && blank && !readOnly;
  const lineCount = value.length === 0 ? 1 : value.split("\n").length;

  function handleEdit(next: string) {
    setClearedFrom(null);
    onChange(next);
  }

  return (
    <div data-testid="output-schema-field" data-stage={lint.stage}>
      <div className="mb-xs flex items-center justify-between gap-sm">
        <span className={LABEL}>Output schema</span>
        <div className="flex items-center gap-[4px]">
          {lint.shape !== null ? (
            <StatusChip tone="neutral" data-testid="output-schema-shape">
              {lint.shape}
            </StatusChip>
          ) : null}
          {!readOnly && blank ? (
            <button
              type="button"
              className={cn(INLINE_ACTION, "hover:text-cyan")}
              onClick={() => handleEdit(OUTPUT_SCHEMA_TEMPLATE)}
            >
              + Add schema
            </button>
          ) : null}
          {!readOnly && !blank ? (
            <button
              type="button"
              className={cn(INLINE_ACTION, "hover:text-red")}
              onClick={() => {
                setClearedFrom(value);
                onChange("");
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {blank ? (
        <div
          className="box-border w-full rounded-sm border border-dashed border-border-default bg-transparent p-[14px] text-[0.74rem] leading-[1.5] text-text-tertiary"
          data-testid="output-schema-empty"
        >
          No output schema — this context produces free-form work.
        </div>
      ) : (
        <div
          className={cn(
            "flex overflow-hidden rounded-sm border border-solid bg-bg-base focus-within:border-cyan",
            lint.issues.length > 0 ? "border-red" : "border-border-default",
            readOnly && "opacity-60",
          )}
        >
          <div
            aria-hidden="true"
            className="min-w-[26px] shrink-0 border-y-0 border-r border-l-0 border-solid border-border-dim bg-bg-void py-[9px] pr-[8px] pl-[10px] text-right font-mono text-[0.72rem] leading-[1.55] text-text-tertiary select-none"
            data-testid="output-schema-gutter"
          >
            {Array.from({ length: lineCount }, (_unused, index) => (
              <div key={index + 1}>{index + 1}</div>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <MultilineInput
              aria-label="Output schema JSON"
              spellCheck={false}
              className="box-border block min-h-[150px] w-full resize-y overflow-x-auto border-0 bg-transparent px-[10px] py-[9px] font-mono text-[0.72rem] leading-[1.55] whitespace-pre [tab-size:2] text-text-primary outline-none disabled:cursor-not-allowed"
              value={value}
              disabled={readOnly}
              onValueChange={handleEdit}
            />
          </div>
        </div>
      )}

      {lint.stage === "ok" ? (
        <div
          className="mt-[6px] flex items-center gap-[6px] text-[0.7rem] text-green"
          data-testid="output-schema-valid"
        >
          <span
            aria-hidden="true"
            className="h-[6px] w-[6px] shrink-0 rounded-full bg-green shadow-[0_0_6px_var(--green-glow)]"
          />
          <span>Schema valid · {lint.summary}</span>
        </div>
      ) : null}

      {lint.issues.length > 0 && lint.stage !== "empty" ? (
        <div
          role="alert"
          className="mt-[6px] flex flex-col gap-[6px] rounded-sm border border-solid border-[var(--cc-red-a25)] bg-[var(--cc-red-a10)] px-[10px] py-[8px]"
          data-testid="output-schema-issues"
        >
          <div
            className="text-[0.7rem] font-semibold tracking-[0.06em] text-red uppercase"
            data-testid="output-schema-headline"
          >
            {lint.stage === "invalid-json"
              ? HEADLINE["invalid-json"]
              : HEADLINE.unsupported}
          </div>
          {lint.issues.map((issue) => (
            <div
              key={`${issue.path}::${issue.message}`}
              className="flex items-baseline gap-[6px] text-[0.72rem] leading-[1.45] max-768:flex-col max-768:items-start max-768:gap-[2px]"
              data-testid="output-schema-issue"
            >
              <code className="shrink-0 rounded-[3px] bg-bg-raised px-[5px] py-[1px] font-mono text-[0.68rem] [overflow-wrap:anywhere] text-red">
                {issue.path}
              </code>
              <span className="min-w-0 text-text-secondary">
                {issue.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {showCleared ? (
        <div
          className="mt-[6px] flex items-center gap-[10px] rounded-sm border border-solid border-border-subtle bg-bg-raised px-[10px] py-[6px] text-[0.7rem] text-text-secondary"
          data-testid="output-schema-cleared"
        >
          <span className="min-w-0 flex-1">
            Schema cleared — downstream prompts will no longer carry an output
            from this context.
          </span>
          <button
            type="button"
            className="inline-flex h-[22px] shrink-0 cursor-pointer items-center justify-center rounded-sm border border-solid border-border-default bg-bg-raised px-[8px] py-[3px] font-mono text-[0.7rem] font-medium text-text-secondary transition-colors duration-150 hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary max-768:min-h-[44px]"
            onClick={() => {
              const restored = clearedFrom;
              setClearedFrom(null);
              if (restored !== null) onChange(restored);
            }}
          >
            Undo
          </button>
        </div>
      ) : null}

      {readOnly && readOnlyHint ? (
        <div
          className={cn(HINT, "mt-[6px]")}
          data-testid="output-schema-readonly-hint"
        >
          {readOnlyHint}
        </div>
      ) : null}

      {footer}

      <div className={cn(HINT, "mt-xs")}>
        Captured once when this context completes, then injected into downstream
        prompts. Supported keywords —{" "}
        <code className="rounded-[3px] bg-bg-raised px-[4px] py-[1px] font-mono [overflow-wrap:anywhere] text-text-secondary">
          {SUPPORTED_KEYWORD_LIST}
        </code>
        . Anything else is refused.
      </div>
    </div>
  );
}
