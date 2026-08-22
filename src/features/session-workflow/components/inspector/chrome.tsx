"use client";

import { SectionLabel } from "@/components/ui/SectionHeader";
import { cn } from "@/lib/ui/cn";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@/components/workflow-config-panel/icons";

/**
 * The inspector rail's shared chrome — the shell, the scroll body, the cards,
 * the drill rows and the push-navigation back row.
 *
 * Every inspector surface (Overview, the context header, the tabs) is built
 * from these, so the rail's width exception, its scroll behaviour and its
 * drill affordance are decided once. Each drill control is a real button with
 * a visible focus ring and a canonical SVG chevron: the design system forbids
 * a Unicode character standing in for a functional icon.
 */

// 420px at every desktop width — the design's one approved width exception
// (README §2.4/§13), so the rail no longer steps down from 500px at 1180px.
export const inspectorRailClass =
  "w-[420px] min-w-[420px] bg-bg-surface border-l border-border-subtle flex flex-col overflow-hidden max-768:w-full max-768:min-w-0 max-768:flex-1 max-768:border-l-0 max-768:[.app[data-page=workflow][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow][data-mobile-panel=log]_&]:hidden";

export const inspectorBodyClass = "flex-1 overflow-y-auto p-lg";

export const inspectorSectionClass = "mb-lg";

export const inspectorMetaTextClass =
  "font-mono text-[0.7rem] leading-[1.6] text-text-secondary";

/** The rail's focus ring. Every control in the inspector wears this one. */
export const inspectorFocusRingClass =
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

/**
 * The same ring for a control that covers the row it acts on — a read view, a
 * task disclosure. Drawn inside the box so it traces what it opens instead of
 * bleeding over the neighbouring row.
 */
export const inspectorInsetFocusRingClass =
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]";

export function InspectorRail({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <aside aria-label="Inspector" className={inspectorRailClass}>
      {children}
    </aside>
  );
}

export function InspectorBody({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn(inspectorBodyClass, "wb-inspector-body", "min-h-0")}>
      {children}
    </div>
  );
}

/** Hairline-ruled group header (Brief / Tasks / Events / …). */
export function GroupHeader({
  label,
  meta,
}: {
  label: string;
  meta?: string;
}): React.JSX.Element {
  return (
    <div className="mb-[10px] flex items-center gap-sm">
      <SectionLabel>{label}</SectionLabel>
      {meta !== undefined ? (
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {meta}
        </span>
      ) : null}
      <span aria-hidden="true" className="h-px flex-1 bg-border-dim" />
    </div>
  );
}

/**
 * A control-flow fact — a loop pass, a guarded edge — as a blue filled pill.
 *
 * Not a `StatusChip`: these are not lifecycle status, and the only accent that
 * fit them in the primitive's tone set was violet, which §13 reserves for
 * Codex. The prototype draws them in `--blue`, and the recipe is the
 * primitive's own `flat` appearance (borderless tone fill) so the two read as
 * one family.
 */
export function ControlFlowChip({
  icon,
  children,
  testId,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <span
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className="inline-flex items-center gap-[4px] rounded-full bg-blue-glow px-[8px] py-[2px] font-mono text-[0.7rem] leading-[1.3] font-medium whitespace-nowrap text-blue"
    >
      {icon}
      {children}
    </span>
  );
}

/**
 * The rail's small button (the design's `.wf-btn`): a bordered raised control
 * at 22px (`xs`, inline inside a row) or 26px.
 *
 * A real `<button>` with the rail's focus ring — §13 forbids a clickable span,
 * and every affordance reachable on hover must be reachable by keyboard.
 */
export function InspectorButton({
  size = "sm",
  onClick,
  children,
  ariaLabel,
  testId,
}: {
  size?: "xs" | "sm";
  onClick: () => void;
  children: React.ReactNode;
  ariaLabel?: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-[6px] rounded-sm border border-solid border-border-default bg-bg-raised font-mono font-medium whitespace-nowrap text-text-secondary transition-colors duration-150 hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary",
        inspectorFocusRingClass,
        // The desktop heights are the rail's density; below the breakpoint the
        // same control is a touch target, and each of these sits alone at the
        // end of its row, so growing it steals no neighbour's tap.
        size === "xs"
          ? "h-[20px] px-[7px] text-[0.7rem] max-768:h-[44px] max-768:px-md"
          : "h-[22px] px-[8px] text-[0.7rem] max-768:h-[44px] max-768:px-md",
      )}
    >
      {children}
    </button>
  );
}

/** A stated fact with no drill: Launch, Shape, Result. */
export function InspectorCard({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <section
      aria-label={label}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className="mb-sm flex flex-col gap-[5px] rounded-md border border-solid border-border-subtle bg-bg-base px-3 py-[10px]"
    >
      <span className="font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
        {label}
      </span>
      {children}
    </section>
  );
}

/** A summary row that opens its own screen. */
export function InspectorDrillRow({
  label,
  summary,
  tone = "neutral",
  testId,
  onOpen,
}: {
  label: string;
  summary: string;
  tone?: "neutral" | "amber";
  testId?: string;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className={cn(
        // §12: the Overview drill rows are the Inspector panel's own navigation
        // below the breakpoint, so they carry the page's 44px touch minimum.
        "mb-sm flex w-full cursor-pointer items-center gap-sm rounded-md border border-solid px-3 py-[10px] text-left transition-colors duration-150 max-768:min-h-[44px]",
        inspectorFocusRingClass,
        tone === "amber"
          ? "border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a10)] hover:bg-[var(--cc-amber-a20)]"
          : "border-border-subtle bg-bg-base hover:bg-bg-elevated",
      )}
    >
      <span
        className={cn(
          "font-mono text-[0.72rem] font-semibold",
          tone === "amber" ? "text-amber" : "text-text-primary",
        )}
      >
        {label}
      </span>
      <span className="min-w-0 font-mono text-[0.7rem] text-text-secondary">
        {summary}
      </span>
      <span className="ml-auto flex flex-shrink-0 text-text-tertiary">
        <ChevronRightIcon />
      </span>
    </button>
  );
}

/**
 * One level down: the back row names its parent, exactly as the config panel's
 * drill does, so the whole rail has one push-navigation idiom.
 */
export function InspectorScreen({
  title,
  parentLabel,
  onBack,
  children,
}: {
  title: string;
  parentLabel: string;
  onBack: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col">
      <button
        type="button"
        onClick={onBack}
        className={cn(
          // §12: this is the Inspector's own back row below the breakpoint, so
          // it carries the page's touch minimum like the drill rows it returns
          // from.
          "mb-sm inline-flex cursor-pointer items-center gap-[6px] self-start rounded-sm border-0 bg-transparent px-[6px] py-[3px] font-mono text-[0.72rem] text-text-secondary transition-colors duration-150 hover:bg-bg-elevated hover:text-text-primary max-768:min-h-[44px] max-768:min-w-[44px] max-768:px-sm",
          inspectorFocusRingClass,
        )}
      >
        <ChevronLeftIcon size={12} />
        {parentLabel}
      </button>
      <GroupHeader label={title} />
      {children}
    </section>
  );
}

export function formatInspectorTimestamp(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
