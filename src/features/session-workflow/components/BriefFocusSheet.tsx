"use client";

import dynamic from "next/dynamic";
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

const MarkdownContent = dynamic(() => import("@/components/MarkdownContent"), {
  ssr: false,
});

// Large centered read view for the execution inspector's long-form Markdown
// brief fields (description, acceptance criteria). The execution page renders
// the resolved brief read-only; edits go through the Config tab's live-edit
// flow.

export interface BriefFocusSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Which field is being viewed, e.g. "Acceptance criteria". */
  fieldLabel: string;
  /** The owning context's title, shown as the sheet heading. */
  contextTitle: string;
  content: string;
}

export default function BriefFocusSheet({
  open,
  onOpenChange,
  fieldLabel,
  contextTitle,
  content,
}: BriefFocusSheetProps): React.JSX.Element {
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
        <div className="wb-markdown-inline mt-md box-border max-h-[60vh] min-h-[200px] overflow-y-auto rounded-md border border-solid border-border-default bg-bg-base px-lg py-md text-[0.82rem] leading-[1.6] text-text-primary">
          <MarkdownContent content={content} />
        </div>
        <footer className="mt-md flex items-center">
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
