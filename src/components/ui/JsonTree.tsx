"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";
import { Button } from "./Button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./Collapsible";

// Read-only JSON viewer built from NESTED DISCLOSURES (WAI-ARIA APG
// "Disclosure" pattern: https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).
// Every branch is one `Collapsible` — Radix owns the behaviour (native
// Enter/Space activation, `aria-expanded`/`aria-controls` wiring, `data-state`,
// mounting/unmounting the region so a folded subtree leaves both the a11y tree
// and the tab order) and this wrapper owns CC appearance.
//
// Deliberately NOT the APG "Tree View" pattern
// (https://www.w3.org/WAI/ARIA/apg/patterns/treeview/): tree view exists to
// NAVIGATE and SELECT nodes — it demands roving tabindex, arrow/Home/End
// traversal and type-ahead, none of which Radix supplies, and none of which a
// short read-only payload needs. Nested disclosures give the same fold/unfold
// with platform-native keyboard support and no hand-rolled focus manager. If a
// consumer ever needs node selection, that is a different primitive.
//
// Colour is deliberately thin — keys secondary, strings primary, numbers amber,
// booleans cyan, punctuation tertiary — not a full syntax palette: these values
// are short structured payloads, not code to read.
//
// SURFACE CONTRACT: the muted tones are verified against `bg-base`, the surface
// the design handoff puts this tree on (text-secondary 5.37:1, text-tertiary
// 5.08:1). They have little headroom — on `bg-raised` tertiary is already
// 4.34:1 — so a consumer placing the tree on a lighter surface owns re-checking
// contrast rather than assuming this primitive travels anywhere.

const COPY_CONFIRM_MS = 1600;

// Static (non-interactive) row. `min-h-[24px]` floors it at the WCAG 2.5.8
// target minimum even though the type is 0.72rem; the chevron column keeps leaf
// rows aligned under branch rows. Items align on the BASELINE, not the centre,
// so a value long enough to wrap keeps its key on the first line instead of
// leaving it floating in the middle of the wrapped block.
const rowStatic =
  "flex min-h-[24px] items-baseline gap-[4px] px-[6px] py-[3px]";

// Branch row: the whole row is the disclosure trigger, so the target is the row
// rather than a 12px glyph. `group` lets the chevron rotate off Radix's
// `data-state`; the focus ring is CC's canonical cyan, inset so it stays inside
// the consumer's bordered container. Centred rather than baseline-aligned
// (the static rows' rule): a branch row is a single line by construction, and
// the mobile touch height would otherwise strand its text at the top of a 44px
// box. Spelled out in full rather than composed with the static row because two
// utilities may never target one property (`align-items`) on one element.
//
// Hover steps ONE elevation level (bg-base → bg-surface), per the design
// system's "hover always moves up one level, never skipping". The obvious
// `bg-hover` (#1c2841) is two steps and lands muted text below AA on the
// handoff's bg-base surface: text-secondary 4.14:1 and text-tertiary 3.92:1
// against the 4.5:1 floor at this 0.72rem size. bg-surface keeps them at
// 5.01:1 / 4.74:1, and the key brightens to text-primary so the hover still
// reads at a glance despite the subtler wash.
const rowTrigger =
  "group flex min-h-[24px] w-full cursor-pointer items-center gap-[4px] border-0 bg-transparent px-[6px] py-[3px] text-left [font:inherit] outline-none transition-colors duration-150 ease-[ease] hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] max-768:min-h-[var(--touch-target-min)]";

const chevronClass =
  "shrink-0 text-text-tertiary transition-transform duration-150 ease-[ease] group-data-[state=open]:rotate-90 motion-reduce:transition-none";

// Each nesting level indents its children; the depth is expressed by nesting,
// never by a computed `pl-${depth * 14}` (dynamic class strings are rejected by
// the guardrails and would not even be generated).
const nestClass = "pl-[14px]";

