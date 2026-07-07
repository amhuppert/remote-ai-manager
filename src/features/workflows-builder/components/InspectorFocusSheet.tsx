"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { CloseIcon } from "@/components/icons";

// Large centered editor for the inspector's long-form Markdown fields
// (description, acceptance criteria). Edits write through `onChange` on every
// keystroke, so the panel's rendered read view updates live; closing the sheet
// (Done, ×, Esc, scrim) just dismisses it.

export interface InspectorFocusSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Which field is being edited, e.g. "Acceptance criteria". */
  fieldLabel: string;
  /** The owning context's title, shown as the sheet heading. */
  contextTitle: string;
  value: string;
  onChange(next: string): void;
  textareaId?: string;
}

export default function InspectorFocusSheet({
  open,
  onOpenChange,
  fieldLabel,
  contextTitle,
  value,
  onChange,
  textareaId,
}: InspectorFocusSheetProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" aria-describedby={undefined}>
        <header className="mb-xs flex items-center gap-[10px]">
          <span className="min-w-0 flex-1 font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            {fieldLabel}
          </span>
          <Badge subtle layoutClassName="shrink-0">
            markdown
          </Badge>
          <DialogClose asChild>
            <IconButton aria-label="Close">
              <CloseIcon />
            </IconButton>
          </DialogClose>
        </header>
        <DialogTitle layoutClassName="min-w-0 truncate">
          {contextTitle}
        </DialogTitle>
        <textarea
          autoFocus
          id={textareaId}
          aria-label={fieldLabel}
          className="box-border h-[46vh] min-h-[320px] w-full resize-none rounded-md border border-solid border-border-default bg-bg-base px-lg py-md font-mono text-[0.85rem] leading-[1.7] text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <footer className="mt-md flex items-center gap-sm">
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            Markdown · rendered live in the panel
          </span>
          <DialogClose asChild>
            <Button variant="primary" layoutClassName="ml-auto">
              Done
            </Button>
          </DialogClose>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
