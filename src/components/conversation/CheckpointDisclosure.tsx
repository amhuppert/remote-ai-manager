"use client";

import { useId, type ReactNode } from "react";

import { ChevronDownIcon } from "@/components/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import { createClientLogger } from "@/lib/logging/client-logger";

const logger = createClientLogger("checkpoint-panel");

export default function CheckpointDisclosure({
  title,
  description,
  icon,
  operationId,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  operationId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}): React.JSX.Element {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <Collapsible
      {...(open === undefined ? {} : { open })}
      onOpenChange={(expanded) => {
        logger.debug("checkpoint_panel.disclosure", {
          operationId,
          section: title,
          expanded,
        });
        onOpenChange?.(expanded);
      }}
    >
      <div className="overflow-hidden rounded-md border border-solid border-border-default bg-bg-base">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            className="group flex min-h-[64px] w-full items-center gap-md border-0 bg-transparent px-lg py-md text-left font-mono text-text-primary transition-colors duration-150 hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]"
          >
            <span
              className="flex shrink-0 text-text-secondary"
              aria-hidden="true"
            >
              {icon}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-xs">
              <span id={labelId} className="text-[0.82rem] font-medium">
                {title}
              </span>
              <span
                id={descriptionId}
                className="text-[0.72rem] leading-[1.5] text-text-secondary"
              >
                {description}
              </span>
            </span>
            <ChevronDownIcon
              size={16}
              className="shrink-0 text-text-secondary transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-x-0 border-t border-b-0 border-solid border-border-subtle p-lg">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
