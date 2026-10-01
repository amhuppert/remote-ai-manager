"use client";

import type { ReactNode } from "react";
import {
  ArrowUpRightIcon,
  CloseIcon,
  DocumentIcon,
  ImageIcon,
} from "@/components/icons";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";
import ReadOnlyDocumentSurface from "@/features/session/document-viewer/ReadOnlyDocumentSurface";
import {
  classifyDocumentContentError,
  useDocumentContentQuery,
} from "@/lib/documents/queries";
import {
  useFilePreviewStore,
  type FilePreview,
} from "@/stores/file-preview.store";

type ImagePreview = Extract<FilePreview, { kind: "image" }>;
type MarkdownPreview = Extract<FilePreview, { kind: "markdown" }>;

const CARD_CLASSES =
  "flex max-h-[calc(100dvh-var(--spacing-2xl))] max-w-[calc(100vw-var(--spacing-lg))] flex-col overflow-hidden rounded-lg border border-solid border-border-default bg-bg-surface outline-none motion-safe:animate-[slideUp_0.2s_ease]";

const CARD_SIZE_CLASSES: Record<FilePreview["kind"], string> = {
  image: "w-max min-w-[min(360px,calc(100vw-var(--spacing-lg)))]",
  markdown: "w-[880px]",
};

const OPEN_IN_TAB_CLASSES =
  "inline-flex flex-none items-center gap-2xs rounded-sm px-xs py-2xs font-mono text-[0.72rem] text-text-secondary no-underline transition-colors duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

function PreviewHeader({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    // The title recipe's bottom margin spaces the bar, so the row aligns to
    // the top rather than centring against that margin.
    <div className="flex flex-none items-start gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle pt-sm pr-sm pb-0 pl-md">
      <span className="mt-sm flex-none text-cyan">{icon}</span>
      <DialogTitle layoutClassName="mt-xs min-w-0 flex-1">
        <span className="block truncate text-[0.95rem]">{title}</span>
      </DialogTitle>
      <div className="flex flex-none items-center gap-xs">
        {children}
        <DialogClose asChild>
          <IconButton variant="square" aria-label="Close preview">
            <CloseIcon />
          </IconButton>
        </DialogClose>
      </div>
    </div>
  );
}

function PreviewFooter({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex-none truncate border-x-0 border-t border-b-0 border-solid border-border-subtle px-md py-xs font-mono text-[0.7rem] text-text-tertiary">
      {children}
    </p>
  );
}

function ImagePreviewBody({
  preview,
}: {
  preview: ImagePreview;
}): React.JSX.Element {
  return (
    <>
      <PreviewHeader icon={<ImageIcon size={16} />} title={preview.fileName}>
        <a
          href={preview.src}
          target="_blank"
          rel="noopener noreferrer"
          className={OPEN_IN_TAB_CLASSES}
        >
          Open in new tab
          <ArrowUpRightIcon size={12} />
        </a>
      </PreviewHeader>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-bg-void p-sm">
        {/* eslint-disable-next-line @next/next/no-img-element -- worktree files have no known dimensions */}
        <img
          src={preview.src}
          alt={preview.alt}
          className="block h-auto max-h-[calc(100dvh-136px)] max-w-full object-contain"
        />
      </div>
      <PreviewFooter>{preview.imagePath}</PreviewFooter>
    </>
  );
}

function MarkdownPreviewBody({
  preview,
}: {
  preview: MarkdownPreview;
}): React.JSX.Element {
  const content = useDocumentContentQuery(
    preview.projectName,
    preview.sessionName,
    preview.docPath,
  );
  return (
    <>
      <PreviewHeader icon={<DocumentIcon size={16} />} title={preview.title}>
        {preview.docPath.startsWith("/") ? (
          <span className="flex-none font-mono text-[0.62rem] tracking-[0.04em] text-amber uppercase">
            External
          </span>
        ) : null}
      </PreviewHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        <ReadOnlyDocumentSurface
          content={content.data?.content ?? null}
          isLoading={content.isLoading}
          contentError={
            content.error ? classifyDocumentContentError(content.error) : null
          }
        />
      </div>
      <PreviewFooter>{preview.docPath}</PreviewFooter>
    </>
  );
}

/**
 * Previews files linked from agent messages: images everywhere, and Markdown
 * on surfaces without the session docs pane. Mounted once at the app root so a
 * preview outlives the surface that opened it.
 */
export default function FilePreviewHost(): React.JSX.Element {
  const preview = useFilePreviewStore((state) => state.preview);
  const returnFocusTo = useFilePreviewStore((state) => state.returnFocusTo);
  const closePreview = useFilePreviewStore((state) => state.closePreview);

  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) closePreview();
      }}
    >
      {preview ? (
        <DialogContent
          unstyled
          aria-describedby={undefined}
          // Radix restores focus only to a DialogTrigger; the opener here is a
          // link or chip in a transcript, which may have unmounted since.
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo?.isConnected) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          contentClassName={cn(CARD_CLASSES, CARD_SIZE_CLASSES[preview.kind])}
        >
          {preview.kind === "image" ? (
            <ImagePreviewBody preview={preview} />
          ) : (
            <MarkdownPreviewBody preview={preview} />
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
