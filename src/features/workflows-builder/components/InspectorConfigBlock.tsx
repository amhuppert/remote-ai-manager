"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import { SectionChevron, SectionLabel } from "@/components/ui/SectionHeader";
import { cn } from "@/lib/ui/cn";

export type InspectorConfigBlockSource =
  | "global"
  | "workflow"
  | "context-override"
  | "disabled";

export interface InspectorConfigBlockProps {
  label: string;
  summary: string;
  source: InspectorConfigBlockSource;
  defaultOpen?: boolean;
  allowInheritedEditing?: boolean;
  onOverride?: () => void;
  onReset?: () => void;
  onToggleDisabled?: () => void;
  children?: React.ReactNode;
}

const BADGE_TEXT: Record<InspectorConfigBlockSource, string> = {
  global: "INHERITED · GLOBAL",
  workflow: "INHERITED · WORKFLOW",
  "context-override": "OVERRIDDEN",
  disabled: "DISABLED",
};

const BORDER_LEFT_CLASS: Record<InspectorConfigBlockSource, string> = {
  global: "border-l-border-subtle",
  workflow: "border-l-border-default",
  "context-override": "border-l-cyan",
  disabled: "border-l-red-dim",
};

const BADGE_COLOR_CLASS: Record<InspectorConfigBlockSource, string> = {
  global: "text-text-tertiary bg-transparent",
  workflow: "text-text-tertiary bg-transparent",
  "context-override": "text-cyan bg-cyan-glow",
  disabled: "text-red-text bg-red-glow",
};

function isInherited(source: InspectorConfigBlockSource): boolean {
  return source === "global" || source === "workflow";
}

export default function InspectorConfigBlock({
  label,
  summary,
  source,
  defaultOpen,
  allowInheritedEditing,
  onOverride,
  onReset,
  onToggleDisabled,
  children,
}: InspectorConfigBlockProps): React.JSX.Element {
  const initialOpen =
    defaultOpen ?? (source === "context-override" || source === "disabled");
  const [open, setOpen] = useState<boolean>(initialOpen);

  const editable = source === "context-override" || allowInheritedEditing;

  return (
    <div
      className={cn(
        "mb-sm rounded-md border border-l-2 border-solid border-border-subtle bg-bg-surface p-0",
        BORDER_LEFT_CLASS[source],
      )}
      data-source={source}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger hideChevron>
          <SectionChevron collapsed={!open} aria-hidden="true">
            ▾
          </SectionChevron>
          <SectionLabel data-section-label>{label}</SectionLabel>
          <span
            className={cn(
              "min-w-0 flex-1 overflow-hidden font-mono text-[0.72rem] font-normal text-ellipsis whitespace-nowrap text-text-primary",
              source === "disabled" && "text-text-tertiary line-through",
            )}
          >
            {summary}
          </span>
          <span
            className={cn(
              "flex-shrink-0 rounded-full px-[8px] py-[2px] font-mono text-[0.7rem] font-semibold tracking-[0.06em] whitespace-nowrap uppercase",
              BADGE_COLOR_CLASS[source],
            )}
          >
            {BADGE_TEXT[source]}
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="rounded-b-[calc(var(--radius-md)-1px)] border-t border-solid border-border-subtle bg-bg-base p-md">
            <div
              className={cn(
                "block",
                !editable && "pointer-events-none opacity-65",
              )}
              aria-disabled={editable ? undefined : true}
            >
              {children}
            </div>

            <div className="mt-md flex justify-end gap-sm">
              {isInherited(source) && onOverride ? (
                <Button variant="ghost" size="sm" touch onClick={onOverride}>
                  Override
                </Button>
              ) : null}
              {isInherited(source) && onToggleDisabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  touch
                  onClick={onToggleDisabled}
                >
                  Disable for this context
                </Button>
              ) : null}

              {source === "context-override" && onReset ? (
                <Button variant="ghost" size="sm" touch onClick={onReset}>
                  Reset to inherit
                </Button>
              ) : null}
              {source === "context-override" && onToggleDisabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  touch
                  onClick={onToggleDisabled}
                >
                  Disable for this context
                </Button>
              ) : null}

              {source === "disabled" && onToggleDisabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  touch
                  onClick={onToggleDisabled}
                >
                  Re-enable (inherit)
                </Button>
              ) : null}
              {source === "disabled" && onOverride ? (
                <Button variant="ghost" size="sm" touch onClick={onOverride}>
                  Override with custom validator
                </Button>
              ) : null}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
