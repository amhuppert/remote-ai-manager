"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip";

export function SupportIndicator({
  label,
  notes,
  action,
}: {
  label: string;
  notes: readonly string[];
  action?: { label: string; onClick(): void };
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const details = [...new Set(notes.filter(Boolean))];
  if (details.length === 0) return null;

  const accessibleLabel = `Information about ${label}`;
  const content = (
    <div className="grid gap-sm font-mono text-[0.74rem] leading-relaxed text-text-secondary">
      {details.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip open={tooltipOpen && !open} onOpenChange={setTooltipOpen}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <IconButton type="button" aria-label={accessibleLabel}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 11v6M12 7v1" />
                </svg>
              </IconButton>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{content}</TooltipContent>
        </Tooltip>
        <PopoverContent
          aria-label={accessibleLabel}
          layoutClassName="w-[320px] max-w-[calc(100vw-32px)]"
        >
          {content}
          {action ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              layoutClassName="mt-sm"
              onClick={() => {
                setOpen(false);
                action.onClick();
              }}
            >
              {action.label}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
