"use client";

// Presentational autocomplete-popup primitive — the shared shell plus
// listbox/option or grid/row ARIA semantics for CC's type-to-filter surfaces.
// It implements the popup half of the WAI-ARIA APG "Combobox" pattern:
//   - Combobox (editable):  https://www.w3.org/WAI/ARIA/apg/patterns/combobox/
//   - Listbox:              https://www.w3.org/WAI/ARIA/apg/patterns/listbox/
//   - Grid:                 https://www.w3.org/WAI/ARIA/apg/patterns/grid/
//
// IMPORTANT — what this primitive does NOT do. There is no Radix Combobox
// primitive, so behaviour is NOT Radix-backed here. This wrapper owns ONLY CC
// appearance plus popup semantics and active-row scrolling. Listbox is the
// default for single-action choices; grid supports rows with a secondary native
// control without nesting it inside an option. Filtering, focus management, and
// keyboard navigation stay with each host, which keeps DOM focus on the text
// input and forwards keys to drive the active index. Hosts are responsible for
// the input-side roles and `aria-activedescendant` wiring. See
// docs/reports/combobox-autocomplete-decision.md.

import { useEffect, useRef } from "react";
import { cn } from "@/lib/ui/cn";

// ── Shared popup recipes (command / file / conversation families) ──
// Skill-badge green (--cc-green-a12) and cyan badge fills (--cc-cyan-a12/a08)
// are token-backed, as is the upward menu shadow (--cc-shadow-dropdown-up).

/**
 * Floating popup shell: anchored above the prompt input, cyan accent line on top.
 * Callers append their own `max-h-[…]` (340px for command/file, 380px for
 * conversation) via {@link AutocompleteListbox}'s `maxHeightClassName` — a single
 * max-height utility avoids a same-property collision.
 *
 * The surface is opaque and carries the upward menu shadow: these popups sit
 * directly over the transcript, and a translucent surface let message text bleed
 * through the rows.
 */
export const autocompletePopupClass =
  "absolute inset-x-0 bottom-full z-header flex flex-col overflow-hidden rounded-t-lg border border-b-0 border-solid border-border-default bg-bg-surface font-mono shadow-[var(--cc-shadow-dropdown-up)] animate-[cmdReveal_0.18s_ease] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,var(--cyan)_20%,var(--cyan)_80%,transparent)] before:opacity-60 before:content-['']";

/**
 * Placement variant for hosts with no room above the anchor — a tall editing
 * pane that starts at the top of its panel. The popup pins to the top of the
 * anchor and overlays it downward, so it stays inside the panel instead of
 * being clipped against its edge. Accent line and shadow flip accordingly.
 */
export const autocompletePopupOverlayClass =
  "absolute inset-x-0 top-0 z-header flex flex-col overflow-hidden rounded-b-lg border border-t-0 border-solid border-border-default bg-bg-surface font-mono shadow-[var(--cc-shadow-dropdown)] animate-[cmdReveal_0.18s_ease] after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[linear-gradient(90deg,transparent,var(--cyan)_20%,var(--cyan)_80%,transparent)] after:opacity-60 after:content-['']";

/**
 * Where the popup sits relative to its anchor: `above` for an input at the
 * bottom of its surface (the prompt), `overlay-top` for one that fills its
 * panel (the notepad editor).
 */
export type AutocompletePlacement = "above" | "overlay-top";

export function autocompletePlacementClass(
  placement: AutocompletePlacement,
): string {
  return placement === "overlay-top"
    ? autocompletePopupOverlayClass
    : autocompletePopupClass;
}

export const autocompleteHeaderClass =
  "sticky top-0 z-raised flex items-center justify-between border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-raised px-sm py-xs text-[0.7rem] text-text-tertiary";

export const autocompleteHeaderCountClass = "text-text-secondary";

export const autocompleteListClass =
  "flex-1 overflow-y-auto overscroll-contain";

/** Selectable row: left accent border + cyan glow when active; touch-sized on mobile. */
export const autocompleteItemClass =
  "relative flex min-h-[32px] cursor-pointer items-center gap-sm border-y-0 border-r-0 border-l-2 border-solid border-l-transparent px-sm py-xs transition-[background] duration-100 ease-[ease] hover:bg-bg-hover data-[active=true]:border-l-cyan data-[active=true]:bg-bg-hover data-[active=true]:after:pointer-events-none data-[active=true]:after:absolute data-[active=true]:after:inset-0 data-[active=true]:after:bg-[linear-gradient(90deg,var(--cyan-glow)_0%,transparent_60%)] data-[active=true]:after:content-[''] max-768:min-h-[44px] max-768:py-sm";