// `whitespace-pre-wrap` is what makes the escaped text render losslessly: HTML
// collapses runs of spaces, so `"a  b"` and `"a b"` would otherwise look
// identical. `max-w-full` + `break-words` keep a pathologically long key inside
// the row instead of overflowing it (`shrink-0` alone would pin it at
// max-content). The hover brightening is only reachable inside a branch
// trigger — static rows have no `.group` ancestor.
const keyClass =
  "max-w-full shrink-0 whitespace-pre-wrap break-words text-text-secondary group-hover:text-text-primary";
const punctuationClass = "text-text-tertiary";

type ScalarKind = "string" | "number" | "boolean" | "null" | "other";

const scalarToneClass: Record<ScalarKind, string> = {
  string: "text-text-primary",
  number: "text-amber",
  boolean: "text-cyan",
  null: "text-text-tertiary",
  other: "text-text-tertiary",
};

// Strings and keys are encoded by `JSON.stringify`, never by wrapping the raw
// text in quote characters: hand-wrapping renders `he said "hi"` as malformed
// JSON, swallows backslashes, and turns a `\n` inside a value into a real line
// break. Escaping here means what is on screen parses back to the source value
// (asserted by the round-trip test). Numbers and booleans keep `String` so a
// non-JSON `NaN`/`Infinity` in a payload is shown as-is rather than as `null`.
function scalarToken(value: unknown): { kind: ScalarKind; text: string } {
  if (value === null) return { kind: "null", text: "null" };
  if (typeof value === "string")
    return { kind: "string", text: JSON.stringify(value) };
  if (typeof value === "number") return { kind: "number", text: String(value) };
  if (typeof value === "boolean")
    return { kind: "boolean", text: String(value) };
  return { kind: "other", text: String(value) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonEntry = { key: string | null; value: unknown };
type JsonContainer = { isArray: boolean; entries: JsonEntry[] };

/** Arrays and plain objects are branches; everything else is a leaf. */
function asContainer(value: unknown): JsonContainer | null {
  if (Array.isArray(value)) {
    return {
      isArray: true,
      entries: value.map((item: unknown) => ({ key: null, value: item })),
    };
  }
  if (isRecord(value)) {
    return {
      isArray: false,
      entries: Object.entries(value).map(([key, entryValue]) => ({
        key,
        value: entryValue,
      })),
    };
  }
  return null;
}

/** Placeholder keeping leaf rows aligned with the branch rows' chevron column. */
function ChevronGutter() {
  return <span aria-hidden="true" className="inline-block w-[12px] shrink-0" />;
}

function KeyLabel({ label }: { label: string | null }) {
  if (label === null) return null;
  return (
    <span
      data-json-token="key"
      className={keyClass}
    >{`${JSON.stringify(label)}:`}</span>
  );
}

function LeafRow({ label, value }: { label: string | null; value: unknown }) {
  const { kind, text } = scalarToken(value);
  return (
    <div className={rowStatic}>
      <ChevronGutter />
      <KeyLabel label={label} />
      {/* `break-words` wraps prose at spaces and only splits a token (a path, a
          hash) when it cannot fit on its own line. `min-w-0` is what lets it:
          a flex item defaults to `min-width:auto`, so without this the span
          refuses to shrink below its min-content width and a long unbroken
          token overflows the container instead of wrapping. */}
      <span
        data-json-token={kind}
        className={cn(
          scalarToneClass[kind],
          "min-w-0 break-words whitespace-pre-wrap",
        )}
      >
        {text}
      </span>
    </div>
  );
}

/** `{}` / `[]` — nothing to fold, so no toggle is offered. */
function EmptyContainerRow({
  label,
  isArray,
}: {
  label: string | null;
  isArray: boolean;
}) {
  return (
    <div className={rowStatic}>
      <ChevronGutter />
      <KeyLabel label={label} />
      <span data-json-token="punctuation" className={punctuationClass}>
        {isArray ? "[]" : "{}"}
      </span>
    </div>
  );
}

type BranchProps = {
  label: string | null;
  container: JsonContainer;
  depth: number;
  defaultCollapsedDepth: number | undefined;
};

function Branch({
  label,
  container,
  depth,
  defaultCollapsedDepth,
}: BranchProps) {
  const [open, setOpen] = useState(
    () => defaultCollapsedDepth === undefined || depth < defaultCollapsedDepth,
  );
  const { isArray, entries } = container;
  const openBrace = isArray ? "[" : "{";
  const closeBrace = isArray ? "]" : "}";
  // Folded rows carry their own summary so the count survives the fold.
  const summary = open
    ? openBrace
    : `${openBrace} … ${entries.length} ${closeBrace}`;
  // Braces read as noise to a screen reader, so the toggle is named by its key
  // plus this description instead; `aria-expanded` carries the fold state.
  const description = `${isArray ? "array" : "object"}, ${entries.length} ${
    entries.length === 1 ? "entry" : "entries"
  }`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className={rowTrigger}>
          <ChevronRightIcon size={12} className={chevronClass} />
          <KeyLabel label={label} />
          <span
            data-json-token="punctuation"
            aria-hidden="true"
            className={punctuationClass}
          >
            {summary}
          </span>
          <span className="sr-only">{description}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={nestClass}>
          {entries.map((entry, index) => (
            <JsonNode
              key={entry.key ?? index}
              label={entry.key}
              value={entry.value}
              depth={depth + 1}
              defaultCollapsedDepth={defaultCollapsedDepth}
            />
          ))}
        </div>
        <div className={rowStatic}>
          <ChevronGutter />
          <span
            data-json-token="punctuation"
            aria-hidden="true"
            className={punctuationClass}
          >
            {closeBrace}
          </span>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type JsonNodeProps = {
  label: string | null;
  value: unknown;
  depth: number;
  defaultCollapsedDepth: number | undefined;
};

function JsonNode({
  label,
  value,
  depth,
  defaultCollapsedDepth,
}: JsonNodeProps) {
  const container = asContainer(value);
  if (container === null) return <LeafRow label={label} value={value} />;
  if (container.entries.length === 0) {
    return <EmptyContainerRow label={label} isArray={container.isArray} />;
  }
  return (
    <Branch
      label={label}
      container={container}
      depth={depth}
      defaultCollapsedDepth={defaultCollapsedDepth}
    />
  );
}

function CopyJsonButton({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(() => {
    const text = JSON.stringify(value, null, 2) ?? "";
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
    });
  }, [value]);

  return (
    <>
      {/* Its own row, not pinned over the first line: a floating action would
          cover ~100px of the root row — which is itself a fold target — so the
          two hit areas would overlap (WCAG 2.5.8) and the focused row would sit
          partly behind it (2.4.11). */}
      <div className="mb-xs flex justify-end px-[6px]">
        <Button type="button" size="sm" onClick={handleCopy}>
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          {copied ? "Copied" : "Copy JSON"}
        </Button>
      </div>
      {/* The button's label change is silent to a screen reader that is not on
          it, so the confirmation is announced here. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "JSON copied to clipboard" : ""}
      </span>
    </>
  );
}

export type JsonTreeProps = {
  /** Any JSON-serialisable value. Objects and arrays render as foldable branches. */
  value: unknown;
  /**
   * Branches at this depth and deeper start folded (the root branch is depth 0,
   * so `0` folds everything and `1` shows the root's keys with nested branches
   * folded). Omit to render fully expanded. Initial state only — a reader's
   * folds are theirs to keep.
   */
  defaultCollapsedDepth?: number;
  /** Render a copy action (top-right) that writes the pretty-printed JSON. */
  copyable?: boolean;
  /**
   * External-geometry utilities applied by the parent (margin, grid/flex
   * placement, order, self-align, width/basis). Appended after the appearance
   * utilities and never overrides them. NOT for appearance — the primitive owns
   * background/color/border/radius/shadow/padding.
   */
  layoutClassName?: string;
};

export function JsonTree({
  value,
  defaultCollapsedDepth,
  copyable = false,
  layoutClassName,
}: JsonTreeProps) {
  return (
    <div
      className={cn(
        "py-sm pr-sm pl-[4px] font-mono text-[0.72rem] leading-[1.6]",
        layoutClassName,
      )}
    >
      {copyable ? <CopyJsonButton value={value} /> : null}
      <JsonNode
        label={null}
        value={value}
        depth={0}
        defaultCollapsedDepth={defaultCollapsedDepth}
      />
    </div>
  );
}
