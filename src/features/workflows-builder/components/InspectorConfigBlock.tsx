"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import { SectionChevron, SectionLabel } from "@/components/ui/SectionHeader";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/ui/cn";

export type InspectorConfigBlockSource =
  | "global"
  | "workflow"
  | "context-override"
  | "disabled";

export interface InspectorHeaderSwitch {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  ariaLabel: string;
}

export interface InspectorConfigBlockProps {
  label: string;
  summary?: string;
  /** Colored identity chip rendered after the label (e.g. backend · model). */
  chip?: React.ReactNode;
  /** Leading glyph for non-collapsible gate blocks (chevron slot stand-in). */
  icon?: React.ReactNode;
  source: InspectorConfigBlockSource;
  defaultOpen?: boolean;
  allowInheritedEditing?: boolean;
  /** `false` renders a plain gate block: no disclosure, no children body. */
  collapsible?: boolean;
  /** One-line explanation rendered under the header row, always visible. */
  description?: React.ReactNode;
  /** Design-system Switch hosted in the header row (quality gates). */
  headerSwitch?: InspectorHeaderSwitch;
  /** `amber` tints the whole block (human approval gate while enabled). */
  tone?: "default" | "amber";
  onOverride?: () => void;
  onReset?: () => void;
  onToggleDisabled?: () => void;
  children?: React.ReactNode;
}

const SOURCE_BADGE_TEXT: Record<InspectorConfigBlockSource, string> = {
  global: "Global",
  workflow: "Workflow",
  "context-override": "Overridden",
  disabled: "Disabled",
};

const SOURCE_BADGE_CLASS: Record<InspectorConfigBlockSource, string> = {
  global: "text-text-tertiary",
  workflow: "text-text-tertiary",
  "context-override": "text-cyan",
  disabled: "text-red",
};

const SOURCE_DOT_CLASS: Record<InspectorConfigBlockSource, string> = {
  global: "bg-text-tertiary",
  workflow: "bg-text-tertiary",
  "context-override": "bg-cyan shadow-[0_0_4px_var(--cyan-glow)]",
  disabled: "bg-red shadow-[0_0_4px_var(--red-glow)]",
};

const ACCENT_BORDER_CLASS: Record<InspectorConfigBlockSource, string> = {
  global: "",
  workflow: "",
  "context-override": "border-l-2 border-l-cyan",
  disabled: "border-l-2 border-l-red-dim",
};

const SUMMARY_CLASS =
  "min-w-0 overflow-hidden font-mono text-[0.72rem] font-normal text-ellipsis whitespace-nowrap text-text-secondary";

const DESCRIPTION_CLASS =
  "px-[14px] pb-[12px] pl-[38px] text-[0.74rem] leading-[1.5] text-text-secondary";

function isInherited(source: InspectorConfigBlockSource): boolean {
  return source === "global" || source === "workflow";
}

function SourceBadge({
  source,
}: {
  source: InspectorConfigBlockSource;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "ml-auto inline-flex flex-shrink-0 items-center gap-[5px] font-mono text-[0.7rem] font-semibold tracking-[0.07em] whitespace-nowrap uppercase",
        SOURCE_BADGE_CLASS[source],
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-[5px] rounded-full", SOURCE_DOT_CLASS[source])}
      />
      {SOURCE_BADGE_TEXT[source]}
    </span>
  );
}

function containerClass(
  source: InspectorConfigBlockSource,
  tone: "default" | "amber",
): string {
  return cn(
    "rounded-md border border-solid transition-[background,border-color] duration-150",
    tone === "amber"
      ? "border-amber-dim bg-amber-glow"
      : "border-border-subtle bg-bg-base",
    ACCENT_BORDER_CLASS[source],
  );
}