/** Conversation-row recipe (two-line layout, status dot, archived dim). */
export const conversationItemClass =
  "relative flex min-h-[40px] cursor-pointer flex-col gap-[2px] border-y-0 border-r-0 border-l-2 border-solid border-l-transparent px-sm py-xs transition-[background] duration-100 ease-[ease] hover:bg-bg-hover data-[active=true]:border-l-cyan data-[active=true]:bg-bg-hover data-[active=true]:after:pointer-events-none data-[active=true]:after:absolute data-[active=true]:after:inset-0 data-[active=true]:after:bg-[linear-gradient(90deg,var(--cyan-glow)_0%,transparent_60%)] data-[active=true]:after:content-[''] data-[archived=true]:opacity-50 max-768:min-h-[44px] max-768:py-sm";

export const autocompleteFooterClass =
  "sticky bottom-0 z-raised flex items-center gap-md border-x-0 border-b-0 border-t border-solid border-border-subtle bg-bg-raised px-sm py-xs text-[0.7rem] text-text-tertiary";

export const autocompleteFooterKbdClass =
  "inline-block rounded-sm border border-solid border-border-default bg-bg-raised px-[4px] py-0 font-mono text-[0.7rem] leading-[1.4] text-text-secondary";

export const autocompleteEmptyClass =
  "p-md text-center text-[0.75rem] text-text-tertiary";

export const autocompleteErrorClass =
  "px-md py-sm text-center text-[0.72rem] text-red";

// ── Footer key hints (shared chrome) ──

/** A single keycap in the footer hint row. */
export function AutocompleteKbd({ children }: { children: React.ReactNode }) {
  return <kbd className={autocompleteFooterKbdClass}>{children}</kbd>;
}

export interface AutocompleteNavFooterProps {
  /** Extra hint(s) appended after the standard navigate/select/close set. */
  extra?: React.ReactNode;
  /** Layout-only utility for the footer wrapper (e.g. responsive `hidden`). */
  layoutClassName?: string;
}

/** The standard ↑↓ navigate · Enter select · Esc close footer. */
export function AutocompleteNavFooter({
  extra,
  layoutClassName,
}: AutocompleteNavFooterProps) {
  return (
    <div className={cn(autocompleteFooterClass, layoutClassName)}>
      <span>
        <AutocompleteKbd>↑</AutocompleteKbd>{" "}
        <AutocompleteKbd>↓</AutocompleteKbd> navigate
      </span>
      <span>
        <AutocompleteKbd>Enter</AutocompleteKbd> select
      </span>
      <span>
        <AutocompleteKbd>Esc</AutocompleteKbd> close
      </span>
      {extra}
    </div>
  );
}

// ── Listbox shell ──

export interface AutocompleteListboxProps {
  /** Accessible name for the popup region. */
  label: string;
  /** Grid is required when a row contains a secondary interactive action. */
  popupRole?: "listbox" | "grid";
  /**
   * Index of the active option; the matching child of the listbox is scrolled
   * into view when it changes.
   */
  activeIndex?: number;
  /** Header chrome rendered above the listbox (outside option semantics). */
  header?: React.ReactNode;
  /** Footer chrome rendered below the listbox (key hints). */
  footer?: React.ReactNode;
  /** Layout-only max-height utility for the popup (e.g. `max-h-[340px]`). */
  maxHeightClassName?: string;
  /** Where the popup sits relative to its anchor. Defaults to `above`. */
  placement?: AutocompletePlacement;
  loading?: boolean;
  /** Message shown in the loading state. */
  loadingLabel?: React.ReactNode;
  error?: string | null;
  /** True when there are no options; renders {@link AutocompleteListboxProps.empty}. */
  isEmpty?: boolean;
  /** Message shown when not loading/error and there are no options. */
  empty?: React.ReactNode;
  /** Option rows ({@link AutocompleteOption}). */
  children?: React.ReactNode;
}

/**
 * The popup shell: floating container + sticky header/footer slots + the
 * scrolling `role="listbox"` region with its loading/error/empty states and
 * active-row scroll-into-view. Pass {@link AutocompleteOption} children for the
 * rows; pass header/footer chrome via the slots.
 */
export function AutocompleteListbox({
  label,
  popupRole = "listbox",
  activeIndex,
  header,
  footer,
  maxHeightClassName,
  placement = "above",
  loading = false,
  loadingLabel,
  error = null,
  isEmpty = false,
  empty,
  children,
}: AutocompleteListboxProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loading || error || isEmpty) return;
    const list = listRef.current;
    if (!list || activeIndex == null) return;
    const activeEl = list.children[activeIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, loading, error, isEmpty]);

  const showStatus = loading || error != null || isEmpty;

  return (
    <div
      className={cn(autocompletePlacementClass(placement), maxHeightClassName)}
    >
      {header}

      {/*
        Scroll viewport wrapping the listbox. Status chrome (loading/empty/error)
        renders as a SIBLING of `role="listbox"`, never a child — APG requires
        listbox children to be `option`/`group` only. Loading/empty announce via
        `role="status"` (polite) and errors via `role="alert"` (assertive).
      */}
      <div className={autocompleteListClass}>
        {loading && (
          <div role="status" className={autocompleteEmptyClass}>
            {loadingLabel}
          </div>
        )}
        {!loading && error != null && (
          <div role="alert" className={autocompleteErrorClass}>
            {error}
          </div>
        )}
        {!loading && error == null && isEmpty && (
          <div role="status" className={autocompleteEmptyClass}>
            {empty}
          </div>
        )}

        <div
          ref={listRef}
          role={popupRole}
          aria-label={label}
          aria-busy={loading || undefined}
        >
          {!showStatus && children}
        </div>
      </div>

      {footer}
    </div>
  );
}

// ── Option row ──

export type AutocompleteOptionVariant = "default" | "conversation";

const optionVariantClass: Record<AutocompleteOptionVariant, string> = {
  default: autocompleteItemClass,
  conversation: conversationItemClass,
};

export interface AutocompleteOptionProps {
  disabled?: boolean;
  /** Whether this is the active (highlighted) option. */
  active: boolean;
  /** Stable id so a host can target it with `aria-activedescendant`. */
  id?: string;
  /** Use `row` when the parent popup uses the grid pattern. */
  semanticRole?: "option" | "row";
  /** Appearance recipe: compact single-line (default) or two-line conversation row. */
  variant?: AutocompleteOptionVariant;
  /** When set, mirrored to `data-archived` for the archived-dim style. */
  archived?: boolean;
  onSelect: () => void;
  onHover: () => void;
  children: React.ReactNode;
}

/**
 * One selectable row: `role="option"` + `aria-selected` + `data-active` (which
 * drives the active appearance) + the row recipe. Content (labels, badges,
 * highlight) is composed by the caller.
 */
export function AutocompleteOption({
  disabled,
  active,
  id,
  semanticRole = "option",
  variant = "default",
  archived,
  onSelect,
  onHover,
  children,
}: AutocompleteOptionProps) {
  return (
    <div
      role={semanticRole}
      id={id}
      aria-selected={active}
      aria-disabled={disabled || undefined}
      data-active={active}
      data-archived={archived}
      className={optionVariantClass[variant]}
      onMouseEnter={onHover}
      onClick={disabled ? undefined : onSelect}
    >
      {children}
    </div>
  );
}

// ── Match highlight ──

export interface AutocompleteMatchTextProps {
  text: string;
  /** Character indices in `text` to highlight as fuzzy-match hits. */
  indices: number[];
  /** Class for the container span. */
  className?: string;
  /** Class applied to each matched character run. */
  matchClassName?: string;
}

/**
 * Renders `text` with the characters at `indices` wrapped in `matchClassName`
 * (cyan by default) and the rest left as plain text. Shared by the command and
 * conversation row labels; file rows colour every char and keep their own helper.
 */
export function AutocompleteMatchText({
  text,
  indices,
  className,
  matchClassName = "text-cyan",
}: AutocompleteMatchTextProps) {
  if (indices.length === 0) {
    return <span className={className}>{text}</span>;
  }
  const indexSet = new Set(indices);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < text.length; i++) {
    if (indexSet.has(i)) {
      parts.push(
        <span key={i} className={matchClassName}>
          {text[i]}
        </span>,
      );
    } else {
      const last = parts[parts.length - 1];
      if (typeof last === "string") {
        parts[parts.length - 1] = last + text[i];
      } else {
        parts.push(text[i]);
      }
    }
  }
  return <span className={className}>{parts}</span>;
}