function FooterActions({
  source,
  onOverride,
  onReset,
  onToggleDisabled,
}: Pick<
  InspectorConfigBlockProps,
  "source" | "onOverride" | "onReset" | "onToggleDisabled"
>): React.JSX.Element | null {
  const buttons = (
    <>
      {isInherited(source) && onOverride ? (
        <Button variant="ghost" size="sm" touch onClick={onOverride}>
          Override
        </Button>
      ) : null}
      {isInherited(source) && onToggleDisabled ? (
        <Button variant="ghost" size="sm" touch onClick={onToggleDisabled}>
          Disable for this context
        </Button>
      ) : null}

      {source === "context-override" && onReset ? (
        <Button variant="ghost" size="sm" touch onClick={onReset}>
          Reset to inherit
        </Button>
      ) : null}
      {source === "context-override" && onToggleDisabled ? (
        <Button variant="ghost" size="sm" touch onClick={onToggleDisabled}>
          Disable for this context
        </Button>
      ) : null}

      {source === "disabled" && onToggleDisabled ? (
        <Button variant="ghost" size="sm" touch onClick={onToggleDisabled}>
          Re-enable (inherit)
        </Button>
      ) : null}
      {source === "disabled" && onOverride ? (
        <Button variant="ghost" size="sm" touch onClick={onOverride}>
          Override with custom validator
        </Button>
      ) : null}
    </>
  );

  const hasAny =
    (isInherited(source) && (onOverride || onToggleDisabled)) ||
    (source === "context-override" && (onReset || onToggleDisabled)) ||
    (source === "disabled" && (onToggleDisabled || onOverride));

  if (!hasAny) return null;
  return (
    <div className="mt-md flex justify-end gap-sm border-t border-solid border-border-dim pt-[10px]">
      {buttons}
    </div>
  );
}

export default function InspectorConfigBlock({
  label,
  summary,
  chip,
  icon,
  source,
  defaultOpen,
  allowInheritedEditing,
  collapsible = true,
  description,
  headerSwitch,
  tone = "default",
  onOverride,
  onReset,
  onToggleDisabled,
  children,
}: InspectorConfigBlockProps): React.JSX.Element {
  const initialOpen =
    defaultOpen ?? (source === "context-override" || source === "disabled");
  const [open, setOpen] = useState<boolean>(initialOpen);

  const editable = source === "context-override" || allowInheritedEditing;

  if (!collapsible) {
    return (
      <div className={containerClass(source, tone)} data-source={source}>
        <div className="flex items-center gap-[10px] px-[14px] py-[12px]">
          <span
            aria-hidden="true"
            className="inline-flex size-[14px] flex-shrink-0 items-center justify-center text-text-tertiary"
          >
            {icon}
          </span>
          <SectionLabel data-section-label layoutClassName="shrink-0">
            {label}
          </SectionLabel>
          {chip}
          {summary ? <span className={SUMMARY_CLASS}>{summary}</span> : null}
          <SourceBadge source={source} />
          {headerSwitch ? (
            <Switch
              checked={headerSwitch.checked}
              onCheckedChange={headerSwitch.onCheckedChange}
              aria-label={headerSwitch.ariaLabel}
            />
          ) : null}
        </div>
        {description ? (
          <div className={DESCRIPTION_CLASS}>{description}</div>
        ) : null}
        {source === "context-override" && onReset ? (
          <div className="flex justify-end px-[14px] pb-[10px]">
            <Button variant="ghost" size="sm" touch onClick={onReset}>
              Reset to inherit
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(containerClass(source, tone), "overflow-hidden")}
      data-source={source}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-[10px] px-[14px] py-[12px]">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-[10px] border-0 bg-transparent p-0 text-left font-[inherit] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
            >
              <SectionChevron collapsed={!open} aria-hidden="true">
                ▾
              </SectionChevron>
              <SectionLabel data-section-label layoutClassName="shrink-0">
                {label}
              </SectionLabel>
              {chip}
              {summary ? (
                <span
                  className={cn(
                    SUMMARY_CLASS,
                    source === "disabled" && "text-text-tertiary line-through",
                  )}
                >
                  {summary}
                </span>
              ) : null}
            </button>
          </CollapsibleTrigger>
          <SourceBadge source={source} />
          {headerSwitch ? (
            <Switch
              checked={headerSwitch.checked}
              onCheckedChange={headerSwitch.onCheckedChange}
              aria-label={headerSwitch.ariaLabel}
            />
          ) : null}
        </div>

        {description ? (
          <div className={DESCRIPTION_CLASS}>{description}</div>
        ) : null}

        <CollapsibleContent>
          <div className="border-t border-solid border-border-dim p-[14px]">
            <div
              className={cn(
                "block",
                !editable && "pointer-events-none opacity-65",
              )}
              aria-disabled={editable ? undefined : true}
            >
              {children}
            </div>

            <FooterActions
              source={source}
              onOverride={onOverride}
              onReset={onReset}
              onToggleDisabled={onToggleDisabled}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
